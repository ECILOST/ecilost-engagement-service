var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var GamificationConsumer_1;
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp from 'amqplib';
import { GamificationReadModel } from './read-model.js';
const EXCHANGE = 'ecilost.events';
const DEAD_LETTER_EXCHANGE = 'ecilost.events.dlx';
/**
 * Cola PROPIA, no la de la bandeja: si Mongo esta caido, la gamificacion se atrasa sin frenar
 * los avisos ni el canal en vivo, y lo pendiente espera aqui (es durable) hasta que vuelva.
 */
export const GAMIFICATION_QUEUE = 'engagement.gamification.v1';
const DEAD_LETTER_QUEUE = 'engagement.gamification.dlq';
const ROUTING_KEYS = ['auction.bid.accepted.v1', 'auction.round.closed.v1'];
const RETRY_DELAY_MS = 5_000;
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Valida lo minimo que la gamificacion lee de cada evento. */
export function parseGamificationEvent(value) {
    if (!isRecord(value))
        return null;
    if (typeof value.eventId !== 'string' || typeof value.roundId !== 'string' || typeof value.roomId !== 'string')
        return null;
    if (typeof value.occurredAt !== 'string' || Number.isNaN(Date.parse(value.occurredAt)))
        return null;
    if (value.eventType === 'auction.bid.accepted.v1') {
        const valid = typeof value.bidderId === 'string' && typeof value.amount === 'string' && typeof value.endsAt === 'string';
        return valid ? value : null;
    }
    if (value.eventType === 'auction.round.closed.v1') {
        const participants = value.participants;
        const validParticipants = participants === undefined ||
            (Array.isArray(participants) &&
                participants.every((p) => isRecord(p) && typeof p.bidderId === 'string' && typeof p.bids === 'number' && typeof p.bestAmount === 'string'));
        const valid = typeof value.closedAt === 'string' && !Number.isNaN(Date.parse(value.closedAt)) && validParticipants;
        return valid ? value : null;
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
let GamificationConsumer = GamificationConsumer_1 = class GamificationConsumer {
    config;
    readModel;
    logger = new Logger(GamificationConsumer_1.name);
    connection;
    channel;
    retry;
    connecting = false;
    stopped = false;
    /** Pausa antes de devolver a la cola un evento que no se pudo aplicar. */
    retryDelayMs = RETRY_DELAY_MS;
    constructor(config, readModel) {
        this.config = config;
        this.readModel = readModel;
    }
    onModuleInit() {
        const url = this.config.get('RABBITMQ_URL');
        if (!url || !this.readModel.enabled)
            return;
        void this.connect(url);
    }
    async onModuleDestroy() {
        this.stopped = true;
        if (this.retry)
            clearTimeout(this.retry);
        await this.channel?.close().catch(() => undefined);
        await this.connection?.close().catch(() => undefined);
    }
    async connect(url) {
        if (this.stopped || this.connecting || this.channel)
            return;
        this.connecting = true;
        try {
            const connection = await amqp.connect(url);
            this.connection = connection;
            connection.on('error', (error) => this.logger.warn(`RabbitMQ connection error: ${String(error)}`));
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
            for (const key of ROUTING_KEYS)
                await channel.bindQueue(GAMIFICATION_QUEUE, EXCHANGE, key);
            await channel.prefetch(1);
            await channel.consume(GAMIFICATION_QUEUE, (message) => {
                if (message)
                    void this.handle(message, channel);
            });
            this.channel = channel;
            this.logger.log(`Consumiendo ${ROUTING_KEYS.join(', ')} hacia el modelo de lectura de gamificacion.`);
        }
        catch (error) {
            this.logger.warn(`Could not connect to RabbitMQ for gamification; retrying in ${RETRY_DELAY_MS / 1000} s: ${String(error)}`);
            await this.connection?.close().catch(() => undefined);
            this.resetAndRetry(url);
        }
        finally {
            this.connecting = false;
        }
    }
    resetAndRetry(url) {
        this.channel = undefined;
        this.connection = undefined;
        if (this.stopped)
            return;
        if (this.retry)
            clearTimeout(this.retry);
        this.retry = setTimeout(() => void this.connect(url), RETRY_DELAY_MS);
    }
    async handle(message, channel = this.channel) {
        let body = null;
        try {
            body = JSON.parse(message.content.toString());
        }
        catch {
            body = null;
        }
        const event = parseGamificationEvent(body);
        if (!event) {
            this.logger.warn('Evento invalido para la gamificacion: va a la cola de muertos.');
            channel?.nack(message, false, false);
            return;
        }
        try {
            if (event.eventType === 'auction.bid.accepted.v1')
                await this.readModel.recordBid(event);
            else
                await this.readModel.recordRoundClosed(event);
            channel?.ack(message);
        }
        catch (error) {
            // Se devuelve a la cola tras una pausa: con prefetch 1 nada se adelanta mientras tanto.
            this.logger.warn(`No se pudo aplicar ${event.eventId} a la gamificacion; se reintenta: ${String(error)}`);
            await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
            channel?.nack(message, false, true);
        }
    }
};
GamificationConsumer = GamificationConsumer_1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [ConfigService,
        GamificationReadModel])
], GamificationConsumer);
export { GamificationConsumer };
//# sourceMappingURL=gamification.consumer.js.map