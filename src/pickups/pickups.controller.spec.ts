import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import type { TokenVerifier } from '../realtime/token-verifier.js';
import { PickupsController } from './pickups.controller.js';
import type { PickupsService } from './pickups.service.js';

function setup() {
  const tokens = {
    verifyClaims: vi.fn(async (token: string) => {
      if (token === 'student') return { userId: 'winner', role: 'STUDENT' };
      if (token === 'staff') return { userId: 'operator', role: 'STAFF' };
      return null;
    }),
  };
  const service = {
    list: vi.fn(), conversation: vi.fn(), availableSlots: vi.fn(), book: vi.fn(),
    issueCode: vi.fn(), help: vi.fn(), staffSlots: vi.fn(), createSlot: vi.fn(),
    reply: vi.fn(), markMissed: vi.fn(), deliver: vi.fn(),
  };
  const controller = new PickupsController(tokens as unknown as TokenVerifier, service as unknown as PickupsService);
  return { controller, service };
}

it('rechaza solicitudes sin identidad válida y bloquea cada grupo de rutas al otro rol', async () => {
  const { controller, service } = setup();
  await expect(controller.mine()).rejects.toBeInstanceOf(UnauthorizedException);
  await expect(controller.mine('Bearer invalid')).rejects.toBeInstanceOf(UnauthorizedException);
  await expect(controller.staff('Bearer student')).rejects.toBeInstanceOf(ForbiddenException);
  await expect(controller.book('Bearer staff', 'round', 'slot')).rejects.toBeInstanceOf(ForbiddenException);
  expect(service.list).not.toHaveBeenCalled();
  expect(service.book).not.toHaveBeenCalled();
});

it('propaga al servicio la identidad del ganador autenticado', async () => {
  const { controller, service } = setup();
  const auth = 'Bearer student';
  await controller.mine(auth);
  await controller.conversation(auth, 'round');
  await controller.slots(auth);
  await controller.book(auth, 'round', 'slot');
  await controller.code(auth, 'round');
  await controller.help(auth, 'round', '¿Dónde retiro?');
  expect(service.list).toHaveBeenCalledWith('winner');
  expect(service.conversation).toHaveBeenCalledWith('round', 'winner');
  expect(service.availableSlots).toHaveBeenCalledOnce();
  expect(service.book).toHaveBeenCalledWith('round', 'winner', 'slot');
  expect(service.issueCode).toHaveBeenCalledWith('round', 'winner');
  expect(service.help).toHaveBeenCalledWith('round', 'winner', '¿Dónde retiro?');
});

it('permite al personal coordinar las citas y registra su identidad al entregar', async () => {
  const { controller, service } = setup();
  const auth = 'Bearer staff';
  const slot = { location: 'Recepción', capacity: 1 };
  await controller.staff(auth);
  await controller.staffSlots(auth);
  await controller.createSlot(auth, slot);
  await controller.staffConversation(auth, 'round');
  await controller.reply(auth, 'round', 'En recepción');
  await controller.missed(auth, 'round');
  await controller.deliver(auth, 'round', 'code');
  expect(service.list).toHaveBeenCalledWith();
  expect(service.staffSlots).toHaveBeenCalledOnce();
  expect(service.createSlot).toHaveBeenCalledWith(slot);
  expect(service.conversation).toHaveBeenCalledWith('round');
  expect(service.reply).toHaveBeenCalledWith('round', 'En recepción');
  expect(service.markMissed).toHaveBeenCalledWith('round');
  expect(service.deliver).toHaveBeenCalledWith('round', 'operator', 'code');
});
