import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenVerifier } from '../realtime/token-verifier.js';
import { type AuthenticatedRequest, HttpAuthGuard } from './http-auth.guard.js';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'ecilost-test';

function requestContext(token: string) {
  const request: AuthenticatedRequest = { headers: { authorization: `Bearer ${token}` } };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
  return { context, request };
}

describe('HttpAuthGuard', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let guard: HttpAuthGuard;

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
  });

  beforeEach(async () => {
    const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'RS256', kid: 'test' };
    vi.stubGlobal('fetch', async () => Response.json({ keys: [jwk] }));
    const config = new ConfigService({
      AUTH_JWKS_URL: `${ISSUER}/.well-known/jwks.json`,
      JWT_ISSUER: ISSUER,
      JWT_AUDIENCE: AUDIENCE,
    });
    guard = new HttpAuthGuard(new TokenVerifier(config));
  });

  afterEach(() => vi.unstubAllGlobals());

  function token(expiresIn?: string) {
    const jwt = new SignJWT({ role: 'STUDENT' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('student-fixture');
    if (expiresIn) jwt.setExpirationTime(expiresIn);
    return jwt.sign(keys.privateKey);
  }

  it('acepta un JWT vigente y asigna el usuario', async () => {
    const { context, request } = requestContext(await token('1m'));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.userId).toBe('student-fixture');
  });

  it('responde 401 si falta el vencimiento', async () => {
    const { context, request } = requestContext(await token());

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.userId).toBeUndefined();
  });
});
