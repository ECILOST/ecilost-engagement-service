import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomAccessVerifier } from './room-access.js';

const ROOM = '0b8f3c1e-5d2a-4c7b-9e1f-2a3b4c5d6e7f';

const verifier = (auctionUrl = 'https://auction.test/') =>
  new RoomAccessVerifier({ get: () => auctionUrl } as never);

describe('RoomAccessVerifier', () => {
  const fetch = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetch);
    fetch.mockReset();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('pregunta a auction por la sala con el token de quien quiere escucharla', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200 });
    await expect(verifier().check(ROOM, 'jwt')).resolves.toBe('granted');
    expect(fetch).toHaveBeenCalledWith(`https://auction.test/rooms/${ROOM}`, expect.objectContaining({
      headers: { authorization: 'Bearer jwt' },
    }));
  });

  it.each([
    [404, 'not-found'],
    [400, 'not-found'],
    [401, 'denied'],
    [403, 'denied'],
    [500, 'unavailable'],
  ] as const)('auction responde %i: %s', async (status, access) => {
    fetch.mockResolvedValue({ ok: false, status });
    await expect(verifier().check(ROOM, 'jwt')).resolves.toBe(access);
  });

  it('sin respuesta de auction no concede la entrada', async () => {
    fetch.mockRejectedValue(new Error('timeout'));
    await expect(verifier().check(ROOM, 'jwt')).resolves.toBe('unavailable');
  });

  it('sin AUCTION_SERVICE_URL solo queda la validacion de formato del gateway', async () => {
    await expect(verifier('').check(ROOM, 'jwt')).resolves.toBe('granted');
    expect(fetch).not.toHaveBeenCalled();
  });
});
