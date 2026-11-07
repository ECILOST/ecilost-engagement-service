var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';
/** Valida el mismo JWT RS256 que emite Auth y que exige Auction en HTTP. */
let TokenVerifier = class TokenVerifier {
    jwks;
    issuer;
    audience;
    constructor(config) {
        const jwksUrl = config.get('AUTH_JWKS_URL');
        this.issuer = config.get('JWT_ISSUER') ?? '';
        this.audience = config.get('JWT_AUDIENCE') ?? '';
        if (!jwksUrl || !this.issuer || !this.audience) {
            throw new Error('AUTH_JWKS_URL, JWT_ISSUER and JWT_AUDIENCE must be configured for Engagement.');
        }
        this.jwks = createRemoteJWKSet(new URL(jwksUrl));
    }
    /** Devuelve el userId del token o null si no es valido. */
    async verify(token) {
        if (typeof token !== 'string' || !token)
            return null;
        try {
            const { payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: this.audience, algorithms: ['RS256'] });
            if (!payload.sub || (payload.role !== 'STAFF' && payload.role !== 'STUDENT'))
                return null;
            return payload.sub;
        }
        catch {
            return null;
        }
    }
};
TokenVerifier = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [ConfigService])
], TokenVerifier);
export { TokenVerifier };
//# sourceMappingURL=token-verifier.js.map