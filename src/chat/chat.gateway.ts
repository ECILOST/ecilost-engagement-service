import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAX_ROOMS_PER_CONNECTION } from '../realtime/realtime.gateway.js';
import { RoomAccessVerifier, type RoomLookup } from '../realtime/room-access.js';
import { TokenVerifier } from '../realtime/token-verifier.js';
import { chatAlias, normalizeMessage, SendLimiter } from './chat-rules.js';

const CHAT_PREFIX = 'chat:';
const chatChannel = (roomId: string) => `${CHAT_PREFIX}${roomId}`;

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

export interface ChatMessageView {
  id: string;
  roomId: string;
  alias: string;
  body: string;
  createdAt: string;
}

/** Lo que la conexion recuerda de cada chat en el que entro. */
interface ChatMembership {
  canWrite: boolean;
}

type ChatData = { userId?: string; chats?: Record<string, ChatMembership> };

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
@WebSocketGateway({ namespace: '/realtime', cors: { origin: true } })
export class ChatGateway {
  private readonly logger = new Logger(ChatGateway.name);
  /** Reloj de los limites; las pruebas lo reemplazan. No va al constructor: Nest lo inyectaria. */
  now: () => number = Date.now;
  private readonly limiter = new SendLimiter(() => this.now());
  private readonly lookups = new Map<string, { at: number; result: RoomLookup }>();

  @WebSocketServer() private server: Namespace;

  constructor(
    private readonly tokens: TokenVerifier,
    private readonly rooms: RoomAccessVerifier,
    private readonly prisma: PrismaService,
  ) {}

  @SubscribeMessage('chat.join')
  async joinChat(@ConnectedSocket() client: Socket, @MessageBody() body: { roomId?: unknown; token?: unknown }) {
    const roomId = body?.roomId;
    if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) return { ok: false, reason: 'invalid-room' };

    const token = typeof body.token === 'string' && body.token ? body.token : client.handshake.auth?.token;
    const userId = await this.tokens.verify(token);
    const data = client.data as ChatData;
    if (!userId || userId !== data.userId) return { ok: false, reason: 'unauthorized' };

    const listening = [...client.rooms].filter((channel) => channel.startsWith(CHAT_PREFIX)).length;
    if (!client.rooms.has(chatChannel(roomId)) && listening >= MAX_ROOMS_PER_CONNECTION) {
      return { ok: false, reason: 'too-many-rooms' };
    }

    const lookup = await this.lookup(roomId, userId, token as string, true);
    if (lookup.access !== 'granted') return { ok: false, reason: lookup.access };
    const { room } = lookup;
    if (!room.isParticipant && !room.isOwner) return { ok: false, reason: 'not-participant' };
    if (room.status !== 'ACTIVE' && room.status !== 'CLOSED') return { ok: false, reason: 'not-open' };

    let messages: ChatMessageView[];
    try {
      messages = await this.history(roomId);
    } catch (error) {
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

  @SubscribeMessage('chat.leave')
  async leaveChat(@ConnectedSocket() client: Socket, @MessageBody() body: { roomId?: unknown }) {
    if (typeof body?.roomId === 'string') {
      await client.leave(chatChannel(body.roomId));
      const data = client.data as ChatData;
      if (data.chats) delete data.chats[body.roomId];
    }
    return { ok: true };
  }

  @SubscribeMessage('chat.send')
  async sendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId?: unknown; text?: unknown; token?: unknown },
  ) {
    const roomId = body?.roomId;
    if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) return { ok: false, reason: 'invalid-room' };

    const data = client.data as ChatData;
    const membership = data.chats?.[roomId];
    if (!membership || !client.rooms.has(chatChannel(roomId))) return { ok: false, reason: 'not-joined' };
    if (!membership.canWrite) return { ok: false, reason: 'read-only' };

    const message = normalizeMessage(body.text);
    if (message.ok === false) return { ok: false, reason: message.reason };

    const token = typeof body.token === 'string' && body.token ? body.token : client.handshake.auth?.token;
    const userId = await this.tokens.verify(token);
    if (!userId || userId !== data.userId) return { ok: false, reason: 'unauthorized' };

    if (!this.limiter.tryConsume(roomId, userId)) return { ok: false, reason: 'too-fast' };

    const lookup = await this.lookup(roomId, userId, token as string, false);
    if (lookup.access !== 'granted') return { ok: false, reason: lookup.access };
    if (!lookup.room.isParticipant) return { ok: false, reason: 'read-only' };
    if (lookup.room.status !== 'ACTIVE') return { ok: false, reason: 'closed' };

    let saved: { id: string; roomId: string; body: string; createdAt: Date };
    try {
      saved = await this.prisma.chatMessage.create({
        data: { id: randomUUID(), roomId, authorId: userId, body: message.body },
        select: { id: true, roomId: true, body: true, createdAt: true },
      });
    } catch (error) {
      this.logger.warn(`No se pudo guardar un mensaje del chat ${roomId}: ${String(error)}`);
      return { ok: false, reason: 'unavailable' };
    }

    const view: ChatMessageView = {
      id: saved.id,
      roomId: saved.roomId,
      alias: chatAlias(roomId, userId),
      body: saved.body,
      createdAt: saved.createdAt.toISOString(),
    };
    this.server?.to(chatChannel(roomId)).emit('chat.message', { ...view, serverTime: new Date(this.now()).toISOString() });
    return { ok: true, message: view };
  }

  private async history(roomId: string): Promise<ChatMessageView[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      take: CHAT_HISTORY_SIZE,
      select: { id: true, roomId: true, authorId: true, body: true, createdAt: true },
    });
    return rows.reverse().map((row) => ({
      id: row.id,
      roomId: row.roomId,
      alias: chatAlias(row.roomId, row.authorId),
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Pregunta a auction por la sala con el token de quien escribe. Al entrar siempre se
   * pregunta; al enviar se reusa la respuesta de los ultimos `ROOM_STATUS_TTL_MS`. Solo se
   * guardan las respuestas concedidas: un fallo de auction no deja a nadie bloqueado.
   */
  private async lookup(roomId: string, userId: string, token: string, fresh: boolean): Promise<RoomLookup> {
    const key = `${roomId}:${userId}`;
    const now = this.now();
    const cached = this.lookups.get(key);
    if (!fresh && cached && now - cached.at < ROOM_STATUS_TTL_MS) return cached.result;

    const result = await this.rooms.lookup(roomId, token);
    if (result.access === 'granted') {
      if (this.lookups.size >= 1_000) {
        for (const [stale, entry] of this.lookups) if (now - entry.at >= ROOM_STATUS_TTL_MS) this.lookups.delete(stale);
      }
      this.lookups.set(key, { at: now, result });
    } else {
      this.lookups.delete(key);
    }
    return result;
  }
}
