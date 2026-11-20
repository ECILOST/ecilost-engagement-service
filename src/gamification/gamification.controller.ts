import { BadRequestException, Controller, Get, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { HttpAuthGuard, type AuthenticatedRequest } from '../notifications/http-auth.guard.js';
import { GamificationReadModel } from './read-model.js';

/**
 * Perfil y top semanal del estudiante. Solo lecturas: el modelo lo escriben los eventos.
 *
 * Sin `MONGODB_URI` (o con Atlas caido) responde 503 con un mensaje claro: el front muestra
 * el error y la opcion de reintentar, y el resto de engagement sigue funcionando.
 */
@Controller()
@UseGuards(HttpAuthGuard)
export class GamificationController {
  constructor(private readonly readModel: GamificationReadModel) {}

  @Get('profiles/me')
  async myProfile(@Req() request: AuthenticatedRequest) {
    this.ensureEnabled();
    return this.read(() => this.readModel.profile(request.userId as string));
  }

  @Get('leaderboard')
  async leaderboard(@Req() request: AuthenticatedRequest, @Query('week') week?: string) {
    this.ensureEnabled();
    const which = week ?? 'current';
    if (which !== 'current' && which !== 'previous') {
      throw new BadRequestException('`week` debe ser `current` o `previous`.');
    }
    return this.read(() => this.readModel.leaderboard(request.userId as string, which));
  }

  private ensureEnabled() {
    if (!this.readModel.enabled) throw new ServiceUnavailableException('La gamificacion no esta configurada en este entorno.');
  }

  private async read<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new ServiceUnavailableException('No se pudo leer el perfil en este momento. Intenta de nuevo.');
    }
  }
}
