import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomLookup, RoomMembership } from '../realtime/room-access.js';
import { chatAlias, MIN_SEND_INTERVAL_MS } from './chat-rules.js';
import { CHAT_HISTORY_SIZE, ChatGateway, ROOM_STATUS_TTL_MS } from './chat.gateway.js';

const ROOM = '0b8f3c1e-5d2a-4c7b-9e1f-2a3b4c5d6e7f';
const at = (second: number) => new Date(Date.UTC(2026, 9, 30, 15, 0, second));

const participant: RoomMembership = { status: 'ACTIVE', isParticipant: true, isOwner: false };
const granted = (room: Partial<RoomMembership> = {}): RoomLookup => ({ access: 'granted', room: { ...participant, ...room } });

/** Una conexion ya autenticada como alice, y el gateway con auth, auction y base de mentira. */
function setup({ lookup = granted(), tokenOwner = 'alice' as string | null } = {}) {
  const verify = vi.fn().mockResolvedValue(tokenOwner);
  const lookupRoom = vi.fn().mockResolvedValue(lookup);
  const findMany = vi.fn().mockResolvedValue([]);
  const create = vi.fn(async ({ data }: { data: { id: string; roomId: string; body: string } }) => ({
    id: data.id, roomId: data.roomId, body: data.body, createdAt: at(30),
  }));
  const gateway = new ChatGateway({ verify } as never, { lookup: lookupRoom } as never, { chatMessage: { findMany, create } } as never);
  let now = 0;
  gateway.now = () => now;

  const emitted: Array<{ channel: string; name: string; payload: Record<string, unknown> }> = [];
  Object.assign(gateway, {
    server: { to: (channel: string) => ({ emit: (name: string, payload: Record<string, unknown>) => emitted.push({ channel, name, payload }) }) },
  });

  const client = {
    rooms: new Set<string>(['socket-id', 'user:alice']),
    data: { userId: 'alice' } as Record<string, unknown>,
    handshake: { auth: { token: 'handshake-jwt' } },
    join: vi.fn(async (channel: string) => { client.rooms.add(channel); }),
    leave: vi.fn(async (channel: string) => { client.rooms.delete(channel); }),
  };
  const join = (body: unknown = { roomId: ROOM, token: 'jwt' }) => gateway.joinChat(client as never, body as never);
  const send = (text: unknown, body: Record<string, unknown> = {}) =>
    gateway.sendMessage(client as never, { roomId: ROOM, text, token: 'jwt', ...body } as never);
  const advance = (ms: number) => { now += ms; };
  return { gateway, verify, lookupRoom, findMany, create, client, join, send, emitted, advance };
}

describe('ChatGateway chat.join', () => {
  beforeEach(() => { vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });

  it('el participante entra al chat de la sala en curso y recibe historial, alias y permiso de escribir', async () => {
    const { lookupRoom, findMany, client, join } = setup();
    findMany.mockResolvedValue([
      { id: 'm2', roomId: ROOM, authorId: 'bob', body: 'segundo', createdAt: at(2) },
      { id: 'm1', roomId: ROOM, authorId: 'alice', body: 'primero', createdAt: at(1) },
    ]);
    const response = await join();
    expect(lookupRoom).toHaveBeenCalledWith(ROOM, 'jwt');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { roomId: ROOM }, take: CHAT_HISTORY_SIZE }));
    expect(client.join).toHaveBeenCalledWith(`chat:${ROOM}`);
    expect(response).toEqual({
      ok: true,
      roomId: ROOM,
      alias: chatAlias(ROOM, 'alice'),
      canWrite: true,
      messages: [
        { id: 'm1', roomId: ROOM, alias: chatAlias(ROOM, 'alice'), body: 'primero', createdAt: at(1).toISOString() },
        { id: 'm2', roomId: ROOM, alias: chatAlias(ROOM, 'bob'), body: 'segundo', createdAt: at(2).toISOString() },
      ],
    });
    expect(JSON.stringify(response)).not.toContain('bob');
  });

  it('el funcionario dueño entra a leer, sin alias y sin poder escribir', async () => {
    const { client, join } = setup({ lookup: granted({ isParticipant: false, isOwner: true }) });
    await expect(join()).resolves.toMatchObject({ ok: true, alias: null, canWrite: false });
    expect(client.join).toHaveBeenCalledWith(`chat:${ROOM}`);
  });

  it('quien sigue la sala desde afuera no entra al chat', async () => {
    const { client, findMany, join } = setup({ lookup: granted({ isParticipant: false, isOwner: false }) });
    await expect(join()).resolves.toEqual({ ok: false, reason: 'not-participant' });
    expect(findMany).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });

  it('con la sala cerrada el historial queda en solo lectura', async () => {
    const { join } = setup({ lookup: granted({ status: 'CLOSED' }) });
    await expect(join()).resolves.toMatchObject({ ok: true, canWrite: false });
  });

  it.each(['SCHEDULED', 'CANCELLED'])('no abre el chat de una sala %s', async (status) => {
    const { client, join } = setup({ lookup: granted({ status }) });
    await expect(join()).resolves.toEqual({ ok: false, reason: 'not-open' });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('rechaza un roomId que no es una sala y un token de otra persona', async () => {
    const { lookupRoom, join } = setup();
    await expect(join({ roomId: 'sala' })).resolves.toEqual({ ok: false, reason: 'invalid-room' });
    const other = setup({ tokenOwner: 'mallory' });
    await expect(other.join()).resolves.toEqual({ ok: false, reason: 'unauthorized' });
    expect(lookupRoom).not.toHaveBeenCalled();
  });

  it.each(['not-found', 'denied', 'unavailable'] as const)('no entra si auction responde %s', async (access) => {
    const { client, join } = setup({ lookup: { access } });
    await expect(join()).resolves.toEqual({ ok: false, reason: access });
    expect(client.join).not.toHaveBeenCalled();
  });
});

describe('ChatGateway chat.send', () => {
  beforeEach(() => { vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });

  it('guarda el mensaje y lo difunde al chat con el alias, nunca con el userId', async () => {
    const { create, join, send, emitted } = setup();
    await join();
    const response = await send('  hola   sala ');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ roomId: ROOM, authorId: 'alice', body: 'hola sala' }),
    }));
    const view = { id: expect.any(String), roomId: ROOM, alias: chatAlias(ROOM, 'alice'), body: 'hola sala', createdAt: at(30).toISOString() };
    expect(response).toEqual({ ok: true, message: view });
    expect(emitted).toEqual([{ channel: `chat:${ROOM}`, name: 'chat.message', payload: { ...view, serverTime: expect.any(String) } }]);
    expect(JSON.stringify(emitted)).not.toContain('alice');
  });

  it('no deja escribir sin haber entrado al chat', async () => {
    const { create, send } = setup();
    await expect(send('hola')).resolves.toEqual({ ok: false, reason: 'not-joined' });
    expect(create).not.toHaveBeenCalled();
  });

  it('el funcionario dueño no escribe', async () => {
    const { create, join, send } = setup({ lookup: granted({ isParticipant: false, isOwner: true }) });
    await join();
    await expect(send('hola')).resolves.toEqual({ ok: false, reason: 'read-only' });
    expect(create).not.toHaveBeenCalled();
  });

  it('rechaza mensajes vacios o demasiado largos', async () => {
    const { create, join, send } = setup();
    await join();
    await expect(send('   ')).resolves.toEqual({ ok: false, reason: 'empty' });
    await expect(send('a'.repeat(1_000))).resolves.toEqual({ ok: false, reason: 'too-long' });
    expect(create).not.toHaveBeenCalled();
  });

  it('frena a quien escribe demasiado rapido', async () => {
    const { create, join, send, advance } = setup();
    await join();
    await expect(send('uno')).resolves.toMatchObject({ ok: true });
    await expect(send('dos')).resolves.toEqual({ ok: false, reason: 'too-fast' });
    advance(MIN_SEND_INTERVAL_MS);
    await expect(send('tres')).resolves.toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('cuando la sala cerro deja de aceptar mensajes, a mas tardar al vencer la respuesta guardada', async () => {
    const { lookupRoom, create, join, send, advance } = setup();
    await join();
    lookupRoom.mockResolvedValue(granted({ status: 'CLOSED' }));
    advance(ROOM_STATUS_TTL_MS);
    await expect(send('hola')).resolves.toEqual({ ok: false, reason: 'closed' });
    expect(create).not.toHaveBeenCalled();
  });

  it('reusa la respuesta de auction mientras esta vigente', async () => {
    const { lookupRoom, join, send, advance } = setup();
    await join();
    advance(MIN_SEND_INTERVAL_MS);
    await send('uno');
    expect(lookupRoom).toHaveBeenCalledTimes(1);
  });

  it('con el token vencido no escribe', async () => {
    const { verify, create, join, send } = setup();
    await join();
    verify.mockResolvedValue(null);
    await expect(send('hola')).resolves.toEqual({ ok: false, reason: 'unauthorized' });
    expect(create).not.toHaveBeenCalled();
  });

  it('si la base falla no difunde nada', async () => {
    const { create, join, send, emitted } = setup();
    await join();
    create.mockRejectedValue(new Error('db down'));
    await expect(send('hola')).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(emitted).toEqual([]);
  });

  it('al salir del chat ya no escribe', async () => {
    const { gateway, client, join, send } = setup();
    await join();
    await gateway.leaveChat(client as never, { roomId: ROOM });
    expect(client.leave).toHaveBeenCalledWith(`chat:${ROOM}`);
    await expect(send('hola')).resolves.toEqual({ ok: false, reason: 'not-joined' });
  });
});
