import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import type { AuctionEvent, RoomStatus } from '../events/event-contracts.js';
import { RoomAccessVerifier } from './room-access.js';
import { TokenVerifier } from './token-verifier.js';

const ROOM_PREFIX = 'room:';
const roomChannel = (roomId: string) => `${ROOM_PREFIX}${roomId}`;
const userChannel = (userId: string) => `user:${userId}`;

/** Los roomId de auction son UUID: cualquier otro texto no es una sala. */
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Salas que una conexion escucha a la vez. Una pantalla escucha una sola; el margen cubre
 * pestañas que comparten conexion y la transicion entre pantallas.
 */
export const MAX_ROOMS_PER_CONNECTION = 5;

/**
 * Canal de tiempo real de la sala. El cliente se conecta con
 * `io('/realtime', { auth: { token } })`, emite `room.join` con `{ roomId, token }` (ver
 * `joinRoom`: auction confirma la sala) y recibe:
 * - `round.price`: nuevo precio y `endsAt` tras una puja aceptada (a toda la sala). Trae
 *   `automatic` si la hizo el motor de puja automatica (HU-22).
 * - `round.extended`: la puja cayo en el ultimo minuto y movio el cierre (HU-23).
 * - `round.activated` / `round.closed`: transicion de ronda (a toda la sala).
 * - `room.status`: la sala empezo (`ACTIVE`) o termino (`CLOSED`) (HU-18).
 * - `bid.outbid`: aviso personal al participante superado.
 * - `round.won`: aviso personal al ganador cuando la ronda se adjudica.
 * Cada mensaje trae `eventId` (para descartar repetidos) y `serverTime`, con el que
 * el cliente calcula el contador sin depender de su reloj local. Al reconectar, el
 * cliente vuelve a consultar `GET /rooms/:roomId/state` en Auction.
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: true } })
export class RealtimeGateway implements OnGatewayInit {
  @WebSocketServer() private server: Namespace;

  constructor(private readonly tokens: TokenVerifier, private readonly rooms: RoomAccessVerifier) {}

  afterInit(server: Namespace) {
    // El middleware autentica antes de aceptar la conexion.
    server.use(async (socket, next) => {
      const userId = await this.tokens.verify(socket.handshake.auth?.token);
      if (!userId) return next(new Error('El token de acceso no es valido.'));
      socket.data.userId = userId;
      await socket.join(userChannel(userId));
      next();
    });
  }

  /**
   * Entrar al canal de una sala. Antes se aceptaba cualquier texto, sin limite y sin
   * comprobar nada: cualquier sesion podia abrir canales arbitrarios. Ahora:
   *
   * - el roomId debe tener forma de UUID;
   * - el token debe seguir vigente y ser de quien abrio la conexion. El cliente manda el
   *   actual en cada `room.join`, porque el del handshake vence a los quince minutos y la
   *   conexion puede durar mas;
   * - auction debe confirmar que la sala existe y que esa persona puede verla (ver
   *   `RoomAccessVerifier`; no exige estar inscrito, para no romper el modo seguimiento);
   * - una conexion escucha a lo sumo `MAX_ROOMS_PER_CONNECTION` salas.
   *
   * Si algo falla responde `{ ok: false, reason }` y el cliente sigue con su sondeo lento.
   */
  @SubscribeMessage('room.join')
  async joinRoom(@ConnectedSocket() client: Socket, @MessageBody() body: { roomId?: unknown; token?: unknown }) {
    const roomId = body?.roomId;
    if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) return { ok: false, reason: 'invalid-room' };
    if (client.rooms.has(roomChannel(roomId))) return { ok: true, roomId };

    const token = typeof body.token === 'string' && body.token ? body.token : client.handshake.auth?.token;
    const userId = await this.tokens.verify(token);
    if (!userId || userId !== client.data.userId) return { ok: false, reason: 'unauthorized' };

    const watching = [...client.rooms].filter((channel) => channel.startsWith(ROOM_PREFIX)).length;
    if (watching >= MAX_ROOMS_PER_CONNECTION) return { ok: false, reason: 'too-many-rooms' };

    const access = await this.rooms.check(roomId, token as string);
    if (access !== 'granted') return { ok: false, reason: access };

    await client.join(roomChannel(roomId));
    return { ok: true, roomId };
  }

  @SubscribeMessage('room.leave')
  async leaveRoom(@ConnectedSocket() client: Socket, @MessageBody() body: { roomId?: unknown }) {
    if (typeof body?.roomId === 'string') await client.leave(roomChannel(body.roomId));
    return { ok: true };
  }

  publish(event: AuctionEvent) {
    if (!this.server) return;
    const serverTime = new Date().toISOString();
    const room = this.server.to(roomChannel(event.roomId));

    if (event.eventType === 'auction.bid.accepted.v1') {
      room.emit('round.price', {
        eventId: event.eventId,
        roomId: event.roomId,
        roundId: event.roundId,
        position: event.position,
        currentPrice: event.currentPrice,
        currentBidderId: event.currentBidderId,
        endsAt: event.endsAt,
        sequence: event.sequence,
        automatic: event.automatic ?? false,
        extended: event.extended ?? false,
        serverTime,
      });
      if (event.extended) {
        room.emit('round.extended', {
          eventId: event.eventId,
          roomId: event.roomId,
          roundId: event.roundId,
          position: event.position,
          previousEndsAt: event.previousEndsAt ?? null,
          endsAt: event.endsAt,
          sequence: event.sequence,
          serverTime,
        });
      }
      if (event.previousBidderId && event.previousBidderId !== event.bidderId) {
        this.server.to(userChannel(event.previousBidderId)).emit('bid.outbid', {
          eventId: event.eventId,
          roomId: event.roomId,
          roundId: event.roundId,
          position: event.position,
          currentPrice: event.currentPrice,
          endsAt: event.endsAt,
          serverTime,
        });
      }
      return;
    }

    if (event.eventType === 'auction.round.activated.v1') {
      room.emit('round.activated', {
        eventId: event.eventId,
        roomId: event.roomId,
        roundId: event.roundId,
        position: event.position,
        currentPrice: event.currentPrice,
        startedAt: event.startedAt,
        endsAt: event.endsAt,
        entries: event.entries,
        roomStatus: event.roomStatus ?? 'ACTIVE',
        serverTime,
      });
      // La primera ronda abre la sala: es el inicio automatico de HU-18.
      if (event.position === 1) this.emitRoomStatus(event.eventId, event.roomId, 'ACTIVE', event.startedAt, serverTime);
      return;
    }

    // A la sala va el resultado, no quien gano: eso solo se le dice al ganador (HU-29).
    const winnerId = event.winnerId !== undefined ? event.winnerId : event.currentBidderId;
    const result = event.result ?? (winnerId ? 'AWARDED' : 'DESERTED');
    room.emit('round.closed', {
      eventId: event.eventId,
      roomId: event.roomId,
      roundId: event.roundId,
      position: event.position,
      currentPrice: event.currentPrice,
      result,
      closedAt: event.closedAt,
      // Los eventos anteriores a HU-18 no dicen como queda la sala: no se adivina.
      roomStatus: event.roomStatus ?? null,
      serverTime,
    });
    if (event.roomStatus === 'CLOSED') this.emitRoomStatus(event.eventId, event.roomId, 'CLOSED', event.closedAt, serverTime);
    if (result === 'AWARDED' && winnerId) {
      this.server.to(userChannel(winnerId)).emit('round.won', {
        eventId: event.eventId,
        roomId: event.roomId,
        roundId: event.roundId,
        position: event.position,
        amount: event.winningAmount ?? event.currentPrice,
        serverTime,
      });
    }
  }

  private emitRoomStatus(eventId: string, roomId: string, status: RoomStatus, at: string, serverTime: string) {
    this.server.to(roomChannel(roomId)).emit('room.status', { eventId, roomId, status, at, serverTime });
  }
}
