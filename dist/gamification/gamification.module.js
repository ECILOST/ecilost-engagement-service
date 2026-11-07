var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
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
let GamificationModule = class GamificationModule {
};
GamificationModule = __decorate([
    Module({
        imports: [RealtimeModule],
        controllers: [GamificationController],
        providers: [MongoService, GamificationReadModel, GamificationConsumer, HttpAuthGuard],
        exports: [GamificationReadModel],
    })
], GamificationModule);
export { GamificationModule };
//# sourceMappingURL=gamification.module.js.map