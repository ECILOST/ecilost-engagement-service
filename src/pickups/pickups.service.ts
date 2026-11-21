import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const pickupFields = {
  roundId: true, roomId: true, entries: true, winnerId: true, status: true,
  slot: true, deliveredAt: true, createdAt: true,
} satisfies Prisma.AuctionPickupSelect;

function messageText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 500) {
    throw new BadRequestException('Escribe un mensaje de entre 1 y 500 caracteres.');
  }
  return value.trim();
}

const hashCode = (value: string) => createHash('sha256').update(value).digest();

@Injectable()
export class PickupsService {
  constructor(private readonly prisma: PrismaService) {}

  list(winnerId?: string) {
    return this.prisma.auctionPickup.findMany({
      where: { winnerId }, select: pickupFields,
      orderBy: [{ deliveredAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }, { roundId: 'asc' }],
    });
  }

  async conversation(roundId: string, winnerId?: string) {
    const pickup = await this.prisma.auctionPickup.findFirst({
      where: { roundId, winnerId },
      select: {
        ...pickupFields,
        messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, author: true, body: true, createdAt: true } },
      },
    });
    if (!pickup) throw new NotFoundException('No se encontró la recogida.');
    return pickup;
  }

  async availableSlots() {
    const slots = await this.staffSlots();
    return slots.filter((slot) => slot.available > 0);
  }

  async staffSlots() {
    const slots = await this.prisma.pickupSlot.findMany({
      where: { startsAt: { gt: new Date() } }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { pickups: true } } },
    });
    return slots.map(({ _count, ...slot }) => ({ ...slot, available: slot.capacity - _count.pickups }));
  }

  async createSlot(input: unknown) {
    const { location, startsAt, endsAt, capacity } = (input ?? {}) as Record<string, unknown>;
    const start = typeof startsAt === 'string' ? new Date(startsAt) : new Date(Number.NaN);
    const end = typeof endsAt === 'string' ? new Date(endsAt) : new Date(Number.NaN);
    if (typeof location !== 'string' || !location.trim() || location.trim().length > 160 ||
      !(start.getTime() > Date.now() && end.getTime() > start.getTime()) ||
      typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > 500) {
      throw new BadRequestException('Indica un lugar, una franja futura válida y entre 1 y 500 cupos.');
    }
    try {
      return await this.prisma.pickupSlot.create({
        data: { location: location.trim(), startsAt: start, endsAt: end, capacity },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Ese horario ya está registrado.');
      }
      throw error;
    }
  }

  async book(roundId: string, winnerId: string, slotId: unknown) {
    if (typeof slotId !== 'string' || !slotId || slotId.length > 128) {
      throw new BadRequestException('Elige un horario.');
    }
    await this.prisma.$transaction(async (tx) => {
      const pickup = await this.lockPickup(tx, roundId, winnerId);
      if (pickup.slotId === slotId && pickup.status === 'BOOKED') return;
      if (pickup.status === 'NEEDS_HELP') throw new ConflictException('Espera la respuesta del personal antes de cambiar la reserva.');

      await tx.$queryRaw`SELECT id FROM pickup_slots WHERE id = ${slotId} FOR UPDATE`;
      const slot = await tx.pickupSlot.findUnique({
        where: { id: slotId }, include: { _count: { select: { pickups: true } } },
      });
      if (!slot || slot.startsAt.getTime() <= Date.now()) throw new ConflictException('Ese horario ya no está disponible.');
      if (slot._count.pickups - Number(pickup.slotId === slotId) >= slot.capacity) {
        throw new ConflictException('Se agotaron los cupos de ese horario.');
      }
      await tx.auctionPickup.update({
        where: { roundId },
        data: { status: 'BOOKED', slotId, deliveryCodeHash: null },
      });
      const schedule = new Intl.DateTimeFormat('es-CO', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Bogota',
      });
      await tx.pickupMessage.create({
        data: {
          roundId, author: 'BOT',
          body: `Recogida confirmada en ${slot.location}, de ${schedule.format(slot.startsAt)} a ${schedule.format(slot.endsAt)} (hora de Colombia). Genera tu código y muéstralo al personal.`,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    return this.conversation(roundId, winnerId);
  }

  async help(roundId: string, winnerId: string, input: unknown) {
    const body = messageText(input);
    await this.prisma.$transaction(async (tx) => {
      const pickup = await this.lockPickup(tx, roundId, winnerId);
      await tx.pickupMessage.create({ data: { roundId, author: 'WINNER', body } });
      if (pickup.status !== 'NEEDS_HELP') {
        await tx.auctionPickup.update({ where: { roundId }, data: { status: 'NEEDS_HELP', deliveryCodeHash: null } });
        await tx.pickupMessage.create({
          data: { roundId, author: 'BOT', body: 'Envié tu solicitud al personal. Puedes ver la respuesta en esta conversación.' },
        });
      }
    });
    return this.conversation(roundId, winnerId);
  }

  async reply(roundId: string, input: unknown) {
    const body = messageText(input);
    await this.prisma.$transaction(async (tx) => {
      const pickup = await this.lockPickup(tx, roundId);
      if (pickup.status !== 'NEEDS_HELP') throw new ConflictException('La recogida no tiene una solicitud pendiente.');
      await tx.pickupMessage.create({ data: { roundId, author: 'STAFF', body } });
      await tx.auctionPickup.update({
        where: { roundId }, data: { status: pickup.slotId ? 'BOOKED' : 'PENDING' },
      });
    });
    return this.conversation(roundId);
  }

  async markMissed(roundId: string) {
    await this.prisma.$transaction(async (tx) => {
      const pickup = await this.lockPickup(tx, roundId);
      if (pickup.status !== 'BOOKED' || !pickup.slot || pickup.slot.endsAt.getTime() > Date.now()) {
        throw new ConflictException('La inasistencia solo se registra cuando termina una reserva.');
      }
      await tx.auctionPickup.update({
        where: { roundId },
        data: { status: 'PENDING', slotId: null, deliveryCodeHash: null },
      });
      await tx.pickupMessage.create({
        data: { roundId, author: 'BOT', body: 'El personal registró que no se completó la recogida. Puedes elegir otro horario.' },
      });
    });
    return this.conversation(roundId);
  }

  async issueCode(roundId: string, winnerId: string) {
    const code = randomBytes(12).toString('base64url');
    await this.prisma.$transaction(async (tx) => {
      const pickup = await this.lockPickup(tx, roundId, winnerId);
      if (pickup.status !== 'BOOKED' || !pickup.slot || pickup.slot.endsAt.getTime() <= Date.now()) {
        throw new ConflictException('Necesitas una reserva vigente para generar el código.');
      }
      await tx.auctionPickup.update({ where: { roundId }, data: { deliveryCodeHash: hashCode(code).toString('hex') } });
    });
    return { code };
  }

  async deliver(roundId: string, staffId: string, input: unknown) {
    if (typeof input !== 'string' || !/^[\w-]{16}$/.test(input.trim())) throw new BadRequestException('Código inválido.');
    await this.prisma.$transaction(async (tx) => {
      const pickup = await this.lockPickup(tx, roundId);
      const now = new Date();
      if (pickup.status !== 'BOOKED' || !pickup.slot || !pickup.deliveryCodeHash ||
        now < pickup.slot.startsAt || now >= pickup.slot.endsAt) {
        throw new ConflictException('La reserva debe estar en curso y tener un código vigente.');
      }
      if (!timingSafeEqual(hashCode(input.trim()), Buffer.from(pickup.deliveryCodeHash, 'hex'))) {
        throw new BadRequestException('Código inválido.');
      }
      await tx.auctionPickup.update({
        where: { roundId },
        data: { status: 'DELIVERED', deliveredAt: now, deliveredBy: staffId, deliveryCodeHash: null },
      });
      await tx.pickupMessage.create({
        data: { roundId, author: 'BOT', body: 'El personal confirmó la entrega de tu adjudicación.' },
      });
    });
    return this.conversation(roundId);
  }

  private async lockPickup(tx: Prisma.TransactionClient, roundId: string, winnerId?: string) {
    // Toma el bloqueo antes de leer el estado. Reservar también bloquea la
    // franja de destino consuma o libere cupo en la misma transacción.
    await tx.$queryRaw`SELECT "roundId" FROM auction_pickups WHERE "roundId" = ${roundId}
      AND (${winnerId ?? null}::text IS NULL OR "winnerId" = ${winnerId ?? null}) FOR UPDATE`;
    const pickup = await tx.auctionPickup.findFirst({ where: { roundId, winnerId }, include: { slot: true } });
    if (!pickup) throw new NotFoundException('No se encontró la recogida.');
    if (pickup.status === 'DELIVERED') throw new ConflictException('La entrega ya fue confirmada.');
    return pickup;
  }
}
