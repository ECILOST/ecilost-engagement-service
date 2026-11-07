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
import { Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { HttpAuthGuard } from './http-auth.guard.js';
/** Cuantas notificaciones devuelve la bandeja: las mas recientes. */
const INBOX_SIZE = 50;
/**
 * Bandeja de notificaciones de quien consulta (HU-27, HU-29). Es la proyeccion que el
 * consumidor escribe a partir de los eventos de auction: aqui solo se lee y se marca leida.
 */
let NotificationsController = class NotificationsController {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async mine(request) {
        const notifications = await this.prisma.notification.findMany({
            where: { recipientId: request.userId },
            orderBy: { createdAt: 'desc' },
            take: INBOX_SIZE,
            select: { id: true, kind: true, roomId: true, payload: true, createdAt: true, readAt: true },
        });
        return { items: notifications };
    }
    /** Marca todo como leido. Idempotente: repetirlo no cambia nada. */
    async markRead(request) {
        await this.prisma.notification.updateMany({
            where: { recipientId: request.userId, readAt: null },
            data: { readAt: new Date() },
        });
    }
};
__decorate([
    Get(),
    __param(0, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "mine", null);
__decorate([
    Post('read'),
    HttpCode(204),
    __param(0, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], NotificationsController.prototype, "markRead", null);
NotificationsController = __decorate([
    Controller('notifications'),
    UseGuards(HttpAuthGuard),
    __metadata("design:paramtypes", [PrismaService])
], NotificationsController);
export { NotificationsController };
//# sourceMappingURL=notifications.controller.js.map