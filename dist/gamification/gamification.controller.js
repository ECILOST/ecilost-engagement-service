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
import { BadRequestException, Controller, Get, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { HttpAuthGuard } from '../notifications/http-auth.guard.js';
import { GamificationReadModel } from './read-model.js';
/**
 * Perfil y top semanal del estudiante. Solo lecturas: el modelo lo escriben los eventos.
 *
 * Sin `MONGODB_URI` (o con Atlas caido) responde 503 con un mensaje claro: el front muestra
 * el error y la opcion de reintentar, y el resto de engagement sigue funcionando.
 */
let GamificationController = class GamificationController {
    readModel;
    constructor(readModel) {
        this.readModel = readModel;
    }
    async myProfile(request) {
        this.ensureEnabled();
        return this.read(() => this.readModel.profile(request.userId));
    }
    async leaderboard(request, week) {
        this.ensureEnabled();
        const which = week ?? 'current';
        if (which !== 'current' && which !== 'previous') {
            throw new BadRequestException('`week` debe ser `current` o `previous`.');
        }
        return this.read(() => this.readModel.leaderboard(request.userId, which));
    }
    ensureEnabled() {
        if (!this.readModel.enabled)
            throw new ServiceUnavailableException('La gamificacion no esta configurada en este entorno.');
    }
    async read(work) {
        try {
            return await work();
        }
        catch {
            throw new ServiceUnavailableException('No se pudo leer el perfil en este momento. Intenta de nuevo.');
        }
    }
};
__decorate([
    Get('profiles/me'),
    __param(0, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], GamificationController.prototype, "myProfile", null);
__decorate([
    Get('leaderboard'),
    __param(0, Req()),
    __param(1, Query('week')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], GamificationController.prototype, "leaderboard", null);
GamificationController = __decorate([
    Controller(),
    UseGuards(HttpAuthGuard),
    __metadata("design:paramtypes", [GamificationReadModel])
], GamificationController);
export { GamificationController };
//# sourceMappingURL=gamification.controller.js.map