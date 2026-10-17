import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import amqp from 'amqplib';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { integrationDatabaseUrl, integrationRabbitmqUrl } from './environment.js';

/**
 * El camino de tiempo real de punta a punta, con el servicio compilado corriendo como en el
 * contenedor: auction publica un evento en RabbitMQ, engagement lo consume, lo guarda y lo
 * difunde por Socket.IO. Lo unico falso es auth (el JWKS) y la consulta de sala a auction.
 *
 * El requisito del proyecto es que precio, contador y transicion de ronda lleguen en menos
 * de 1 s; aqui se mide desde que el evento se publica hasta que el navegador lo recibe.
 */
const REALTIME_BUDGET_MS = 1_000;
const ISSUER = 'https://auth.ecilost.test';
const AUDIENCE = 'ecilost-services';
const EXCHANGE = 'ecilost.events';
const QUEUE = 'engagement.events.v1';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let fakes: Server;
let service: ChildProcess;
let serviceUrl: string;
let broker: amqp.ChannelModel;
let publisher: amqp.Channel;
const output: string[] = [];
const sockets: Socket[] = [];

const listening = (server: Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const probe = createServer();
  const port = await listening(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`${what} no ocurrio a tiempo. Salida del servicio:\n${output.join('')}`);
}

function token(userId: string) {
  return new SignJWT({ role: 'STUDENT' })
    .setProtectedHeader({ alg: 'RS256', kid: 'it' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(keys.privateKey);
}

async function connect(userId: string) {
  const socket = io(`${serviceUrl}/realtime`, { auth: { token: await token(userId) }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

async function joined(userId: string, roomId: string) {
  const socket = await connect(userId);
  const answer = await socket.emitWithAck('room.join', { roomId, token: await token(userId) });
  expect(answer).toEqual({ ok: true, roomId });
  return socket;
}

/** Espera un mensaje y devuelve cuando llego. */
function next(socket: Socket, event: string, timeoutMs = 3_000) {
  return new Promise<{ payload: Record<string, unknown>; at: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} no llego en ${timeoutMs} ms`)), timeoutMs);
    socket.once(event, (payload: Record<string, unknown>) => {
      clearTimeout(timer);
      resolve({ payload, at: Date.now() });
    });
  });
}

function collect(socket: Socket, event: string) {
  const received: Record<string, unknown>[] = [];
  socket.on(event, (payload: Record<string, unknown>) => received.push(payload));
  return received;
}

function publish(event: Record<string, unknown>) {
  publisher.publish(EXCHANGE, String(event.eventType), Buffer.from(JSON.stringify(event)), { persistent: true, messageId: String(event.eventId) });
  return Date.now();
}

function bidAccepted(roomId: string, overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    eventId: randomUUID(), eventType: 'auction.bid.accepted.v1', occurredAt: now.toISOString(),
    roomId, roundId: randomUUID(), position: 1, bidId: randomUUID(),
    bidderId: 'bob', amount: '1100', previousBidderId: 'alice', previousPrice: '1000',
    currentBidderId: 'bob', currentPrice: '1100', endsAt: new Date(now.getTime() + 60_000).toISOString(),
    sequence: '2', extended: false, automatic: false,
    ...overrides,
  };
}

beforeAll(async () => {
  // Auth (JWKS) y auction (GET /rooms/:id) de mentira.
  keys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'it', alg: 'RS256', use: 'sig' };
  fakes = createServer((request, response) => {
    if (request.url === '/.well-known/jwks.json') return response.end(JSON.stringify({ keys: [jwk] }));
    if (request.url?.startsWith('/rooms/')) {
      response.statusCode = request.headers.authorization?.startsWith('Bearer ') ? 200 : 401;
      return response.end('{}');
    }
    response.statusCode = 404;
    response.end();
  });
  const fakesUrl = `http://127.0.0.1:${await listening(fakes)}`;

  // Base de pruebas limpia y una cola sin mensajes viejos.
  const prisma = new PrismaClient({ adapter: new PrismaPg(integrationDatabaseUrl) });
  await prisma.$executeRawUnsafe('TRUNCATE "notifications", "consumed_events"');
  await prisma.$disconnect();
  broker = await amqp.connect(integrationRabbitmqUrl);
  publisher = await broker.createChannel();
  await publisher.assertExchange(EXCHANGE, 'topic', { durable: true });

  const port = await freePort();
  serviceUrl = `http://127.0.0.1:${port}`;
  service = spawn(process.execPath, ['dist/main.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: integrationDatabaseUrl,
      RABBITMQ_URL: integrationRabbitmqUrl,
      AUTH_JWKS_URL: `${fakesUrl}/.well-known/jwks.json`,
      JWT_ISSUER: ISSUER,
      JWT_AUDIENCE: AUDIENCE,
      AUCTION_SERVICE_URL: fakesUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout?.on('data', (chunk) => output.push(String(chunk)));
  service.stderr?.on('data', (chunk) => output.push(String(chunk)));

  await until('El servicio responde por HTTP', async () => (await fetch(`${serviceUrl}/notifications`)).status === 401);
  await until('El consumidor escucha la cola de eventos', async () => {
    const channel = await broker.createChannel();
    channel.on('error', () => undefined);
    try {
      return (await channel.checkQueue(QUEUE)).consumerCount > 0;
    } finally {
      await channel.close().catch(() => undefined);
    }
  });
  await publisher.purgeQueue(QUEUE);
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  service?.kill();
  await broker?.close().catch(() => undefined);
  await new Promise((resolve) => fakes?.close(resolve));
});

describe('Tiempo real: RabbitMQ -> engagement -> Socket.IO', () => {
  it('una puja aceptada llega a toda la sala en menos de 1 s y el superado recibe su aviso personal', async () => {
    const roomId = randomUUID();
    const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map((user) => joined(user, roomId)));
    const outsider = await connect('dave');
    const outsiderPrices = collect(outsider, 'round.price');

    const prices = [alice, bob, carol].map((socket) => next(socket, 'round.price'));
    const outbid = next(alice, 'bid.outbid');
    const sentAt = publish(bidAccepted(roomId));

    const received = await Promise.all(prices);
    const latencies = received.map(({ at }) => at - sentAt);
    console.log(`round.price a 3 clientes: ${latencies.join(', ')} ms`);
    for (const { payload } of received) expect(payload).toMatchObject({ roomId, currentPrice: '1100', currentBidderId: 'bob' });
    expect(Math.max(...latencies)).toBeLessThan(REALTIME_BUDGET_MS);

    const personal = await outbid;
    expect(personal.payload).toMatchObject({ roomId, currentPrice: '1100' });
    expect(personal.at - sentAt).toBeLessThan(REALTIME_BUDGET_MS);
    // Quien no entro a la sala no recibe su precio.
    await sleep(300);
    expect(outsiderPrices).toEqual([]);
  });

  it('una rafaga de 50 pujas llega completa y cada una en menos de 1 s', async () => {
    const roomId = randomUUID();
    const viewer = await joined('carol', roomId);
    const arrivals = new Map<string, number>();
    viewer.on('round.price', (payload: { eventId: string }) => arrivals.set(payload.eventId, Date.now()));

    const sent = new Map<string, number>();
    for (let sequence = 1; sequence <= 50; sequence += 1) {
      const event = bidAccepted(roomId, { sequence: String(sequence), currentPrice: String(1_000 + sequence * 100), amount: String(1_000 + sequence * 100) });
      sent.set(event.eventId, publish(event));
    }
    await until('Llegan las 50 pujas', async () => arrivals.size === 50, 10_000);

    const latencies = [...sent].map(([eventId, at]) => arrivals.get(eventId)! - at).sort((a, b) => a - b);
    const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
    console.log(`Rafaga de 50 pujas: p50 ${latencies[24]} ms, p95 ${p95} ms, max ${latencies[49]} ms`);
    expect(latencies[49]).toBeLessThan(REALTIME_BUDGET_MS);
  });

  it('una reentrega del mismo evento no se emite dos veces', async () => {
    const roomId = randomUUID();
    const viewer = await joined('carol', roomId);
    const prices = collect(viewer, 'round.price');

    const event = bidAccepted(roomId);
    publish(event);
    publish(event);
    await until('Llega la puja', async () => prices.length > 0, 5_000);
    await sleep(500);

    expect(prices).toHaveLength(1);
  });

  it('el cierre avisa a la sala, solo el ganador recibe round.won y queda en su bandeja', async () => {
    const roomId = randomUUID();
    const [winner, other] = await Promise.all([joined('bob', roomId), joined('alice', roomId)]);
    const otherWins = collect(other, 'round.won');
    const closed = [winner, other].map((socket) => next(socket, 'round.closed'));
    const won = next(winner, 'round.won');

    const now = new Date().toISOString();
    const sentAt = publish({
      eventId: randomUUID(), eventType: 'auction.round.closed.v1', occurredAt: now, roomId, roundId: randomUUID(), position: 1,
      currentPrice: '1500', currentBidderId: 'bob', winnerId: 'bob', winningAmount: '1500', result: 'AWARDED', closedAt: now, roomStatus: 'CLOSED',
    });

    for (const { payload, at } of await Promise.all(closed)) {
      expect(payload).toMatchObject({ roomId, result: 'AWARDED', roomStatus: 'CLOSED' });
      expect(at - sentAt).toBeLessThan(REALTIME_BUDGET_MS);
    }
    expect((await won).payload).toMatchObject({ roomId, amount: '1500' });
    await sleep(300);
    expect(otherWins).toEqual([]);

    const inbox = await fetch(`${serviceUrl}/notifications`, { headers: { authorization: `Bearer ${await token('bob')}` } });
    const { items } = (await inbox.json()) as { items: Array<{ kind: string; roomId: string }> };
    expect(items).toContainEqual(expect.objectContaining({ kind: 'ROUND_WON', roomId }));
  });

  it('sin token valido no hay conexion y una sala invalida no se puede escuchar', async () => {
    const intruder = io(`${serviceUrl}/realtime`, { auth: { token: 'no-es-un-jwt' }, transports: ['websocket'], reconnection: false });
    sockets.push(intruder);
    await expect(new Promise<void>((resolve, reject) => {
      intruder.once('connect', () => resolve());
      intruder.once('connect_error', reject);
    })).rejects.toThrow('El token de acceso no es valido.');

    const socket = await connect('carol');
    await expect(socket.emitWithAck('room.join', { roomId: 'no-es-una-sala' })).resolves.toEqual({ ok: false, reason: 'invalid-room' });
  });
});
