import { describe, expect, it, vi } from 'vitest';
import { MAX_ROOMS_PER_CONNECTION, RealtimeGateway } from './realtime.gateway.js';
import type { RoomAccess } from './room-access.js';

const ROOM = '0b8f3c1e-5d2a-4c7b-9e1f-2a3b4c5d6e7f';

/** Una conexion ya autenticada como alice, y el gateway con auth y auction de mentira. */
function joining(access: RoomAccess = 'granted', tokenOwner: string | null = 'alice') {
  const verify = vi.fn().mockResolvedValue(tokenOwner);
  const check = vi.fn().mockResolvedValue(access);
  const gateway = new RealtimeGateway({ verify } as never, { check } as never);
  const client = {
    rooms: new Set<string>(['socket-id', 'user:alice']),
    data: { userId: 'alice' },
    handshake: { auth: { token: 'handshake-jwt' } },
    join: vi.fn(async (channel: string) => { client.rooms.add(channel); }),
  };
  const join = (body: unknown) => gateway.joinRoom(client as never, body as never);
  return { verify, check, client, join };
}

describe('RealtimeGateway room.join', () => {
  it('entra al canal de una sala que auction confirma, con el token vigente del cliente', async () => {
    const { verify, check, client, join } = joining();
    await expect(join({ roomId: ROOM, token: 'fresh-jwt' })).resolves.toEqual({ ok: true, roomId: ROOM });
    expect(verify).toHaveBeenCalledWith('fresh-jwt');
    expect(check).toHaveBeenCalledWith(ROOM, 'fresh-jwt');
    expect(client.join).toHaveBeenCalledWith(`room:${ROOM}`);
  });

  it('sin token en el mensaje usa el del handshake', async () => {
    const { check, join } = joining();
    await join({ roomId: ROOM });
    expect(check).toHaveBeenCalledWith(ROOM, 'handshake-jwt');
  });

  it('rechaza un roomId que no es una sala, sin preguntarle a nadie', async () => {
    const { verify, check, client, join } = joining();
    for (const roomId of ['', 'sala', `${ROOM}x`, 42, undefined]) {
      await expect(join({ roomId })).resolves.toEqual({ ok: false, reason: 'invalid-room' });
    }
    expect(verify).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });

  it('rechaza un token vencido o de otra persona', async () => {
    for (const owner of [null, 'mallory']) {
      const { check, client, join } = joining('granted', owner);
      await expect(join({ roomId: ROOM, token: 'jwt' })).resolves.toEqual({ ok: false, reason: 'unauthorized' });
      expect(check).not.toHaveBeenCalled();
      expect(client.join).not.toHaveBeenCalled();
    }
  });

  it.each(['not-found', 'denied', 'unavailable'] as const)('no entra si auction responde %s', async (access) => {
    const { client, join } = joining(access);
    await expect(join({ roomId: ROOM, token: 'jwt' })).resolves.toEqual({ ok: false, reason: access });
    expect(client.join).not.toHaveBeenCalled();
  });

  it(`una conexion escucha a lo sumo ${MAX_ROOMS_PER_CONNECTION} salas`, async () => {
    const { check, client, join } = joining();
    for (let index = 0; index < MAX_ROOMS_PER_CONNECTION; index += 1) client.rooms.add(`room:sala-${index}`);
    await expect(join({ roomId: ROOM, token: 'jwt' })).resolves.toEqual({ ok: false, reason: 'too-many-rooms' });
    expect(check).not.toHaveBeenCalled();
  });

  it('volver a entrar a una sala que ya escucha no consulta de nuevo', async () => {
    const { check, client, join } = joining();
    client.rooms.add(`room:${ROOM}`);
    await expect(join({ roomId: ROOM, token: 'jwt' })).resolves.toEqual({ ok: true, roomId: ROOM });
    expect(check).not.toHaveBeenCalled();
  });
});

function setup(verifiedUser: string | null = 'alice') {
  const emitted: Array<{ channel: string; name: string; payload: Record<string, unknown> }> = [];
  let middleware: (socket: unknown, next: (error?: Error) => void) => Promise<void> = async () => undefined;
  const server = {
    to: (channel: string) => ({ emit: (name: string, payload: Record<string, unknown>) => emitted.push({ channel, name, payload }) }),
    use: (fn: typeof middleware) => { middleware = fn; },
  };
  const gateway = new RealtimeGateway({ verify: vi.fn().mockResolvedValue(verifiedUser) } as never, { check: vi.fn() } as never);
  (gateway as unknown as { server: typeof server }).server = server;
  gateway.afterInit(server as never);
  return { gateway, emitted, connect: (socket: unknown, next: (error?: Error) => void) => middleware(socket, next) };
}

const bid = {
  eventId: 'bid-2', eventType: 'auction.bid.accepted.v1' as const, occurredAt: '2030-01-01T10:00:00.000Z',
  roomId: 'room', roundId: 'round', position: 1, bidId: 'bid-2', bidderId: 'bob', amount: '20.00',
  previousBidderId: 'alice', previousPrice: '10.00', currentBidderId: 'bob', currentPrice: '20.00',
  endsAt: '2030-01-01T10:03:10.000Z', sequence: '2',
};

describe('RealtimeGateway', () => {
  it('rechaza conexiones sin un token valido', async () => {
    const { connect } = setup(null);
    const next = vi.fn();
    await connect({ handshake: { auth: {} }, data: {}, join: vi.fn() }, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('suscribe al usuario autenticado a su canal personal', async () => {
    const { connect } = setup('alice');
    const socket = { handshake: { auth: { token: 'jwt' } }, data: {} as Record<string, unknown>, join: vi.fn() };
    const next = vi.fn();
    await connect(socket, next);
    expect(socket.join).toHaveBeenCalledWith('user:alice');
    expect(socket.data.userId).toBe('alice');
    expect(next).toHaveBeenCalledWith();
  });

  it('envia el precio a toda la sala y la superacion solo al participante superado', () => {
    const { gateway, emitted } = setup();
    gateway.publish(bid);
    expect(emitted.map(({ channel, name }) => `${channel} ${name}`)).toEqual(['room:room round.price', 'user:alice bid.outbid']);
    expect(emitted[0].payload).toMatchObject({ currentPrice: '20.00', endsAt: bid.endsAt, serverTime: expect.any(String) });
  });

  it('anuncia la transicion y el cierre de ronda a toda la sala', () => {
    const { gateway, emitted } = setup();
    gateway.publish({
      eventId: 'a', eventType: 'auction.round.activated.v1', occurredAt: bid.occurredAt, roomId: 'room', roundId: 'round-2',
      position: 2, currentPrice: '0', startedAt: bid.occurredAt, endsAt: bid.endsAt, entries: [],
    });
    gateway.publish({
      eventId: 'c', eventType: 'auction.round.closed.v1', occurredAt: bid.occurredAt, roomId: 'room', roundId: 'round',
      position: 1, currentPrice: '20.00', currentBidderId: 'bob', closedAt: bid.occurredAt,
    });
    expect(emitted.map(({ channel, name }) => `${channel} ${name}`)).toEqual([
      'room:room round.activated',
      'room:room round.closed',
      'user:bob round.won',
    ]);
    // La sala conoce el resultado, no quien gano.
    expect(emitted[1].payload).toMatchObject({ result: 'AWARDED' });
    expect(emitted[1].payload).not.toHaveProperty('currentBidderId');
  });

  it('avisa a toda la sala cuando una puja del ultimo minuto extiende el cierre (HU-23)', () => {
    const { gateway, emitted } = setup();
    gateway.publish({ ...bid, previousBidderId: null, previousPrice: null, extended: true, previousEndsAt: '2030-01-01T10:02:30.000Z', automatic: true });
    expect(emitted.map(({ channel, name }) => `${channel} ${name}`)).toEqual(['room:room round.price', 'room:room round.extended']);
    expect(emitted[0].payload).toMatchObject({ automatic: true, extended: true });
    expect(emitted[1].payload).toMatchObject({
      roundId: 'round', previousEndsAt: '2030-01-01T10:02:30.000Z', endsAt: bid.endsAt, sequence: '2', serverTime: expect.any(String),
    });
  });

  it('una puja sin extension no emite round.extended y los eventos viejos se tratan como manuales', () => {
    const { gateway, emitted } = setup();
    gateway.publish({ ...bid, previousBidderId: null, previousPrice: null });
    expect(emitted.map(({ name }) => name)).toEqual(['round.price']);
    expect(emitted[0].payload).toMatchObject({ automatic: false, extended: false });
  });

  it('anuncia el inicio de la sala con su primera ronda y el fin con el cierre de la ultima (HU-18)', () => {
    const { gateway, emitted } = setup();
    gateway.publish({
      eventId: 'a', eventType: 'auction.round.activated.v1', occurredAt: bid.occurredAt, roomId: 'room', roundId: 'round',
      position: 1, currentPrice: '0', startedAt: bid.occurredAt, endsAt: bid.endsAt, entries: [], roomStatus: 'ACTIVE',
    });
    gateway.publish({
      eventId: 'c', eventType: 'auction.round.closed.v1', occurredAt: bid.occurredAt, roomId: 'room', roundId: 'round',
      position: 1, currentPrice: '50.00', currentBidderId: null, closedAt: bid.endsAt, result: 'DESERTED', winnerId: null, roomStatus: 'CLOSED',
    });
    expect(emitted.map(({ name }) => name)).toEqual(['round.activated', 'room.status', 'round.closed', 'room.status']);
    expect(emitted[1].payload).toMatchObject({ roomId: 'room', status: 'ACTIVE', at: bid.occurredAt });
    expect(emitted[2].payload).toMatchObject({ roomStatus: 'CLOSED' });
    expect(emitted[3].payload).toMatchObject({ roomId: 'room', status: 'CLOSED', at: bid.endsAt });
  });

  it('una ronda desierta no avisa a ningun ganador', () => {
    const { gateway, emitted } = setup();
    gateway.publish({
      eventId: 'c', eventType: 'auction.round.closed.v1', occurredAt: bid.occurredAt, roomId: 'room', roundId: 'round',
      position: 1, currentPrice: '50.00', currentBidderId: null, closedAt: bid.occurredAt, result: 'DESERTED', winnerId: null,
    });
    expect(emitted.map(({ name }) => name)).toEqual(['round.closed']);
  });
});
