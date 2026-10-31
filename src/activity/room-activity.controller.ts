import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { HttpAuthGuard, type AuthenticatedRequest } from '../notifications/http-auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RoomAccessVerifier } from '../realtime/room-access.js';
import { ACTIVITY_EVENT_TYPES, toActivityItem } from './room-activity.js';

/** Cuanta actividad devuelve: la mas reciente. */
export const ACTIVITY_PAGE_SIZE = 50;

/**
 * Actividad publica de una sala: pujas (sin autor), inicio y cierre de cada ronda. La ve
 * quien puede ver la sala, con la misma regla del canal en vivo: participantes, quien la
 * sigue desde afuera y el funcionario. Auction decide quien puede verla.
 */
@Controller('rooms')
@UseGuards(HttpAuthGuard)
export class RoomActivityController {
  constructor(private readonly prisma: PrismaService, private readonly rooms: RoomAccessVerifier) {}

  @Get(':roomId/activity')
  async activity(
    @Req() request: AuthenticatedRequest,
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
  ) {
    // El guard ya valido el token; auction lo vuelve a ver para decidir sobre la sala.
    const token = request.headers.authorization?.split(' ')[1] ?? '';
    const access = await this.rooms.check(roomId, token);
    if (access === 'not-found') throw new NotFoundException('La sala no existe.');
    if (access === 'denied') throw new ForbiddenException('No puedes ver esta sala.');
    if (access === 'unavailable') throw new ServiceUnavailableException('No se pudo verificar la sala.');

    const rows = await this.prisma.consumedEvent.findMany({
      where: { roomId, eventType: { in: [...ACTIVITY_EVENT_TYPES] } },
      orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
      take: ACTIVITY_PAGE_SIZE,
      select: { eventId: true, eventType: true, occurredAt: true, payload: true },
    });
    return { items: rows.map(toActivityItem).filter((item) => item !== null) };
  }
}
