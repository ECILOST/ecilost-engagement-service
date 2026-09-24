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

function setup(alreadyProcessed = false) {
  const tx = {
    consumedEvent: {
      createMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ eventId: 'x', processedAt: alreadyProcessed ? new Date() : null }),
      update: vi.fn(),
    },
    notification: { create: vi.fn() },
  };
  const prisma = { $transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx) };
  const realtime = { publish: vi.fn() };
  const channel = { ack: vi.fn(), nack: vi.fn() };
  const consumer = new AuctionEventConsumer({} as never, prisma as never, realtime as never);
  (consumer as unknown as { channel: typeof channel }).channel = channel;
  const deliver = (body: unknown) =>
    (consumer as unknown as { captureEvent: (message: unknown) => Promise<void> }).captureEvent({
      content: Buffer.from(JSON.stringify(body)),
      properties: { messageId: (body as { eventId?: string }).eventId },
    });
  return { tx, realtime, channel, deliver };
}

describe('AuctionEventConsumer', () => {
  it('notifica al participante superado y empuja el nuevo precio a la sala', async () => {
    const { tx, realtime, channel, deliver } = setup();
    await deliver(bidAccepted());
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'OUTBID', recipientId: 'alice', roomId: 'room' }),
    });
    expect(realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'bid-2', currentPrice: '20.00' }));
    expect(channel.ack).toHaveBeenCalledOnce();
  });

  it('no notifica superacion en la primera puja ni cuando el lider mejora su propia puja', async () => {
    for (const previousBidderId of [null, 'bob']) {
      const { tx, realtime, deliver } = setup();
      await deliver(bidAccepted({ previousBidderId, previousPrice: previousBidderId ? '10.00' : null }));
      expect(tx.notification.create).not.toHaveBeenCalled();
      // El precio igual se actualiza en vivo para toda la sala.
      expect(realtime.publish).toHaveBeenCalledOnce();
    }
  });

  it('entrega el cierre de ronda a toda la sala', async () => {
    const { tx, realtime, deliver } = setup();
    await deliver(roundClosed);
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'ROUND_CLOSED', recipientId: null }),
    });
    expect(realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'auction.round.closed.v1' }));
  });

  it('empuja la transicion de ronda sin crear notificacion', async () => {
    const { tx, realtime, deliver } = setup();
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
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(realtime.publish).toHaveBeenCalledWith(expect.objectContaining({ roundId: 'round-2', position: 2 }));
  });

  it('no repite la notificacion ni el aviso en vivo cuando RabbitMQ reentrega el evento', async () => {
    const { tx, realtime, channel, deliver } = setup(true);
    await deliver(bidAccepted());
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(realtime.publish).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledOnce();
  });

  it('manda a la DLQ un evento malformado sin tocar la base ni los clientes', async () => {
    const { tx, realtime, channel, deliver } = setup();
    await deliver({ ...roundClosed, closedAt: undefined });
    expect(channel.nack).toHaveBeenCalledOnce();
    expect(tx.consumedEvent.createMany).not.toHaveBeenCalled();
    expect(realtime.publish).not.toHaveBeenCalled();
  });
});
