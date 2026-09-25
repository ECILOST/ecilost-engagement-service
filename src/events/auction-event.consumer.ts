import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp from 'amqplib';
import type { Channel, Message } from 'amqplib';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeGateway } from '../realtime/realtime.gateway.js';
import type {
  AuctionEvent,
  AuctionBidAcceptedEvent,
  AuctionRoundActivatedEvent,
  AuctionRoundClosedEvent,
} from './event-contracts.js';

const EXCHANGE = 'ecilost.events';
const DEAD_LETTER_EXCHANGE = 'ecilost.events.dlx';
const QUEUE = 'engagement.events.v1';
const DEAD_LETTER_QUEUE = 'engagement.events.dlq';
/** Cuantos `eventId` recientes se recuerdan para no reemitir una reentrega. */
const RECENT_EVENTS_WINDOW = 5_000;
const ROUTING_KEYS = ['auction.bid.accepted.v1', 'auction.round.activated.v1', 'auction.round.closed.v1'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvent(value: unknown): AuctionEvent | null {
  if (!isRecord(value)) return null;
  if (typeof value.eventId !== 'string' || typeof value.eventType !== 'string' || typeof value.occurredAt !== 'string') {
    return null;
  }
  if (Number.isNaN(Date.parse(value.occurredAt))) return null;
  if (typeof value.roomId !== 'string' || typeof value.roundId !== 'string' || typeof value.position !== 'number') {
    return null;
  }

  if (value.eventType === 'auction.bid.accepted.v1') {
    const valid =
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

  if (value.eventType === 'auction.round.activated.v1') {
    const valid =
      typeof value.currentPrice === 'string' &&
      typeof value.startedAt === 'string' &&
      typeof value.endsAt === 'string' &&
      Array.isArray(value.entries);
    return valid ? (value as unknown as AuctionRoundActivatedEvent) : null;
  }

  if (value.eventType === 'auction.round.closed.v1') {
    const valid =
      typeof value.currentPrice === 'string' &&
      (typeof value.currentBidderId === 'string' || value.currentBidderId === null) &&
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
  private readonly recent = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
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
    this.logger.log('Consuming Auction events into the durable inbox, notifications and realtime channel.');
  }

  async onModuleDestroy() {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  /**
   * Empuja primero y persiste despues.
   *
   * La difusion no espera a la base: el precio llega a la sala en cuanto llega el evento, y
   * una escritura lenta no frena a los clientes. El orden se conserva porque todo lo que va
   * antes del primer `await` es sincrono: RabbitMQ entrega en orden y cada evento se emite
   * antes de que empiece a persistirse el siguiente, aunque las escrituras corran a la vez.
   *
   * No hay transaccion: cada escritura es idempotente por su llave (`eventId` en el inbox,
   * `eventId + kind` en las notificaciones), asi que una reentrega no duplica nada. Los
   * repetidos se filtran para no emitirlos dos veces con una ventana en memoria; tras un
   * reinicio podria reemitirse alguno, y el cliente los descarta por `eventId` y `sequence`.
   */
  private async captureEvent(message: Message) {
    const event = parseEvent(this.parseBody(message));
    if (!event || (message.properties.messageId && message.properties.messageId !== event.eventId)) {
      this.logger.warn('Rejected malformed or inconsistent Auction event; it was sent to the dead-letter queue.');
      this.channel?.nack(message, false, false);
      return;
    }

    if (this.remember(event.eventId)) this.realtime.publish(event);

    try {
      await this.persist(event);
      this.channel?.ack(message);
    } catch (error) {
      this.logger.error(`Could not persist Auction event ${event.eventId}; it was sent to the dead-letter queue: ${String(error)}`);
      this.channel?.nack(message, false, false);
    }
  }

  /** Cierto la primera vez que se ve un `eventId` dentro de la ventana reciente. */
  private remember(eventId: string): boolean {
    if (this.recent.has(eventId)) return false;
    this.recent.add(eventId);
    // Un Set recuerda el orden de insercion: el primero es el mas viejo.
    if (this.recent.size > RECENT_EVENTS_WINDOW) this.recent.delete(this.recent.values().next().value as string);
    return true;
  }

  private async persist(event: AuctionEvent) {
    await this.prisma.consumedEvent.createMany({
      data: [{
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: new Date(event.occurredAt),
        payload: event as unknown as Prisma.InputJsonObject,
      }],
      skipDuplicates: true,
    });

    const notifications = notificationsFor(event);
    if (notifications.length) {
      await this.prisma.notification.createMany({ data: notifications, skipDuplicates: true });
    }

    await this.prisma.consumedEvent.update({
      where: { eventId: event.eventId },
      data: { processedAt: new Date(), attempts: { increment: 1 }, lastError: null },
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

/**
 * Lo que un evento deja en la bandeja de cada persona (HU-27, HU-29):
 * - superado: al participante que dejo de liderar;
 * - cierre de ronda: a toda la sala, y aparte al ganador.
 */
export function notificationsFor(event: AuctionEvent): Prisma.NotificationCreateManyInput[] {
  const base = { eventId: event.eventId, roomId: event.roomId };

  if (event.eventType === 'auction.bid.accepted.v1') {
    if (!event.previousBidderId || event.previousBidderId === event.bidderId) return [];
    return [{
      ...base,
      id: `${event.eventId}:OUTBID`,
      kind: 'OUTBID',
      recipientId: event.previousBidderId,
      payload: { bidId: event.bidId, roundId: event.roundId, position: event.position, currentPrice: event.currentPrice, endsAt: event.endsAt },
    }];
  }

  if (event.eventType === 'auction.round.closed.v1') {
    const winnerId = event.winnerId !== undefined ? event.winnerId : event.currentBidderId;
    const result = event.result ?? (winnerId ? 'AWARDED' : 'DESERTED');
    const payload = { roundId: event.roundId, position: event.position, currentPrice: event.currentPrice, result, closedAt: event.closedAt };
    const closed: Prisma.NotificationCreateManyInput = { ...base, id: `${event.eventId}:ROUND_CLOSED`, kind: 'ROUND_CLOSED', recipientId: null, payload };
    if (result !== 'AWARDED' || !winnerId) return [closed];
    return [closed, { ...base, id: `${event.eventId}:ROUND_WON`, kind: 'ROUND_WON', recipientId: winnerId, payload }];
  }

  return [];
}
