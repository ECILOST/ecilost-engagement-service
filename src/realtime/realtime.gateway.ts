import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import type { AuctionEvent } from '../events/event-contracts.js';
import { TokenVerifier } from './token-verifier.js';

const roomChannel = (roomId: string) => `room:${roomId}`;
const userChannel = (userId: string) => `user:${userId}`;

/**
 * Canal de tiempo real de la sala. El cliente se conecta con
 * `io('/realtime', { auth: { token } })`, emite `room.join` con el roomId y recibe:
 * - `round.price`: nuevo precio y `endsAt` tras una puja aceptada (a toda la sala).
 * - `round.activated` / `round.closed`: transicion de ronda (a toda la sala).
 * - `bid.outbid`: aviso personal al participante superado.
 * Cada mensaje trae `eventId` (para descartar repetidos) y `serverTime`, con el que
 * el cliente calcula el contador sin depender de su reloj local. Al reconectar, el
 * cliente vuelve a consultar `GET /rooms/:roomId/state` en Auction.
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: true } })
export class RealtimeGateway implements OnGatewayInit {
  @WebSocketServer() private server: Namespace;

  constructor(private readonly tokens: TokenVerifier) {}

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

  @SubscribeMessage('room.join')
  async joinRoom(@ConnectedSocket() client: Socket, @MessageBody() body: { roomId?: unknown }) {
    if (typeof body?.roomId !== 'string' || !body.roomId) return { ok: false };
    await client.join(roomChannel(body.roomId));
    return { ok: true, roomId: body.roomId };
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
        serverTime,
      });
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
        serverTime,
      });
      return;
    }

    room.emit('round.closed', {
      eventId: event.eventId,
      roomId: event.roomId,
      roundId: event.roundId,
      position: event.position,
      currentPrice: event.currentPrice,
      currentBidderId: event.currentBidderId,
      closedAt: event.closedAt,
      serverTime,
    });
  }
}
