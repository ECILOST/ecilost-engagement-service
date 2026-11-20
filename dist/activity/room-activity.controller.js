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
import { Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Req, ServiceUnavailableException, UseGuards, } from '@nestjs/common';
import { HttpAuthGuard } from '../notifications/http-auth.guard.js';
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
let RoomActivityController = class RoomActivityController {
    prisma;
    rooms;
    constructor(prisma, rooms) {
        this.prisma = prisma;
        this.rooms = rooms;
    }
    async activity(request, roomId) {
        // El guard ya valido el token; auction lo vuelve a ver para decidir sobre la sala.
        const token = request.headers.authorization?.split(' ')[1] ?? '';
        const access = await this.rooms.check(roomId, token);
        if (access === 'not-found')
            throw new NotFoundException('La sala no existe.');
        if (access === 'denied')
            throw new ForbiddenException('No puedes ver esta sala.');
        if (access === 'unavailable')
            throw new ServiceUnavailableException('No se pudo verificar la sala.');
        const rows = await this.prisma.consumedEvent.findMany({
            where: { roomId, eventType: { in: [...ACTIVITY_EVENT_TYPES] } },
            orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
            take: ACTIVITY_PAGE_SIZE,
            select: { eventId: true, eventType: true, occurredAt: true, payload: true },
        });
        return { items: rows.map(toActivityItem).filter((item) => item !== null) };
    }
};
__decorate([
    Get(':roomId/activity'),
    __param(0, Req()),
    __param(1, Param('roomId', new ParseUUIDPipe({ version: '4' }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], RoomActivityController.prototype, "activity", null);
RoomActivityController = __decorate([
    Controller('rooms'),
    UseGuards(HttpAuthGuard),
    __metadata("design:paramtypes", [PrismaService, RoomAccessVerifier])
], RoomActivityController);
export { RoomActivityController };
//# sourceMappingURL=room-activity.controller.js.map