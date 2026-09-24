import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp from 'amqplib';
import type { Channel, Message } from 'amqplib';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuctionEvent, AuctionBidAcceptedEvent, AuctionRoundClosedEvent } from './event-contracts.js';

const EXCHANGE = 'ecilost.events';
const DEAD_LETTER_EXCHANGE = 'ecilost.events.dlx';
const QUEUE = 'engagement.events.v1';
const DEAD_LETTER_QUEUE = 'engagement.events.dlq';
const ROUTING_KEYS = ['auction.bid.accepted.v1', 'auction.round.closed.v1', 'auction.room.access.closed.v1'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvent(value: unknown): AuctionEvent | null {
  if (!isRecord(value)) return null;
  if (typeof value.eventId !== 'string' || typeof value.eventType !== 'string' || typeof value.occurredAt !== 'string') {
    return null;
  }
  if (Number.isNaN(Date.parse(value.occurredAt))) return null;

  if (value.eventType === 'auction.bid.accepted.v1') {
    const valid =
      typeof value.roomId === 'string' &&
      typeof value.roundId === 'string' &&
      typeof value.position === 'number' &&
      typeof value.bidId === 'string' &&
      typeof value.bidderId === 'string' &&
      typeof value.amount === 'string' &&
      (typeof value.previousBidderId === 'string' || value.previousBidderId === null) &&
      (typeof value.previousPrice === 'string' || value.previousPrice === null) &&
      typeof value.currentBidderId === 'string' &&
      typeof value.currentPrice === 'string' &&
      typeof value.endsAt === 'string' &&
      typeof value.sequence === 'string';
    return valid ? (value as unknown as AuctionBidAcceptedEvent) : null;
  }

  if (value.eventType === 'auction.room.access.closed.v1') {
    const valid =
      typeof value.roomId === 'string' &&
      typeof value.userId === 'string' &&
      (value.reason === 'ROOM_FULL' || value.reason === 'ROOM_STARTED');
    return valid ? (value as unknown as AuctionEvent) : null;
  }
  if (value.eventType === 'auction.room.access.closed.v1') {
    const valid =
      typeof value.roomId === 'string' &&
      typeof value.userId === 'string' &&
      (value.reason === 'ROOM_FULL' || value.reason === 'ROOM_STARTED');
    return valid ? (value as unknown as AuctionEvent) : null;
  }

  if (value.eventType === 'auction.round.closed.v1') {
    const valid =
      typeof value.roomId === 'string' &&
      typeof value.roundId === 'string' &&
      typeof value.position === 'number' &&
      typeof value.currentPrice === 'string' &&
      (typeof value.currentBidderId === 'string' || value.currentBidderId === null) &&
      (typeof value.startedAt === 'string' || value.startedAt === null) &&
      (typeof value.endsAt === 'string' || value.endsAt === null) &&
      (typeof value.maximumEndsAt === 'string' || value.maximumEndsAt === null) &&
      Array.isArray(value.entries) &&
      typeof value.closedAt === 'string';
    return valid ? (value as unknown as AuctionRoundClosedEvent) : null;
  }

  return null;
}

@Injectable()
export class AuctionEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuctionEventConsumer.name);
  private connection?: Awaited<ReturnType<typeof amqp.connect>>;
  private channel?: Channel;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    const rabbitmqUrl = this.config.get<string>('RABBITMQ_URL');
    if (!rabbitmqUrl) throw new Error('RABBITMQ_URL must be configured for Engagement.');

    this.connection = await amqp.connect(rabbitmqUrl);
    this.channel = await this.connection.createChannel();
    await this.channel.assertExchange(EXCHANGE, 'topic', { durable: true });
    await this.channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
    await this.channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
    await this.channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, 'engagement.dead');

    await this.channel.assertQueue(QUEUE, {
      durable: true,
      deadLetterExchange: DEAD_LETTER_EXCHANGE,
      deadLetterRoutingKey: 'engagement.dead',
    });
    for (const routingKey of ROUTING_KEYS) {
      await this.channel.bindQueue(QUEUE, EXCHANGE, routingKey);
    }
    await this.channel.prefetch(10);
    await this.channel.consume(QUEUE, (message) => {
      if (message) void this.captureEvent(message);
    });
    this.logger.log('Consuming Auction events into the durable inbox and notification projection.');
  }

  async onModuleDestroy() {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private async captureEvent(message: Message) {
    const event = parseEvent(this.parseBody(message));
    if (!event || (message.properties.messageId && message.properties.messageId !== event.eventId)) {
      this.logger.warn('Rejected malformed or inconsistent Auction event; it was sent to the dead-letter queue.');
      this.channel?.nack(message, false, false);
      return;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.consumedEvent.createMany({
          data: [{
            eventId: event.eventId,
            eventType: event.eventType,
            occurredAt: new Date(event.occurredAt),
            payload: event as unknown as Prisma.InputJsonObject,
          }],
          skipDuplicates: true,
        });

        const stored = await tx.consumedEvent.findUnique({ where: { eventId: event.eventId } });
        if (!stored) throw new Error('Event was not persisted to the inbox.');

        if (stored.processedAt) return;

        const storedEvent = parseEvent(stored.payload);
        if (!storedEvent) throw new Error('Stored event payload is invalid.');

        await this.createNotification(tx, storedEvent);
        await tx.consumedEvent.update({
          where: { eventId: stored.eventId },
          data: { processedAt: new Date(), attempts: { increment: 1 }, lastError: null },
        });
      });
      this.channel?.ack(message);
    } catch (error) {
      this.logger.error('Could not persist or project Auction event; it was sent to the dead-letter queue.');
      this.channel?.nack(message, false, false);
    }
  }

  private async createNotification(tx: Prisma.TransactionClient, event: AuctionEvent) {
    if (event.eventType === 'auction.bid.accepted.v1') {
      if (!event.previousBidderId || event.previousBidderId === event.bidderId) return;

      await tx.notification.create({
        data: {
          id: event.eventId,
          eventId: event.eventId,
          kind: 'OUTBID',
          roomId: event.roomId,
          recipientId: event.previousBidderId,
          payload: {
            bidId: event.bidId,
            roundId: event.roundId,
            position: event.position,
            currentPrice: event.currentPrice,
            endsAt: event.endsAt,
          },
        },
      });
      return;
    }

    if (event.eventType === 'auction.room.access.closed.v1') {
      await tx.notification.create({
        data: {
          id: event.eventId,
          eventId: event.eventId,
          kind: 'ACCESS_CLOSED',
          roomId: event.roomId,
          recipientId: event.userId,
          payload: {
            reason: event.reason,
          },
        },
      });
      return;
    }
    await tx.notification.create({
      data: {
        id: event.eventId,
        eventId: event.eventId,
        kind: 'ROUND_CLOSED',
        roomId: event.roomId,
        recipientId: null,
        payload: {
          roundId: event.roundId,
          position: event.position,
          currentPrice: event.currentPrice,
          currentBidderId: event.currentBidderId,
          closedAt: event.closedAt,
        },
      },
    });
  }

  private parseBody(message: Message): unknown {
    try {
      return JSON.parse(message.content.toString());
    } catch {
      return null;
    }
  }
}
