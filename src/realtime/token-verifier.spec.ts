import { ConfigService } from '@nestjs/config';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TokenVerifier } from './token-verifier.js';

const ISSUER = 'https://auth.example.test';
const AUDIENCE = 'ecilost-test';

describe('TokenVerifier', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
  });

  afterEach(() => vi.unstubAllGlobals());

  async function fixture() {
    const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'RS256', kid: 'test' };
    vi.stubGlobal('fetch', async () => Response.json({ keys: [jwk] }));
    const verifier = new TokenVerifier(new ConfigService({
      AUTH_JWKS_URL: `${ISSUER}/.well-known/jwks.json`,
      JWT_ISSUER: ISSUER,
      JWT_AUDIENCE: AUDIENCE,
    }));
    const token = new SignJWT({ role: 'STUDENT' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('alice');
    return { verifier, token };
  }

  it('devuelve el vencimiento firmado de la sesion en milisegundos', async () => {
    const { verifier, token } = await fixture();
    const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 60;
    const jwt = await token.setExpirationTime(expiresAtSeconds).sign(keys.privateKey);

    await expect(verifier.verifySession(jwt)).resolves.toEqual({
      userId: 'alice',
      expiresAt: expiresAtSeconds * 1_000,
    });
    await expect(verifier.verify(jwt)).resolves.toBe('alice');
  });

  it('exige que un token de sesion persistente tenga vencimiento', async () => {
    const { verifier, token } = await fixture();
    const jwt = await token.sign(keys.privateKey);

    await expect(verifier.verifySession(jwt)).resolves.toBeNull();
  });
});
