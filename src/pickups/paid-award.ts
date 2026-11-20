import type { PrismaService } from '../prisma/prisma.service.js';

export const PAID_AWARD_KEY = 'wallet.round.paid.v1';

type Entry = { kind: 'ITEM' | 'LOT'; catalogId: string };
type PaidAward = {
  eventId: string;
  roundId: string;
  roomId: string;
  winnerId: string;
  entries: Entry[];
};

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;

export function parsePaidAward(input: unknown): PaidAward | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (value.eventType !== PAID_AWARD_KEY || !isId(value.roundId) || !isId(value.roomId) ||
      !isId(value.winnerId) || value.eventId !== `wallet.round.paid:${value.roundId}`) return null;

  const entries = Array.isArray(value.entries) ? value.entries.flatMap((entry: unknown): Entry[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { kind, catalogId } = entry as Record<string, unknown>;
    return (kind === 'ITEM' || kind === 'LOT') && isId(catalogId) ? [{ kind, catalogId }] : [];
  }) : [];

  return { eventId: value.eventId, roundId: value.roundId, roomId: value.roomId, winnerId: value.winnerId, entries };
}

export async function recordPaidAward(prisma: PrismaService, award: PaidAward): Promise<void> {
  const { eventId, roundId, roomId, winnerId, entries } = award;
  await prisma.$transaction(async (tx) => {
    const created = await tx.auctionPickup.createMany({
      data: { roundId, roomId, winnerId, entries },
      skipDuplicates: true,
    });
    if (!created.count) return;

    await tx.pickupMessage.create({
      data: {
        roundId, author: 'BOT',
        body: '¡Ganaste la subasta! El pago está confirmado. Elige un horario para recoger tu adjudicación.',
      },
    });
    await tx.notification.create({
      data: {
        id: eventId, eventId, roomId, recipientId: winnerId, kind: 'PICKUP_READY',
        payload: { roundId },
      },
    });
  });
}
