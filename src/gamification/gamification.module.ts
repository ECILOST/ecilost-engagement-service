import { Module } from '@nestjs/common';
import { HttpAuthGuard } from '../notifications/http-auth.guard.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { GamificationConsumer } from './gamification.consumer.js';
import { GamificationController } from './gamification.controller.js';
import { MongoService } from './mongo.service.js';
import { GamificationReadModel } from './read-model.js';

/**
 * Perfil, top semanal y medallas (semana 12: NoSQL y consistencia). Modelo de lectura en
 * MongoDB alimentado por los eventos de auction; ver `README.md` de esta carpeta.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [GamificationController],
  providers: [MongoService, GamificationReadModel, GamificationConsumer, HttpAuthGuard],
  exports: [GamificationReadModel],
})
export class GamificationModule {}
