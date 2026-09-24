import { describe, expect, it, vi } from 'vitest';
import { RealtimeGateway } from './realtime.gateway.js';

function setup(verifiedUser: string | null = 'alice') {
  const emitted: Array<{ channel: string; name: string; payload: Record<string, unknown> }> = [];
  let middleware: (socket: unknown, next: (error?: Error) => void) => Promise<void> = async () => undefined;
  const server = {
    to: (channel: string) => ({ emit: (name: string, payload: Record<string, unknown>) => emitted.push({ channel, name, payload }) }),
    use: (fn: typeof middleware) => { middleware = fn; },
  };
  const gateway = new RealtimeGateway({ verify: vi.fn().mockResolvedValue(verifiedUser) } as never);
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
    expect(emitted.map(({ channel, name }) => `${channel} ${name}`)).toEqual(['room:room round.activated', 'room:room round.closed']);
  });
});
