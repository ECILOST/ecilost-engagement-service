import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const connect = vi.hoisted(() => vi.fn());
vi.mock('amqplib', () => ({ default: { connect } }));

import { AuctionEventConsumer } from './auction-event.consumer.js';

function fakeConnection() {
  const channel = {
    assertExchange: vi.fn(),
    assertQueue: vi.fn(),
    bindQueue: vi.fn(),
    prefetch: vi.fn(),
    consume: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return Object.assign(new EventEmitter(), {
    channel,
    createChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn().mockResolvedValue(undefined),
  });
}

function consumer() {
  const config = { get: () => 'amqp://test' };
  return new AuctionEventConsumer(config as never, {} as never, {} as never);
}

describe('AuctionEventConsumer connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connect.mockReset();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('no tumba el arranque si RabbitMQ no responde: reintenta hasta conectar', async () => {
    const connection = fakeConnection();
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(connection);
    const subject = consumer();

    await subject.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.channel.consume).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(connection.channel.consume).toHaveBeenCalledWith('engagement.events.v1', expect.any(Function));
    await subject.onModuleDestroy();
  });

  it('si la conexion se cae, la sala vuelve a recibir eventos sin reiniciar el servicio', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const subject = consumer();

    await subject.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    first.emit('close');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.channel.consume).toHaveBeenCalledOnce();
    await subject.onModuleDestroy();
  });
});
