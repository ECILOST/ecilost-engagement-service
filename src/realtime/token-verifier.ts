import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Valida el mismo JWT RS256 que emite Auth y que exige Auction en HTTP. */
@Injectable()
export class TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(config: ConfigService) {
    const jwksUrl = config.get<string>('AUTH_JWKS_URL');
    this.issuer = config.get<string>('JWT_ISSUER') ?? '';
    this.audience = config.get<string>('JWT_AUDIENCE') ?? '';
    if (!jwksUrl || !this.issuer || !this.audience) {
      throw new Error('AUTH_JWKS_URL, JWT_ISSUER and JWT_AUDIENCE must be configured for Engagement.');
    }
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
  }

  /** Devuelve el userId del token o null si no es valido. */
  async verify(token: unknown): Promise<string | null> {
    return (await this.verifyClaims(token))?.userId ?? null;
  }

  /** Una conexion persistente necesita un vencimiento para cerrar la sesion. */
  async verifySession(token: unknown): Promise<{ userId: string; expiresAt: number } | null> {
    const claims = await this.verifyClaims(token);
    if (!claims || claims.exp === undefined) return null;

    const expiresAt = claims.exp * 1_000;
    if (!Number.isFinite(expiresAt)) return null;
    return { userId: claims.userId, expiresAt };
  }

  private async verifyClaims(token: unknown): Promise<{ userId: string; exp?: number } | null> {
    if (typeof token !== 'string' || !token) return null;
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp'],
      });
      if (!payload.sub || (payload.role !== 'STAFF' && payload.role !== 'STUDENT')) return null;
      return { userId: payload.sub, exp: payload.exp };
    } catch {
      return null;
    }
  }
}
