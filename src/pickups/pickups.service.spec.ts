import { expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { PickupsService } from './pickups.service.js';

function setup() {
  const now = Date.now();
  const slot = {
    id: 'slot', location: 'Recepción', capacity: 1, _count: { pickups: 0 },
    startsAt: new Date(now + 60_000), endsAt: new Date(now + 120_000),
  };
  const pickup = {
    roundId: 'round', winnerId: 'winner', status: 'PENDING',
    slotId: null as string | null, slot: null as typeof slot | null,
    deliveryCodeHash: null as string | null,
  };
  const db = {
    auctionPickup: {
      findMany: vi.fn().mockResolvedValue([pickup]),
      findFirst: vi.fn().mockResolvedValue(pickup),
      update: vi.fn(async ({ data }) => Object.assign(pickup, data)),
    },
    pickupSlot: {
      findMany: vi.fn().mockResolvedValue([slot, { ...slot, _count: { pickups: 1 } }]),
      findUnique: vi.fn().mockResolvedValue(slot),
      create: vi.fn(),
    },
    pickupMessage: { create: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return { service: new PickupsService(db as unknown as PrismaService), db, slot, pickup };
}

it('limita el historial al ganador y excluye el hash de entrega', async () => {
  const { service, db } = setup();
  await service.list('winner');
  expect(db.auctionPickup.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { winnerId: 'winner' } }));
  await service.conversation('round', 'winner');
  const [query] = db.auctionPickup.findFirst.mock.calls[0];
  expect(query.where).toEqual({ roundId: 'round', winnerId: 'winner' });
  expect(query.select).not.toHaveProperty('deliveryCodeHash');
  db.auctionPickup.findFirst.mockResolvedValueOnce(null);
  await expect(service.conversation('round', 'other')).rejects.toThrow('No se encontró');
});

it('valida y ofrece únicamente horarios con cupo', async () => {
  const { service, db, slot } = setup();
  expect(await service.availableSlots()).toEqual([expect.objectContaining({ id: 'slot', available: 1 })]);
  await expect(service.createSlot({ capacity: 0 })).rejects.toThrow('franja futura');
  await service.createSlot({
    location: ' Recepción ', startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), capacity: 1,
  });
  expect(db.pickupSlot.create).toHaveBeenCalledWith({
    data: { location: 'Recepción', startsAt: slot.startsAt, endsAt: slot.endsAt, capacity: 1 },
  });
});

it('rechaza un horario lleno y confirma la reserva una sola vez', async () => {
  const { service, db, slot, pickup } = setup();
  db.pickupSlot.findUnique.mockResolvedValueOnce({ ...slot, _count: { pickups: 1 } });
  await expect(service.book('round', 'winner', 'slot')).rejects.toThrow('Se agotaron los cupos');
  await service.book('round', 'winner', 'slot');
  await service.book('round', 'winner', 'slot');
  expect(db.auctionPickup.update).toHaveBeenCalledOnce();
  expect(pickup).toMatchObject({ slotId: 'slot', status: 'BOOKED' });
  expect(db.pickupMessage.create).toHaveBeenCalledWith({
    data: { roundId: 'round', author: 'BOT', body: expect.stringContaining('Recepción') },
  });
});

it('conserva la cita cuando el personal responde y permite registrar una inasistencia vencida', async () => {
  const { service, db, slot, pickup } = setup();
  Object.assign(pickup, { status: 'BOOKED', slotId: 'slot', slot });
  await service.help('round', 'winner', ' ¿Dónde es? ');
  expect(pickup.status).toBe('NEEDS_HELP');
  expect(db.pickupMessage.create).toHaveBeenCalledWith({ data: { roundId: 'round', author: 'WINNER', body: '¿Dónde es?' } });
  await service.reply('round', 'En recepción');
  expect(pickup.status).toBe('BOOKED');
  await expect(service.markMissed('round')).rejects.toThrow('cuando termina');
  pickup.slot = { ...slot, endsAt: new Date(0) };
  await service.markMissed('round');
  expect(pickup).toMatchObject({ status: 'PENDING', slotId: null });
});

it('acepta el código una vez durante la cita y registra al funcionario', async () => {
  const { service, slot, pickup } = setup();
  await expect(service.issueCode('round', 'winner')).rejects.toThrow('reserva vigente');
  Object.assign(pickup, { status: 'BOOKED', slotId: 'slot', slot });
  const { code } = await service.issueCode('round', 'winner');
  expect(pickup.deliveryCodeHash).toMatch(/^[a-f0-9]{64}$/);
  await expect(service.deliver('round', 'operator', code)).rejects.toThrow('en curso');
  pickup.slot = { ...slot, startsAt: new Date(0) };
  const wrongCode = (code[0] === 'A' ? 'B' : 'A') + code.slice(1);
  await expect(service.deliver('round', 'operator', wrongCode)).rejects.toThrow('Código inválido');
  await service.deliver('round', 'operator', code);
  expect(pickup).toMatchObject({ status: 'DELIVERED', deliveredBy: 'operator', deliveryCodeHash: null });
  await expect(service.deliver('round', 'operator', code)).rejects.toThrow('ya fue confirmada');
});
