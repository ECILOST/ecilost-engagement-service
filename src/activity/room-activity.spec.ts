import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RoomAccess } from '../realtime/room-access.js';
import { ACTIVITY_PAGE_SIZE, RoomActivityController } from './room-activity.controller.js';
import { toActivityItem } from './room-activity.js';

const ROOM = '0b8f3c1e-5d2a-4c7b-9e1f-2a3b4c5d6e7f';
const at = new Date(Date.UTC(2026, 9, 31, 15, 0, 0));

const bid = {
  eventId: 'bid-1',
  eventType: 'auction.bid.accepted.v1',
  occurredAt: at,
  payload: {
    roomId: ROOM, roundId: 'round-1', position: 1, bidId: 'b1', bidderId: 'alice', amount: '120',
    previousBidderId: 'bob', previousPrice: '110', currentBidderId: 'alice', currentPrice: '120',
    endsAt: '2026-10-31T15:03:10.000Z', sequence: '3', extended: true, automatic: true,
  },
};

describe('toActivityItem', () => {
  it('publica la puja sin decir quien la hizo, ni a quien supero', () => {
    const item = toActivityItem(bid);
    expect(item).toEqual({
      id: 'bid-1', kind: 'BID', roundId: 'round-1', position: 1, amount: '120',
      automatic: true, extended: true, endsAt: '2026-10-31T15:03:10.000Z', at: at.toISOString(),
    });
    expect(JSON.stringify(item)).not.toMatch(/alice|bob/);
  });

  it('publica el inicio de la ronda con su precio de salida', () => {
    const item = toActivityItem({
      eventId: 'act-1', eventType: 'auction.round.activated.v1', occurredAt: at,
      payload: { roomId: ROOM, roundId: 'round-1', position: 1, currentPrice: '100', startedAt: at.toISOString(), endsAt: at.toISOString(), entries: [] },
    });
    expect(item).toEqual({ id: 'act-1', kind: 'ROUND_STARTED', roundId: 'round-1', position: 1, startingPrice: '100', mode: 'CLASSIC', at: at.toISOString() });
  });

  it('publica el cierre con el resultado y el precio, pero no al ganador', () => {
    const item = toActivityItem({
      eventId: 'close-1', eventType: 'auction.round.closed.v1', occurredAt: at,
      payload: { roomId: ROOM, roundId: 'round-1', position: 2, currentPrice: '150', currentBidderId: 'alice', closedAt: at.toISOString(), result: 'AWARDED', winnerId: 'alice', winningAmount: '150', roomStatus: 'CLOSED' },
    });
    expect(item).toEqual({ id: 'close-1', kind: 'ROUND_CLOSED', roundId: 'round-1', position: 2, result: 'AWARDED', amount: '150', roomClosed: true, at: at.toISOString() });
    expect(JSON.stringify(item)).not.toContain('alice');
  });

  it('un cierre anterior a HU-28 deduce el resultado de si hubo lider', () => {
    const item = toActivityItem({
      eventId: 'close-2', eventType: 'auction.round.closed.v1', occurredAt: at,
      payload: { roomId: ROOM, roundId: 'round-2', position: 2, currentPrice: '100', currentBidderId: null, closedAt: at.toISOString() },
    });
    expect(item).toMatchObject({ result: 'DESERTED', roomClosed: false });
  });

  it('ignora lo que no es actividad publica o no trae ronda', () => {
    expect(toActivityItem({ eventId: 'x', eventType: 'auction.round.sealed-bid.placed.v1', occurredAt: at, payload: { roundId: 'r' } })).toBeNull();
    expect(toActivityItem({ eventId: 'y', eventType: 'auction.bid.accepted.v1', occurredAt: at, payload: {} })).toBeNull();
  });
});

describe('RoomActivityController', () => {
  function setup(access: RoomAccess = 'granted') {
    const check = vi.fn().mockResolvedValue(access);
    const findMany = vi.fn().mockResolvedValue([bid]);
    const controller = new RoomActivityController({ consumedEvent: { findMany } } as never, { check } as never);
    const request = { headers: { authorization: 'Bearer jwt' }, userId: 'carol' };
    return { controller, check, findMany, get: () => controller.activity(request, ROOM) };
  }

  it('devuelve la actividad reciente de la sala a quien auction deja verla', async () => {
    const { check, findMany, get } = setup();
    await expect(get()).resolves.toEqual({ items: [expect.objectContaining({ id: 'bid-1', kind: 'BID' })] });
    expect(check).toHaveBeenCalledWith(ROOM, 'jwt');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ roomId: ROOM }),
      orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
      take: ACTIVITY_PAGE_SIZE,
    }));
  });

  it.each([
    ['not-found', NotFoundException],
    ['denied', ForbiddenException],
    ['unavailable', ServiceUnavailableException],
  ] as const)('si auction responde %s no lee nada', async (access, error) => {
    const { findMany, get } = setup(access);
    await expect(get()).rejects.toBeInstanceOf(error);
    expect(findMany).not.toHaveBeenCalled();
  });
});
