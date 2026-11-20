import { describe, expect, it } from 'vitest';
import {
  chatAlias,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES_PER_WINDOW,
  MIN_SEND_INTERVAL_MS,
  normalizeMessage,
  SEND_WINDOW_MS,
  SendLimiter,
} from './chat-rules.js';

const ROOM = '0b8f3c1e-5d2a-4c7b-9e1f-2a3b4c5d6e7f';
const OTHER_ROOM = '1c9f4d2e-6e3b-4d8c-8f2a-3b4c5d6e7f80';

describe('normalizeMessage', () => {
  it('deja el texto en una linea, sin espacios repetidos ni caracteres de control', () => {
    expect(normalizeMessage('  hola\n\n  sala\t\u0007!  ')).toEqual({ ok: true, body: 'hola sala !' });
  });

  it.each([undefined, 42, '', '   ', '\n\t'])('rechaza un mensaje vacio: %j', (text) => {
    expect(normalizeMessage(text)).toEqual({ ok: false, reason: 'empty' });
  });

  it(`acepta hasta ${MAX_MESSAGE_LENGTH} caracteres, contando un emoji como uno`, () => {
    expect(normalizeMessage('🔥'.repeat(MAX_MESSAGE_LENGTH))).toMatchObject({ ok: true });
    expect(normalizeMessage('a'.repeat(MAX_MESSAGE_LENGTH + 1))).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('chatAlias', () => {
  it('es estable dentro de la sala y no deja ver el userId', () => {
    const alias = chatAlias(ROOM, 'alice');
    expect(alias).toMatch(/^Participante [0-9A-F]{4}$/);
    expect(chatAlias(ROOM, 'alice')).toBe(alias);
    expect(alias).not.toContain('alice');
  });

  it('cambia entre salas y entre personas', () => {
    expect(chatAlias(OTHER_ROOM, 'alice')).not.toBe(chatAlias(ROOM, 'alice'));
    expect(chatAlias(ROOM, 'bob')).not.toBe(chatAlias(ROOM, 'alice'));
  });
});

describe('SendLimiter', () => {
  const limiter = () => {
    let now = 0;
    const subject = new SendLimiter(() => now);
    return { subject, advance: (ms: number) => { now += ms; } };
  };

  it('exige una pausa minima entre dos mensajes', () => {
    const { subject, advance } = limiter();
    expect(subject.tryConsume(ROOM, 'alice')).toBe(true);
    advance(MIN_SEND_INTERVAL_MS - 1);
    expect(subject.tryConsume(ROOM, 'alice')).toBe(false);
    advance(1);
    expect(subject.tryConsume(ROOM, 'alice')).toBe(true);
  });

  it(`deja a lo sumo ${MAX_MESSAGES_PER_WINDOW} mensajes por ventana`, () => {
    const { subject, advance } = limiter();
    for (let index = 0; index < MAX_MESSAGES_PER_WINDOW; index += 1) {
      expect(subject.tryConsume(ROOM, 'alice')).toBe(true);
      advance(MIN_SEND_INTERVAL_MS);
    }
    expect(subject.tryConsume(ROOM, 'alice')).toBe(false);
    advance(SEND_WINDOW_MS);
    expect(subject.tryConsume(ROOM, 'alice')).toBe(true);
  });

  it('cuenta aparte a cada persona y cada sala', () => {
    const { subject } = limiter();
    expect(subject.tryConsume(ROOM, 'alice')).toBe(true);
    expect(subject.tryConsume(ROOM, 'bob')).toBe(true);
    expect(subject.tryConsume(OTHER_ROOM, 'alice')).toBe(true);
  });
});
