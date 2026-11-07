import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp from 'amqplib';
import type { Channel, Message } from 'amqplib';
import type { AuctionBidAcceptedEvent, AuctionRoundClosedEvent } from '../events/event-contracts.js';
import { GamificationReadModel } from './read-model.js';

const EXCHANGE = 'ecilost.events';
const DEAD_LETTER_EXCHANGE = 'ecilost.events.dlx';
/**
 * Cola PROPIA, no la de la bandeja: si Mongo esta caido, la gamificacion se atrasa sin frenar
 * los avisos ni el canal en vivo, y lo pendiente espera aqui (es durable) hasta que vuelva.
 */
export const GAMIFICATION_QUEUE = 'engagement.gamification.v1';
const DEAD_LETTER_QUEUE = 'engagement.gamification.dlq';
const ROUTING_KEYS = ['auction.bid.accepted.v1', 'auction.round.closed.v1'] as const;
const RETRY_DELAY_MS = 5_000;

type GamificationEvent = AuctionBidAcceptedEvent | AuctionRoundClosedEvent;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Valida lo minimo que la gamificacion lee de cada evento. */
export function parseGamificationEvent(value: unknown): GamificationEvent | null {
  if (!isRecord(value)) return null;
  if (typeof value.eventId !== 'string' || typeof value.roundId !== 'string' || typeof value.roomId !== 'string') return null;
  if (typeof value.occurredAt !== 'string' || Number.isNaN(Date.parse(value.occurredAt))) return null;

  if (value.eventType === 'auction.bid.accepted.v1') {
    const valid = typeof value.bidderId === 'string' && typeof value.amount === 'string' && typeof value.endsAt === 'string';
    return valid ? (value as unknown as AuctionBidAcceptedEvent) : null;
  }
  if (value.eventType === 'auction.round.closed.v1') {
    const participants = value.participants;
    const validParticipants =
      participants === undefined ||
      (Array.isArray(participants) &&
        participants.every((p) => isRecord(p) && typeof p.bidderId === 'string' && typeof p.bids === 'number' && typeof p.bestAmount === 'string'));
    const valid = typeof value.closedAt === 'string' && !Number.isNaN(Date.parse(value.closedAt)) && validParticipants;
    return valid ? (value as unknown as AuctionRoundClosedEvent) : null;
  }
  return null;
}

/**
 * Alimenta el modelo de lectura con los eventos de auction.
 *
 * Procesa de a UNO (`prefetch(1)`): el cierre de una ronda necesita que sus pujas ya esten
 * aplicadas (para saber si la ganadora fue de ultimo segundo), y RabbitMQ entrega en orden.
 * Un evento mal formado va a la cola de muertos; uno bien formado que no se pudo aplicar
 * (Mongo caido) se reintenta mas tarde: perderlo dejaria el perfil mal para siempre.
 */
@Injectable()
export class GamificationConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GamificationConsumer.name);
  private connection?: Awaited<ReturnType<typeof amqp.connect>>;
  private channel?: Channel;
  private retry?: NodeJS.Timeout;
  private connecting = false;
  private stopped = false;
  /** Pausa antes de devolver a la cola un evento que no se pudo aplicar. */
  retryDelayMs = RETRY_DELAY_MS;

  constructor(
    private readonly config: ConfigService,
    private readonly readModel: GamificationReadModel,
  ) {}

  onModuleInit() {
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url || !this.readModel.enabled) return;
    void this.connect(url);
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  private async connect(url: string): Promise<void> {
    if (this.stopped || this.connecting || this.channel) return;
    this.connecting = true;
    try {
      const connection = await amqp.connect(url);
      this.connection = connection;
      connection.on('error', (error: unknown) => this.logger.warn(`RabbitMQ connection error: ${String(error)}`));
      connection.on('close', () => this.resetAndRetry(url));
      const channel = await connection.createChannel();
      await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
      await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'direct', { durable: true });
      await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
      await channel.bindQueue(DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, 'engagement.gamification.dead');
      await channel.assertQueue(GAMIFICATION_QUEUE, {
        durable: true,
        deadLetterExchange: DEAD_LETTER_EXCHANGE,
        deadLetterRoutingKey: 'engagement.gamification.dead',
      });
      for (const key of ROUTING_KEYS) await channel.bindQueue(GAMIFICATION_QUEUE, EXCHANGE, key);
      await channel.prefetch(1);
      await channel.consume(GAMIFICATION_QUEUE, (message) => {
        if (message) void this.handle(message, channel);
      });
      this.channel = channel;
      this.logger.log(`Consumiendo ${ROUTING_KEYS.join(', ')} hacia el modelo de lectura de gamificacion.`);
    } catch (error) {
      this.logger.warn(`Could not connect to RabbitMQ for gamification; retrying in ${RETRY_DELAY_MS / 1000} s: ${String(error)}`);
      await this.connection?.close().catch(() => undefined);
      this.resetAndRetry(url);
    } finally {
      this.connecting = false;
    }
  }

  private resetAndRetry(url: string) {
    this.channel = undefined;
    this.connection = undefined;
    if (this.stopped) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(url), RETRY_DELAY_MS);
  }

  async handle(message: Message, channel: Pick<Channel, 'ack' | 'nack'> | undefined = this.channel): Promise<void> {
    let body: unknown = null;
    try {
      body = JSON.parse(message.content.toString());
    } catch {
      body = null;
    }
    const event = parseGamificationEvent(body);
    if (!event) {
      this.logger.warn('Evento invalido para la gamificacion: va a la cola de muertos.');
      channel?.nack(message, false, false);
      return;
    }
    try {
      if (event.eventType === 'auction.bid.accepted.v1') await this.readModel.recordBid(event);
      else await this.readModel.recordRoundClosed(event);
      channel?.ack(message);
    } catch (error) {
      // Se devuelve a la cola tras una pausa: con prefetch 1 nada se adelanta mientras tanto.
      this.logger.warn(`No se pudo aplicar ${event.eventId} a la gamificacion; se reintenta: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      channel?.nack(message, false, true);
    }
  }
}
