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
    if (typeof token !== 'string' || !token) return null;
    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: this.audience, algorithms: ['RS256'] });
      if (!payload.sub || (payload.role !== 'STAFF' && payload.role !== 'STUDENT')) return null;
      return payload.sub;
    } catch {
      return null;
    }
  }
}
