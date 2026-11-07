var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var ChatGateway_1;
import { randomUUID } from 'node:crypto';
import { Logger, Optional } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAX_ROOMS_PER_CONNECTION } from '../realtime/realtime.gateway.js';
import { RoomAccessVerifier } from '../realtime/room-access.js';
import { TokenVerifier } from '../realtime/token-verifier.js';
import { GamificationReadModel } from '../gamification/read-model.js';
import { chatAlias, normalizeMessage, SendLimiter } from './chat-rules.js';
const CHAT_PREFIX = 'chat:';
const chatChannel = (roomId) => `${CHAT_PREFIX}${roomId}`;
/** Los roomId de auction son UUID: cualquier otro texto no es una sala. */
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mensajes que trae el historial al entrar o reconectar: los mas recientes. */
export const CHAT_HISTORY_SIZE = 50;
/**
 * Cuanto vale lo que auction dijo de la sala al enviar. Un mensaje por segundo por persona
 * no justifica una consulta a auction por mensaje; cinco segundos es lo mas que alguien
 * podria seguir escribiendo despues de que la sala cerro.
 */
export const ROOM_STATUS_TTL_MS = 5_000;
/** Cuanto se reutilizan las medallas de alguien antes de volver a leerlas. */
export const BADGES_TTL_MS = 60_000;
/**
 * Chat de la sala en curso, en el mismo namespace `/realtime` y la misma conexion que el
 * canal de la sala (el middleware de `RealtimeGateway` ya autentico a quien se conecta).
 *
 * - Escriben solo los participantes: quienes auction admitio antes del inicio. Auction cierra
 *   la admision cuando la sala arranca, asi que quien llego tarde nunca es participante.
 * - El funcionario dueño de la sala lee el chat, pero no escribe.
 * - Quien sigue la sala desde afuera (modo seguimiento) no recibe el chat: el canal `chat:`
 *   es distinto de `room:`.
 * - Se escribe solo con la sala `ACTIVE`. Cerrada, el historial queda en solo lectura.
 *
 * El cliente emite `chat.join` con `{ roomId, token }` y recibe en la respuesta el historial,
 * su alias y si puede escribir. Despues emite `chat.send` con `{ roomId, text, token }` y toda
 * la sala recibe `chat.message`. Al reconectar vuelve a emitir `chat.join` y descarta por `id`
 * los mensajes que ya tenia.
 */
let ChatGateway = ChatGateway_1 = class ChatGateway {
    tokens;
    rooms;
    prisma;
    gamification;
    logger = new Logger(ChatGateway_1.name);
    /** Reloj de los limites; las pruebas lo reemplazan. No va al constructor: Nest lo inyectaria. */
    now = Date.now;
    limiter = new SendLimiter(() => this.now());
    lookups = new Map();
    badgeCache = new Map();
    server;
    constructor(tokens, rooms, prisma, gamification) {
        this.tokens = tokens;
        this.rooms = rooms;
        this.prisma = prisma;
        this.gamification = gamification;
    }
    async joinChat(client, body) {
        const roomId = body?.roomId;
        if (typeof roomId !== 'string' || !ROOM_ID.test(roomId))
            return { ok: false, reason: 'invalid-room' };
        const token = typeof body.token === 'string' && body.token ? body.token : client.handshake.auth?.token;
        const userId = await this.tokens.verify(token);
        const data = client.data;
        if (!userId || userId !== data.userId)
            return { ok: false, reason: 'unauthorized' };
        const listening = [...client.rooms].filter((channel) => channel.startsWith(CHAT_PREFIX)).length;
        if (!client.rooms.has(chatChannel(roomId)) && listening >= MAX_ROOMS_PER_CONNECTION) {
            return { ok: false, reason: 'too-many-rooms' };
        }
        const lookup = await this.lookup(roomId, userId, token, true);
        if (lookup.access !== 'granted')
            return { ok: false, reason: lookup.access };
        const { room } = lookup;
        if (!room.isParticipant && !room.isOwner)
            return { ok: false, reason: 'not-participant' };
        if (room.status !== 'ACTIVE' && room.status !== 'CLOSED')
            return { ok: false, reason: 'not-open' };
        let messages;
        try {
            messages = await this.history(roomId);
        }
        catch (error) {
            this.logger.warn(`No se pudo leer el historial del chat ${roomId}: ${String(error)}`);
            return { ok: false, reason: 'unavailable' };
        }
        await client.join(chatChannel(roomId));
        data.chats = { ...data.chats, [roomId]: { canWrite: room.isParticipant } };
        return {
            ok: true,
            roomId,
            alias: room.isParticipant ? chatAlias(roomId, userId) : null,
            canWrite: room.isParticipant && room.status === 'ACTIVE',
            messages,
        };
    }
    async leaveChat(client, body) {
        if (typeof body?.roomId === 'string') {
            await client.leave(chatChannel(body.roomId));
            const data = client.data;
            if (data.chats)
                delete data.chats[body.roomId];
        }
        return { ok: true };
    }
    async sendMessage(client, body) {
        const roomId = body?.roomId;
        if (typeof roomId !== 'string' || !ROOM_ID.test(roomId))
            return { ok: false, reason: 'invalid-room' };
        const data = client.data;
        const membership = data.chats?.[roomId];
        if (!membership || !client.rooms.has(chatChannel(roomId)))
            return { ok: false, reason: 'not-joined' };
        if (!membership.canWrite)
            return { ok: false, reason: 'read-only' };
        const message = normalizeMessage(body.text);
        if (message.ok === false)
            return { ok: false, reason: message.reason };
        const token = typeof body.token === 'string' && body.token ? body.token : client.handshake.auth?.token;
        const userId = await this.tokens.verify(token);
        if (!userId || userId !== data.userId)
            return { ok: false, reason: 'unauthorized' };
        if (!this.limiter.tryConsume(roomId, userId))
            return { ok: false, reason: 'too-fast' };
        const lookup = await this.lookup(roomId, userId, token, false);
        if (lookup.access !== 'granted')
            return { ok: false, reason: lookup.access };
        if (!lookup.room.isParticipant)
            return { ok: false, reason: 'read-only' };
        if (lookup.room.status !== 'ACTIVE')
            return { ok: false, reason: 'closed' };
        let saved;
        try {
            saved = await this.prisma.chatMessage.create({
                data: { id: randomUUID(), roomId, authorId: userId, body: message.body },
                select: { id: true, roomId: true, body: true, createdAt: true },
            });
        }
        catch (error) {
            this.logger.warn(`No se pudo guardar un mensaje del chat ${roomId}: ${String(error)}`);
            return { ok: false, reason: 'unavailable' };
        }
        const view = {
            id: saved.id,
            roomId: saved.roomId,
            alias: chatAlias(roomId, userId),
            body: saved.body,
            createdAt: saved.createdAt.toISOString(),
            ...this.withBadges((await this.badges([userId]))[userId]),
        };
        this.server?.to(chatChannel(roomId)).emit('chat.message', { ...view, serverTime: new Date(this.now()).toISOString() });
        return { ok: true, message: view };
    }
    async history(roomId) {
        const rows = await this.prisma.chatMessage.findMany({
            where: { roomId },
            orderBy: { createdAt: 'desc' },
            take: CHAT_HISTORY_SIZE,
            select: { id: true, roomId: true, authorId: true, body: true, createdAt: true },
        });
        const badges = await this.badges(rows.map((row) => row.authorId));
        return rows.reverse().map((row) => ({
            id: row.id,
            roomId: row.roomId,
            alias: chatAlias(row.roomId, row.authorId),
            body: row.body,
            createdAt: row.createdAt.toISOString(),
            ...this.withBadges(badges[row.authorId]),
        }));
    }
    withBadges(badges) {
        return badges && badges.length > 0 ? { badges } : {};
    }
    /**
     * Medallas de los autores, con una cache corta: un mensaje no espera a Mongo si ya se
     * leyeron hace poco, y si Mongo falla el chat sigue sin medallas en vez de fallar.
     */
    async badges(userIds) {
        if (!this.gamification?.enabled)
            return {};
        const now = this.now();
        const result = {};
        const missing = [];
        for (const userId of new Set(userIds)) {
            const cached = this.badgeCache.get(userId);
            if (cached && now - cached.at < BADGES_TTL_MS)
                result[userId] = cached.badges;
            else
                missing.push(userId);
        }
        if (missing.length === 0)
            return result;
        try {
            const fresh = await this.gamification.badgesFor(missing);
            for (const userId of missing) {
                const badges = fresh[userId] ?? [];
                this.badgeCache.set(userId, { at: now, badges });
                result[userId] = badges;
            }
        }
        catch (error) {
            this.logger.warn(`No se pudieron leer las medallas del chat: ${String(error)}`);
        }
        return result;
    }
    /**
     * Pregunta a auction por la sala con el token de quien escribe. Al entrar siempre se
     * pregunta; al enviar se reusa la respuesta de los ultimos `ROOM_STATUS_TTL_MS`. Solo se
     * guardan las respuestas concedidas: un fallo de auction no deja a nadie bloqueado.
     */
    async lookup(roomId, userId, token, fresh) {
        const key = `${roomId}:${userId}`;
        const now = this.now();
        const cached = this.lookups.get(key);
        if (!fresh && cached && now - cached.at < ROOM_STATUS_TTL_MS)
            return cached.result;
        const result = await this.rooms.lookup(roomId, token);
        if (result.access === 'granted') {
            if (this.lookups.size >= 1_000) {
                for (const [stale, entry] of this.lookups)
                    if (now - entry.at >= ROOM_STATUS_TTL_MS)
                        this.lookups.delete(stale);
            }
            this.lookups.set(key, { at: now, result });
        }
        else {
            this.lookups.delete(key);
        }
        return result;
    }
};
__decorate([
    WebSocketServer(),
    __metadata("design:type", Function)
], ChatGateway.prototype, "server", void 0);
__decorate([
    SubscribeMessage('chat.join'),
    __param(0, ConnectedSocket()),
    __param(1, MessageBody()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ChatGateway.prototype, "joinChat", null);
__decorate([
    SubscribeMessage('chat.leave'),
    __param(0, ConnectedSocket()),
    __param(1, MessageBody()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ChatGateway.prototype, "leaveChat", null);
__decorate([
    SubscribeMessage('chat.send'),
    __param(0, ConnectedSocket()),
    __param(1, MessageBody()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Function, Object]),
    __metadata("design:returntype", Promise)
], ChatGateway.prototype, "sendMessage", null);
ChatGateway = ChatGateway_1 = __decorate([
    WebSocketGateway({ namespace: '/realtime', cors: { origin: true } }),
    __param(3, Optional()),
    __metadata("design:paramtypes", [TokenVerifier,
        RoomAccessVerifier,
        PrismaService,
        GamificationReadModel])
], ChatGateway);
export { ChatGateway };
//# sourceMappingURL=chat.gateway.js.map