var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenVerifier } from '../realtime/token-verifier.js';
/** El mismo JWT que exige el canal en vivo, ahora para la bandeja por HTTP. */
let HttpAuthGuard = class HttpAuthGuard {
    tokens;
    constructor(tokens) {
        this.tokens = tokens;
    }
    async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
        const userId = scheme === 'Bearer' ? await this.tokens.verify(token) : null;
        if (!userId)
            throw new UnauthorizedException('El token de acceso no es valido.');
        request.userId = userId;
        return true;
    }
};
HttpAuthGuard = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [TokenVerifier])
], HttpAuthGuard);
export { HttpAuthGuard };
//# sourceMappingURL=http-auth.guard.js.map