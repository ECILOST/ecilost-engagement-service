import { describe, expect, it, vi } from 'vitest';
import { GamificationConsumer, parseGamificationEvent } from './gamification.consumer.js';

const message = (body: unknown) => ({ content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) }) as never;

const closed = {
  eventId: 'e-1',
  eventType: 'auction.round.closed.v1',
  occurredAt: '2026-11-04T15:00:00Z',
  roomId: 'room',
  roundId: 'round',
  position: 1,
  currentPrice: '10',
  currentBidderId: 'ana',
  closedAt: '2026-11-04T15:00:00Z',
  participants: [{ bidderId: 'ana', bids: 1, bestAmount: '10' }],
};

function setup(readModel: Record<string, unknown>) {
  const consumer = new GamificationConsumer({ get: () => undefined } as never, { enabled: true, ...readModel } as never);
  consumer.retryDelayMs = 0;
  const channel = { ack: vi.fn(), nack: vi.fn() };
  return { consumer, channel };
}

describe('GamificationConsumer', () => {
  it('valida lo que lee: participantes bien formados y fechas validas', () => {
    expect(parseGamificationEvent(closed)).not.toBeNull();
    expect(parseGamificationEvent({ ...closed, participants: [{ bidderId: 'ana' }] })).toBeNull();
    expect(parseGamificationEvent({ ...closed, closedAt: 'ayer' })).toBeNull();
    expect(parseGamificationEvent({ ...closed, eventType: 'auction.round.activated.v1' })).toBeNull();
  });

  it('aplica el cierre y confirma', async () => {
    const recordRoundClosed = vi.fn().mockResolvedValue(undefined);
    const { consumer, channel } = setup({ recordRoundClosed });
    await consumer.handle(message(closed), channel);
    expect(recordRoundClosed).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'e-1' }));
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('un evento ilegible va a la cola de muertos', async () => {
    const { consumer, channel } = setup({});
    await consumer.handle(message('{no es json'), channel);
    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
  });

  it('si Mongo falla, el evento vuelve a la cola: perderlo dejaria el perfil mal', async () => {
    const { consumer, channel } = setup({ recordRoundClosed: vi.fn().mockRejectedValue(new Error('atlas caido')) });
    await consumer.handle(message(closed), channel);
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
  });
});
