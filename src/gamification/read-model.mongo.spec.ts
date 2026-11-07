import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuctionBidAcceptedEvent, AuctionRoundClosedEvent } from '../events/event-contracts.js';
import { MongoService } from './mongo.service.js';
import { GamificationReadModel } from './read-model.js';

/**
 * El modelo de lectura contra un MongoDB de verdad (en CI, el servicio `mongo` del job; en
 * local, cualquier Mongo o un cluster de Atlas de pruebas): `TEST_MONGODB_URL`. Sin esa
 * variable estas pruebas se saltan; las reglas puras tienen las suyas en `rules.spec.ts`.
 */
const url = process.env.TEST_MONGODB_URL;

describe.skipIf(!url)('modelo de lectura de gamificacion (MongoDB)', () => {
  const database = `ecilost_engagement_test_${Date.now()}`;
  const config = { get: (key: string) => ({ MONGODB_URI: url, MONGODB_DB: database })[key] };
  const mongo = new MongoService(config as never);
  const model = new GamificationReadModel(mongo);

  beforeAll(async () => {
    await mongo.database();
  });

  beforeEach(async () => {
    await (await mongo.database()).dropDatabase();
  });

  afterAll(async () => {
    await (await mongo.database()).dropDatabase();
    await mongo.onModuleDestroy();
  });

  const bid = (roundId: string, bidderId: string, amount: number, overrides: Partial<AuctionBidAcceptedEvent> = {}): AuctionBidAcceptedEvent => ({
    eventId: randomUUID(),
    eventType: 'auction.bid.accepted.v1',
    occurredAt: '2026-11-04T15:00:00.000Z',
    roomId: 'room-1',
    roundId,
    position: 1,
    bidId: randomUUID(),
    bidderId,
    amount: String(amount),
    previousBidderId: null,
    previousPrice: null,
    currentBidderId: bidderId,
    currentPrice: String(amount),
    endsAt: '2026-11-04T15:03:00.000Z',
    sequence: '1',
    ...overrides,
  });

  const close = (roundId: string, overrides: Partial<AuctionRoundClosedEvent> = {}): AuctionRoundClosedEvent => ({
    eventId: randomUUID(),
    eventType: 'auction.round.closed.v1',
    occurredAt: '2026-11-04T15:03:00.000Z',
    roomId: 'room-1',
    roundId,
    position: 1,
    currentPrice: '180.00',
    currentBidderId: 'ana',
    closedAt: '2026-11-04T15:03:00.000Z',
    result: 'AWARDED',
    winnerId: 'ana',
    winningAmount: '180.00',
    mode: 'DUTCH',
    entries: [{ kind: 'ITEM', catalogId: `item-${roundId}` }],
    participants: [
      { bidderId: 'ana', bids: 2, bestAmount: '180.00' },
      { bidderId: 'beto', bids: 3, bestAmount: '170.00' },
    ],
    runnerUpAmount: null,
    ...overrides,
  });

  const now = new Date('2026-11-04T16:00:00.000Z');

  it('un cierre deja el perfil, la semana y las medallas de cada participante', async () => {
    await model.recordBid(bid('r1', 'beto', 170));
    // Llega a 2 s del cierre que tenia la ronda: es de ultimo segundo.
    await model.recordBid(bid('r1', 'ana', 180, { occurredAt: '2026-11-04T15:02:58.000Z', endsAt: '2026-11-04T15:03:10.000Z', previousEndsAt: '2026-11-04T15:03:00.000Z' }));
    await model.recordRoundClosed(close('r1'));

    const ana = await model.profile('ana', now);
    expect(ana.stats).toMatchObject({ bids: 2, wins: 1, spent: '180.00', favoriteMode: 'DUTCH', streakWeeks: 1 });
    expect(ana.weeklyRank).toBe(1);
    expect(ana.recent).toEqual([
      expect.objectContaining({ roundId: 'r1', entry: { kind: 'ITEM', catalogId: 'item-r1' }, mode: 'DUTCH', amount: '180.00', result: 'WON' }),
    ]);
    const unlocked = ana.medals.filter((medal) => medal.unlockedAt).map((medal) => medal.id);
    expect(unlocked).toEqual(['FIRST_WIN', 'LAST_SECOND']);
    expect(ana.medals.find((medal) => medal.id === 'DUTCH_KING')).toMatchObject({ progress: 1, goal: 5 });

    const beto = await model.profile('beto', now);
    expect(beto.stats).toMatchObject({ bids: 3, wins: 0, spent: '0.00' });
    expect(beto.recent[0]).toMatchObject({ result: 'LOST', amount: '170.00' });
    // Sin victorias esta semana no aparece en el top.
    expect(beto.weeklyRank).toBeNull();
  });

  it('una reentrega del mismo evento no suma dos veces, ni siquiera en paralelo', async () => {
    const event = close('r1');
    await Promise.all([model.recordRoundClosed(event), model.recordRoundClosed(event), model.recordRoundClosed(event)]);
    await model.recordRoundClosed(event);

    const ana = await model.profile('ana', now);
    expect(ana.stats.wins).toBe(1);
    expect(ana.stats.bids).toBe(2);
    expect(ana.recent).toHaveLength(1);
    const board = await model.leaderboard('ana', 'current', now);
    expect(board.entries).toEqual([expect.objectContaining({ alias: ana.alias, wins: 1, bids: 2, mine: true })]);
  });

  it('el top ordena por victorias y, en empate, por quien gasto menos; y ubica a quien mira', async () => {
    await model.recordRoundClosed(close('r1', { winnerId: 'ana', winningAmount: '300.00', participants: [{ bidderId: 'ana', bids: 1, bestAmount: '300.00' }] }));
    await model.recordRoundClosed(close('r2', { winnerId: 'beto', winningAmount: '100.00', participants: [{ bidderId: 'beto', bids: 1, bestAmount: '100.00' }] }));
    await model.recordRoundClosed(close('r3', { winnerId: 'carla', winningAmount: '50.00', participants: [{ bidderId: 'carla', bids: 1, bestAmount: '50.00' }] }));
    await model.recordRoundClosed(close('r4', { winnerId: 'carla', winningAmount: '50.00', participants: [{ bidderId: 'carla', bids: 1, bestAmount: '50.00' }] }));

    const board = await model.leaderboard('ana', 'current', now);
    expect(board.from).toBe('2026-11-02');
    expect(board.entries.map((entry) => [entry.rank, entry.wins, entry.spent, entry.mine])).toEqual([
      [1, 2, '100.00', false],
      [2, 1, '100.00', false],
      [3, 1, '300.00', true],
    ]);
    expect(board.me).toMatchObject({ rank: 3, mine: true });
    // Cada entrada luce sus medallas; nunca un id ni un nombre.
    expect(board.entries[0].badges).toContain('FIRST_WIN');
    expect(JSON.stringify(board)).not.toContain('carla');
  });

  it('el primer cierre de la semana siguiente premia el podio de la anterior, una sola vez', async () => {
    await model.recordRoundClosed(close('r1'));
    const nextWeek = { closedAt: '2026-11-10T15:00:00.000Z', occurredAt: '2026-11-10T15:00:00.000Z' };
    await model.recordRoundClosed(close('r2', { ...nextWeek, winnerId: 'beto', participants: [{ bidderId: 'beto', bids: 1, bestAmount: '180.00' }] }));
    await model.recordRoundClosed(close('r3', { ...nextWeek, winnerId: 'beto', participants: [{ bidderId: 'beto', bids: 1, bestAmount: '180.00' }] }));

    const ana = await model.profile('ana', new Date('2026-11-10T16:00:00Z'));
    expect(ana.medals.find((medal) => medal.id === 'WEEKLY_PODIUM')).toMatchObject({ progress: 1 });
    expect(ana.medals.find((medal) => medal.id === 'WEEKLY_PODIUM')?.unlockedAt).not.toBeNull();
    const profiles = await mongo.profiles();
    expect((await profiles.findOne({ _id: 'ana' }))?.podiumWeeks).toEqual(['2026-11-02']);
  });

  it('las medallas para el chat salen del perfil, y quien no tiene perfil recibe uno vacio', async () => {
    await model.recordRoundClosed(close('r1'));
    expect(await model.badgesFor(['ana', 'beto', 'nadie'])).toEqual({ ana: ['FIRST_WIN'], beto: [] });

    const empty = await model.profile('nadie', now);
    expect(empty.stats).toEqual({ bids: 0, wins: 0, spent: '0.00', streakWeeks: 0, favoriteMode: null, favoriteModeBids: 0 });
    expect(empty.medals).toHaveLength(8);
    expect(empty.alias).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
  });
});
