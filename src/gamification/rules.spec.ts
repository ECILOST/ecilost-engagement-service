import { describe, expect, it } from 'vitest';
import type { AuctionRoundClosedEvent } from '../events/event-contracts.js';
import { favoriteMode, featuredMedals, medalProgress, reachedMedals, type MedalCounters } from './medals.js';
import { publicAlias } from './public-alias.js';
import { isLastSecondBid, roundOutcome } from './round-outcome.js';
import { previousWeekKey, streakWeeks, weekKey, weekRange } from './weeks.js';

const counters = (overrides: Partial<MedalCounters> = {}): MedalCounters => ({
  wins: 0,
  modes: {},
  perfectSeals: 0,
  lastSecondWins: 0,
  bestStreak: 0,
  podiums: 0,
  ...overrides,
});

describe('semanas del top (Bogota, lunes a domingo)', () => {
  it('el domingo en la noche de Bogota sigue siendo la semana que empezo el lunes', () => {
    // Domingo 8 nov 2026, 23:30 en Bogota = lunes 9 nov 04:30 UTC.
    expect(weekKey(new Date('2026-11-09T04:30:00Z'))).toBe('2026-11-02');
    // Lunes 9 nov, 00:00 en Bogota = 05:00 UTC: ya es la semana nueva.
    expect(weekKey(new Date('2026-11-09T05:00:00Z'))).toBe('2026-11-09');
    expect(previousWeekKey(new Date('2026-11-09T05:00:00Z'))).toBe('2026-11-02');
    expect(weekRange('2026-11-02')).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });

  it('la racha cuenta semanas seguidas y no se rompe hasta que una semana termina en cero', () => {
    const now = new Date('2026-11-04T15:00:00Z'); // miercoles de la semana del 2 nov
    expect(streakWeeks(['2026-10-19', '2026-10-26', '2026-11-02'], now)).toBe(3);
    // Esta semana todavia no gana: cuenta desde la anterior.
    expect(streakWeeks(['2026-10-19', '2026-10-26'], now)).toBe(2);
    // Un hueco corta la racha.
    expect(streakWeeks(['2026-10-12', '2026-10-26'], now)).toBe(1);
    expect(streakWeeks([], now)).toBe(0);
  });
});

describe('medallas', () => {
  it('cada regla se alcanza con su contador', () => {
    expect(reachedMedals(counters())).toEqual([]);
    expect(
      reachedMedals(
        counters({
          wins: 9,
          modes: { DUTCH: { played: 6, won: 5, bids: 20 }, MYSTERY: { played: 3, won: 3, bids: 3 }, SEALED: { played: 1, won: 1, bids: 1 } },
          perfectSeals: 1,
          bestStreak: 3,
        }),
      ),
    ).toEqual(['FIRST_WIN', 'DUTCH_KING', 'PERFECT_SEAL', 'STREAK_3', 'DETECTIVE']);
  });

  it('coleccionista pide ganar en las cuatro modalidades', () => {
    const three = counters({ modes: { CLASSIC: { played: 1, won: 1, bids: 1 }, DUTCH: { played: 1, won: 1, bids: 1 }, SEALED: { played: 1, won: 1, bids: 1 } } });
    const collector = medalProgress(three, {}).find((medal) => medal.id === 'COLLECTOR');
    expect(collector).toEqual({ id: 'COLLECTOR', unlockedAt: null, progress: 3, goal: 4 });
  });

  it('una medalla ganada no se pierde aunque el contador baje (la racha)', () => {
    const streak = medalProgress(counters({ bestStreak: 1 }), { STREAK_3: '2026-10-01T00:00:00.000Z' }).find((m) => m.id === 'STREAK_3');
    expect(streak).toEqual({ id: 'STREAK_3', unlockedAt: '2026-10-01T00:00:00.000Z', progress: 3, goal: 3 });
  });

  it('se lucen las dos mas recientes, y la favorita es la modalidad con mas pujas', () => {
    expect(
      featuredMedals({ FIRST_WIN: '2026-09-01T00:00:00Z', DUTCH_KING: '2026-11-01T00:00:00Z', STREAK_3: '2026-10-01T00:00:00Z' }),
    ).toEqual(['DUTCH_KING', 'STREAK_3']);
    expect(favoriteMode({ CLASSIC: { played: 9, won: 1, bids: 4 }, DUTCH: { played: 2, won: 1, bids: 7 } })).toEqual({ mode: 'DUTCH', bids: 7 });
    expect(favoriteMode({})).toEqual({ mode: null, bids: 0 });
  });
});

describe('alias publico', () => {
  it('es estable, legible y no deja ver el id', () => {
    const alias = publicAlias('6f1c2d3e-0000-4000-8000-000000000001');
    expect(alias).toBe(publicAlias('6f1c2d3e-0000-4000-8000-000000000001'));
    expect(alias).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    expect(publicAlias('6f1c2d3e-0000-4000-8000-000000000002')).not.toBe(alias);
  });
});

describe('cierre de ronda -> resultado por participante', () => {
  const closed = (overrides: Partial<AuctionRoundClosedEvent> = {}): AuctionRoundClosedEvent => ({
    eventId: 'evt-close',
    eventType: 'auction.round.closed.v1',
    occurredAt: '2026-11-04T15:00:00Z',
    roomId: 'room-1',
    roundId: 'round-1',
    position: 1,
    currentPrice: '180.00',
    currentBidderId: 'ana',
    closedAt: '2026-11-04T15:00:00Z',
    result: 'AWARDED',
    winnerId: 'ana',
    winningAmount: '180.00',
    mode: 'DUTCH',
    entries: [{ kind: 'ITEM', catalogId: 'item-1' }],
    participants: [
      { bidderId: 'ana', bids: 2, bestAmount: '180.00' },
      { bidderId: 'beto', bids: 3, bestAmount: '170.00' },
    ],
    runnerUpAmount: null,
    ...overrides,
  });

  it('el ganador paga lo adjudicado; los demas quedan con su mejor oferta', () => {
    const outcome = roundOutcome(closed(), null);
    expect(outcome.mode).toBe('DUTCH');
    expect(outcome.entry).toEqual({ kind: 'ITEM', catalogId: 'item-1' });
    expect(outcome.participants).toEqual([
      { userId: 'ana', won: true, amount: 180, bids: 2, lastSecondWin: false, perfectSeal: false },
      { userId: 'beto', won: false, amount: 170, bids: 3, lastSecondWin: false, perfectSeal: false },
    ]);
  });

  it('ultimo segundo sale de la traza de la ronda, solo para quien gano', () => {
    const outcome = roundOutcome(closed(), {
      bidders: { ana: { bids: 2, best: 180, lastSecond: true }, beto: { bids: 3, best: 170, lastSecond: true } },
    });
    expect(outcome.participants.map((p) => [p.userId, p.lastSecondWin])).toEqual([
      ['ana', true],
      ['beto', false],
    ]);
  });

  it('sobre perfecto: sobre cerrado ganado por menos de 10 ECICoin sobre el segundo', () => {
    const tight = roundOutcome(closed({ mode: 'SEALED', winningAmount: '4750.00', runnerUpAmount: '4742.50' }), null);
    expect(tight.participants[0].perfectSeal).toBe(true);
    const wide = roundOutcome(closed({ mode: 'SEALED', winningAmount: '4750.00', runnerUpAmount: '4200.00' }), null);
    expect(wide.participants[0].perfectSeal).toBe(false);
    // Sin segundo no hay a quien ganarle por poco.
    expect(roundOutcome(closed({ mode: 'SEALED', runnerUpAmount: null }), null).participants[0].perfectSeal).toBe(false);
  });

  it('un evento anterior sin participantes los saca de la traza, y agrega al ganador si falta', () => {
    const outcome = roundOutcome(closed({ participants: undefined, winnerId: 'carla', winningAmount: '300.00' }), {
      bidders: { beto: { bids: 3, best: 170, lastSecond: false } },
    });
    expect(outcome.participants.map((p) => [p.userId, p.won, p.amount])).toEqual([
      ['beto', false, 170],
      ['carla', true, 300],
    ]);
  });

  it('una ronda desierta no da victorias a nadie', () => {
    const outcome = roundOutcome(closed({ result: 'DESERTED', winnerId: null, currentBidderId: null, participants: [] }), null);
    expect(outcome.participants).toEqual([]);
  });

  it('una puja es de ultimo segundo si llega a 3 s o menos del cierre que tenia la ronda', () => {
    expect(isLastSecondBid({ occurredAt: '2026-11-04T15:00:57.500Z', endsAt: '2026-11-04T15:01:10Z', previousEndsAt: '2026-11-04T15:01:00Z' })).toBe(true);
    expect(isLastSecondBid({ occurredAt: '2026-11-04T15:00:50Z', endsAt: '2026-11-04T15:01:00Z' })).toBe(false);
  });
});
