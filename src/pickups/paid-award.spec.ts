import { expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PAID_AWARD_KEY, parsePaidAward, recordPaidAward } from './paid-award.js';

const envelope = {
  eventId: 'wallet.round.paid:round', eventType: PAID_AWARD_KEY,
  roundId: 'round', roomId: 'room', winnerId: 'winner',
};

it('valida el contrato de Wallet y conserva solo referencias de catálogo válidas', () => {
  expect(parsePaidAward(null)).toBeNull();
  expect(parsePaidAward({ ...envelope, eventId: 'incorrecto' })).toBeNull();
  expect(parsePaidAward({ ...envelope, winnerId: '' })).toBeNull();
  expect(parsePaidAward({
    ...envelope,
    entries: [{ kind: 'ITEM', catalogId: 'headphones' }, null, { kind: 'OTHER', catalogId: 'x' }],
  })?.entries).toEqual([{ kind: 'ITEM', catalogId: 'headphones' }]);
});

it('crea un chat y una notificación privada una sola vez al recibir el cobro', async () => {
  const tx = {
    auctionPickup: { createMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }) },
    pickupMessage: { create: vi.fn() },
    notification: { create: vi.fn() },
  };
  const prisma = { $transaction: async (run: (client: typeof tx) => Promise<void>) => run(tx) };
  const award = parsePaidAward(envelope);
  if (!award) throw new Error('Evento de prueba inválido');
  await recordPaidAward(prisma as unknown as PrismaService, award);
  await recordPaidAward(prisma as unknown as PrismaService, award);
  expect(tx.auctionPickup.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  expect(tx.pickupMessage.create).toHaveBeenCalledOnce();
  expect(tx.notification.create).toHaveBeenCalledExactlyOnceWith({
    data: {
      id: envelope.eventId, eventId: envelope.eventId, roomId: 'room',
      recipientId: 'winner', kind: 'PICKUP_READY', payload: { roundId: 'round' },
    },
  });
});
