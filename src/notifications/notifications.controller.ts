import { Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { HttpAuthGuard, type AuthenticatedRequest } from './http-auth.guard.js';

/** Cuantas notificaciones devuelve la bandeja: las mas recientes. */
const INBOX_SIZE = 50;

/**
 * Bandeja de notificaciones de quien consulta (HU-27, HU-29). Es la proyeccion que el
 * consumidor escribe a partir de los eventos de auction: aqui solo se lee y se marca leida.
 */
@Controller('notifications')
@UseGuards(HttpAuthGuard)
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async mine(@Req() request: AuthenticatedRequest) {
    const notifications = await this.prisma.notification.findMany({
      where: { recipientId: request.userId },
      orderBy: { createdAt: 'desc' },
      take: INBOX_SIZE,
      select: { id: true, kind: true, roomId: true, payload: true, createdAt: true, readAt: true },
    });
    return { items: notifications };
  }

  /** Marca todo como leido. Idempotente: repetirlo no cambia nada. */
  @Post('read')
  @HttpCode(204)
  async markRead(@Req() request: AuthenticatedRequest) {
    await this.prisma.notification.updateMany({
      where: { recipientId: request.userId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
