import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import amqp from 'amqplib';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { integrationDatabaseUrl, integrationRabbitmqUrl } from './infrastructure.js';

/**
 * El camino completo de un evento de auction, con la infraestructura real en vez de dobles:
 *
 *   RabbitMQ (ecilost.events) -> consumidor -> PostgreSQL (inbox y bandeja) -> Socket.IO -> navegador
 *
 * Las unitarias simulan RabbitMQ, Prisma y el socket, asi que no pueden probar lo que aqui
 * importa: que una reentrega real (at-least-once) no duplica nada, que un mensaje venenoso
 * termina en la DLQ sin bloquear la cola, que el orden de las pujas sobrevive al broker y que
 * el canal de la sala solo se abre con un JWT valido. Auth y auction se sustituyen por un
 * servidor HTTP minimo: el JWKS es real (RS256) y "auction" solo reconoce una sala.
 */

const EXCHANGE = 'ecilost.events';
const QUEUE = 'engagement.events.v1';
const DEAD_LETTER_QUEUE = 'engagement.events.dlq';
const ISSUER = 'https://auth.ecilost.test';
const AUDIENCE = 'ecilost-services';
const ROOM = randomUUID();
const ROUND = randomUUID();

let app: INestApplication;
let prisma: PrismaService;
let baseUrl: string;
let fakeAuth: { url: string; sign: (userId: string) => Promise<string>; close: () => Promise<void> };
let broker: Awaited<ReturnType<typeof amqp.connect>>;
let publisher: amqp.ConfirmChannel;
const sockets: Socket[] = [];

describe('Engagement con RabbitMQ, PostgreSQL y Socket.IO reales', () => {
  beforeAll(async () => {
    fakeAuth = await startFakeAuthAndAuction();

    // Colas nuevas en cada corrida: lo que dejo una corrida anterior no debe contar aqui.
    broker = await amqp.connect(integrationRabbitmqUrl);
    publisher = await broker.createConfirmChannel();
    await publisher.assertExchange(EXCHANGE, 'topic', { durable: true });
    await publisher.deleteQueue(QUEUE);
    await publisher.deleteQueue(DEAD_LETTER_QUEUE);

    Object.assign(process.env, {
      DATABASE_URL: integrationDatabaseUrl,
      RABBITMQ_URL: integrationRabbitmqUrl,
      AUTH_JWKS_URL: `${fakeAuth.url}/.well-known/jwks.json`,
      JWT_ISSUER: ISSUER,
      JWT_AUDIENCE: AUDIENCE,
      AUCTION_SERVICE_URL: fakeAuth.url,
    });
    // El modulo de la aplicacion, tal cual se despliega: lee la configuracion al importarse.
    const { AppModule } = await import('../src/app.module.js');
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);

    // El consumidor se conecta en segundo plano: se espera a que este escuchando la cola.
    await eventually(async () => (await publisher.checkQueue(QUEUE)).consumerCount === 1);
  });

  afterAll(async () => {
    await app?.close();
    await broker?.close().catch(() => undefined);
    await fakeAuth?.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "notifications", "consumed_events"');
    await publisher.purgeQueue(DEAD_LETTER_QUEUE);
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  it('una reentrega del mismo evento no duplica la notificacion ni el aviso en vivo', async () => {
    const alice = await joinRoom('alice');
    const bob = await joinRoom('bob');
    const event = bidAccepted({ bidderId: 'bob', previousBidderId: 'alice', sequence: 1 });

    // At-least-once: el broker puede entregar dos veces el mismo hecho.
    await publish(event);
    await publish(event);
    await eventually(async () => (await prisma.consumedEvent.findUnique({ where: { eventId: event.eventId } }))?.attempts === 2);
    await settle();

    expect(await prisma.consumedEvent.count()).toBe(1);
    expect(await prisma.notification.findMany({ select: { kind: true, recipientId: true } }))
      .toEqual([{ kind: 'OUTBID', recipientId: 'alice' }]);
    expect(alice.received('round.price')).toHaveLength(1);
    expect(alice.received('bid.outbid')).toHaveLength(1);
    expect(bob.received('round.price')).toHaveLength(1);
    expect(bob.received('bid.outbid')).toHaveLength(0);
  });

  it('el cierre se anuncia a la sala sin decir quien gano; el ganador lo sabe por su canal y su bandeja', async () => {
    const alice = await joinRoom('alice');
    const bob = await joinRoom('bob');
    const event = roundClosed({ winnerId: 'bob', amount: '45000' });

    await publish(event);
    await eventually(async () => (await prisma.consumedEvent.findUnique({ where: { eventId: event.eventId } }))?.processedAt != null);
    await eventually(async () => alice.received('round.closed').length === 1 && bob.received('round.won').length === 1);
    await settle();

    expect(alice.received('round.closed')[0]).toMatchObject({ roundId: ROUND, result: 'AWARDED', currentPrice: '45000' });
    expect(JSON.stringify(alice.received('round.closed')[0])).not.toContain('bob');
    expect(alice.received('round.won')).toHaveLength(0);
    expect(bob.received('round.won')[0]).toMatchObject({ roundId: ROUND, amount: '45000' });

    expect(await inbox('bob')).toEqual([expect.objectContaining({ kind: 'ROUND_WON', roomId: ROOM })]);
    expect(await inbox('alice')).toEqual([]);
  });

  it('un mensaje venenoso termina en la DLQ sin persistirse y sin frenar la cola', async () => {
    const alice = await joinRoom('alice');
    publisher.publish(EXCHANGE, 'auction.bid.accepted.v1', Buffer.from('esto no es JSON'));
    await publish({ ...bidAccepted({ bidderId: 'bob', previousBidderId: null, sequence: 1 }), currentPrice: 4500 });
    await publisher.waitForConfirms();

    await eventually(async () => (await publisher.checkQueue(DEAD_LETTER_QUEUE)).messageCount === 2);
    expect(await prisma.consumedEvent.count()).toBe(0);
    expect(alice.received('round.price')).toHaveLength(0);

    // Lo que llega despues se procesa con normalidad.
    const next = bidAccepted({ bidderId: 'bob', previousBidderId: null, sequence: 2 });
    await publish(next);
    await eventually(async () => alice.received('round.price').length === 1);
    expect(alice.received('round.price')[0]).toMatchObject({ eventId: next.eventId });
  });

  it('una rafaga de pujas llega a la sala en el mismo orden en que auction las acepto', async () => {
    const alice = await joinRoom('alice');
    const events = Array.from({ length: 40 }, (_, index) =>
      bidAccepted({ bidderId: index % 2 ? 'bob' : 'carol', previousBidderId: index % 2 ? 'carol' : 'bob', sequence: index + 1 }));

    for (const event of events) publisher.publish(EXCHANGE, event.eventType, Buffer.from(JSON.stringify(event)), { messageId: event.eventId });
    await publisher.waitForConfirms();

    await eventually(async () => alice.received('round.price').length === events.length);
    expect(alice.received('round.price').map((message) => message.sequence)).toEqual(events.map((event) => event.sequence));
    await eventually(async () => (await prisma.consumedEvent.count({ where: { processedAt: { not: null } } })) === events.length);
  });

  it('el canal de la sala exige un JWT valido y una sala que auction reconozca', async () => {
    const intruder = io(`${baseUrl}/realtime`, { auth: { token: 'no-es-un-jwt' }, transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(intruder);
    await expect(new Promise((resolve, reject) => {
      intruder.on('connect', () => reject(new Error('se conecto sin token valido')));
      intruder.on('connect_error', (error) => resolve(error.message));
    })).resolves.toMatch(/token/i);

    const alice = await connect('alice');
    const token = await fakeAuth.sign('alice');
    await expect(alice.socket.emitWithAck('room.join', { roomId: randomUUID(), token })).resolves.toEqual({ ok: false, reason: 'not-found' });
    await expect(alice.socket.emitWithAck('room.join', { roomId: 'sala-1', token })).resolves.toEqual({ ok: false, reason: 'invalid-room' });
    await expect(alice.socket.emitWithAck('room.join', { roomId: ROOM, token: await fakeAuth.sign('mallory') }))
      .resolves.toEqual({ ok: false, reason: 'unauthorized' });
  });
});

// ---------------------------------------------------------------------------------------------

function bidAccepted({ bidderId, previousBidderId, sequence }: { bidderId: string; previousBidderId: string | null; sequence: number }) {
  const price = String(1000 + sequence * 100);
  return {
    eventId: randomUUID(),
    eventType: 'auction.bid.accepted.v1',
    occurredAt: new Date().toISOString(),
    roomId: ROOM,
    roundId: ROUND,
    position: 1,
    bidId: randomUUID(),
    bidderId,
    amount: price,
    previousBidderId,
    previousPrice: previousBidderId ? String(Number(price) - 100) : null,
    currentBidderId: bidderId,
    currentPrice: price,
    endsAt: new Date(Date.now() + 60_000).toISOString(),
    sequence: String(sequence),
  };
}

function roundClosed({ winnerId, amount }: { winnerId: string; amount: string }) {
  return {
    eventId: randomUUID(),
    eventType: 'auction.round.closed.v1',
    occurredAt: new Date().toISOString(),
    roomId: ROOM,
    roundId: ROUND,
    position: 1,
    currentPrice: amount,
    currentBidderId: winnerId,
    closedAt: new Date().toISOString(),
    result: 'AWARDED',
    winnerId,
    winningAmount: amount,
  };
}

/** Publica como lo hace el outbox de auction: `messageId` igual al `eventId`, con confirmacion. */
async function publish(event: { eventId: string; eventType: string } & Record<string, unknown>) {
  publisher.publish(EXCHANGE, event.eventType, Buffer.from(JSON.stringify(event)), { messageId: event.eventId, persistent: true });
  await publisher.waitForConfirms();
}

async function inbox(userId: string) {
  const response = await fetch(`${baseUrl}/notifications`, { headers: { authorization: `Bearer ${await fakeAuth.sign(userId)}` } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: unknown[] }).items;
}

type Received = Record<string, unknown> & { eventId?: string; sequence?: string };

/** Un navegador conectado al canal en vivo, que guarda todo lo que recibe. */
async function connect(userId: string) {
  const socket = io(`${baseUrl}/realtime`, {
    auth: { token: await fakeAuth.sign(userId) },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  sockets.push(socket);
  const log: Array<{ name: string; payload: Received }> = [];
  socket.onAny((name: string, payload: Received) => log.push({ name, payload }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return { socket, received: (name: string) => log.filter((entry) => entry.name === name).map((entry) => entry.payload) };
}

async function joinRoom(userId: string) {
  const client = await connect(userId);
  await expect(client.socket.emitWithAck('room.join', { roomId: ROOM, token: await fakeAuth.sign(userId) }))
    .resolves.toEqual({ ok: true, roomId: ROOM });
  return client;
}

/**
 * Auth y auction de mentira en un solo servidor: el JWKS con una llave RS256 de la corrida y
 * `GET /rooms/:id`, que solo reconoce la sala de las pruebas.
 */
async function startFakeAuthAndAuction() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'integration', alg: 'RS256', use: 'sig' };
  const server: Server = createServer((request, response) => {
    if (request.url === '/.well-known/jwks.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    const known = request.url === `/rooms/${ROOM}` && request.headers.authorization?.startsWith('Bearer ');
    response.writeHead(known ? 200 : 404, { 'content-type': 'application/json' }).end(known ? JSON.stringify({ id: ROOM }) : '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    sign: (userId: string) =>
      new SignJWT({ role: 'STUDENT' })
        .setProtectedHeader({ alg: 'RS256', kid: 'integration' })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Repite la comprobacion hasta que se cumpla: el consumo es asincrono por naturaleza. */
async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`La condicion no se cumplio en ${timeoutMs} ms`);
}

/** Margen para que un duplicado que si se hubiera emitido alcance a llegar al socket. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
