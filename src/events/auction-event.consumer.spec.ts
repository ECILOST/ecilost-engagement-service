import { describe, expect, it, vi } from 'vitest';
import { AuctionEventConsumer } from './auction-event.consumer.js';

const occurredAt = '2030-01-01T10:00:00.000Z';
const bidAccepted = (overrides: Record<string, unknown> = {}) => ({
  eventId: 'bid-2',
  eventType: 'auction.bid.accepted.v1',
  occurredAt,
  roomId: 'room',
  roundId: 'round',
  position: 1,
  bidId: 'bid-2',
  bidderId: 'bob',
  amount: '20.00',
  previousBidderId: 'alice',
  previousPrice: '10.00',
  currentBidderId: 'bob',
  currentPrice: '20.00',
  endsAt: '2030-01-01T10:03:10.000Z',
  sequence: '2',
  ...overrides,
});
const roundClosed = {
  eventId: 'closed-1',
  eventType: 'auction.round.closed.v1',
  occurredAt,
  roomId: 'room',
  roundId: 'round',
  position: 1,
  currentPrice: '20.00',
  currentBidderId: 'bob',
  closedAt: occurredAt,
};

function setup() {
  const prisma = {
    consumedEvent: { createMany: vi.fn().mockResolvedValue({ count: 1 }), update: vi.fn().mockResolvedValue({}) },
    notification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const realtime = { publish: vi.fn() };
  const channel = { ack: vi.fn(), nack: vi.fn() };
  const consumer = new AuctionEventConsumer({} as never, prisma as never, realtime as never);
  (consumer as unknown as { channel: typeof channel }).channel = channel;
  const deliver = (body: unknown) =>
    (consumer as unknown as { captureEvent: (message: unknown) => Promise<void> }).captureEvent({
      content: Buffer.from(JSON.stringify(body)),
      properties: { messageId: (body as { eventId?: string }).eventId },
    });
  const notified = () => prisma.notification.createMany.mock.calls.flatMap(([{ data }]) => data as Array<Record<string, unknown>>);
  return { prisma, realtime, channel, deliver, notified };
}

describe('AuctionEventConsumer', () => {
  it('notifica al participante superado y empuja el nuevo precio a la sala', async () => {
    const { realtime, channel, deliver, notified } = setup();
    await deliver(bidAccepted());
    expect(notified()).toEqual([expect.objectContaining({ kind: 'OUTBID', recipientId: 'alice', roomId: 'room' })]);
    expect(realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'bid-2', currentPrice: '20.00' }));
    expect(channel.ack).toHaveBeenCalledOnce();
  });

  it('no notifica superacion en la primera puja ni cuando el lider mejora su propia puja', async () => {
    for (const previousBidderId of [null, 'bob']) {
      const { prisma, realtime, deliver } = setup();
      await deliver(bidAccepted({ previousBidderId, previousPrice: previousBidderId ? '10.00' : null }));
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
      // El precio igual se actualiza en vivo para toda la sala.
      expect(realtime.publish).toHaveBeenCalledOnce();
    }
  });

  it('el cierre adjudicado avisa a la sala y, aparte, al ganador', async () => {
    const { realtime, deliver, notified } = setup();
    await deliver({ ...roundClosed, result: 'AWARDED', winnerId: 'bob', winningAmount: '20.00' });
    expect(notified()).toEqual([
      expect.objectContaining({ kind: 'ROUND_CLOSED', recipientId: null }),
      expect.objectContaining({ kind: 'ROUND_WON', recipientId: 'bob' }),
    ]);
    expect(realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'auction.round.closed.v1' }));
  });

  it('una ronda desierta solo avisa el cierre, y los eventos viejos sin result se deducen del lider', async () => {
    const deserted = setup();
    await deserted.deliver({ ...roundClosed, currentBidderId: null });
    expect(deserted.notified().map((n) => n.kind)).toEqual(['ROUND_CLOSED']);

    const legacy = setup();
    await legacy.deliver(roundClosed);
    expect(legacy.notified().map((n) => n.kind)).toEqual(['ROUND_CLOSED', 'ROUND_WON']);
  });

  it('empuja la transicion de ronda sin crear notificacion', async () => {
    const { prisma, realtime, deliver } = setup();
    await deliver({
      eventId: 'activated-2',
      eventType: 'auction.round.activated.v1',
      occurredAt,
      roomId: 'room',
      roundId: 'round-2',
      position: 2,
      currentPrice: '0',
      startedAt: occurredAt,
      endsAt: '2030-01-01T10:03:00.000Z',
      entries: [],
    });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ roundId: 'round-2', position: 2 }));
  });

  it('empuja a la sala antes de terminar de escribir en la base', async () => {
    const { prisma, realtime, deliver } = setup();
    let finishWrite: () => void = () => undefined;
    prisma.consumedEvent.createMany.mockReturnValue(new Promise((resolve) => { finishWrite = () => resolve({ count: 1 }); }));

    const pending = deliver(bidAccepted());
    expect(realtime.publish).toHaveBeenCalledOnce();

    finishWrite();
    await pending;
  });

  it('una reentrega no se reemite a los clientes y la base la absorbe por su llave', async () => {
    const { prisma, realtime, channel, deliver } = setup();
    await deliver(bidAccepted());
    await deliver(bidAccepted());
    expect(realtime.publish).toHaveBeenCalledOnce();
    // Sin transaccion: la segunda escritura se ignora por la llave unica.
    expect(prisma.notification.createMany).toHaveBeenLastCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(channel.ack).toHaveBeenCalledTimes(2);
  });

  it('si la base falla, la sala ya tiene el precio y el mensaje va a la DLQ', async () => {
    const { prisma, realtime, channel, deliver } = setup();
    prisma.consumedEvent.createMany.mockRejectedValue(new Error('db caida'));
    await deliver(bidAccepted());
    expect(realtime.publish).toHaveBeenCalledOnce();
    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('manda a la DLQ un evento malformado sin tocar la base ni los clientes', async () => {
    const { prisma, realtime, channel, deliver } = setup();
    await deliver({ ...roundClosed, closedAt: undefined });
    expect(channel.nack).toHaveBeenCalledOnce();
    expect(prisma.consumedEvent.createMany).not.toHaveBeenCalled();
    expect(realtime.publish).not.toHaveBeenCalled();
  });
});
