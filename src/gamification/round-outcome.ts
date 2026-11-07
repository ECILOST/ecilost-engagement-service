import type { AuctionRoundClosedEvent } from '../events/event-contracts.js';
import { LAST_SECOND_MS, PERFECT_SEAL_MARGIN, ROUND_MODES, type RoundMode } from './medals.js';

/** Lo que el modelo de lectura recuerda de una ronda mientras esta abierta. */
export interface RoundTrace {
  /** Por postor: cuantas pujas, la mas alta y si la ultima fue de ultimo segundo. */
  bidders: Record<string, { bids: number; best: number; lastSecond: boolean }>;
}

export interface CatalogEntry {
  kind: string;
  catalogId: string;
}

/** Lo que un cierre de ronda significa para una persona. */
export interface ParticipantOutcome {
  userId: string;
  won: boolean;
  /** Lo que pago si gano, o su oferta mas alta si no. */
  amount: number;
  bids: number;
  lastSecondWin: boolean;
  perfectSeal: boolean;
}

export interface RoundOutcome {
  eventId: string;
  roundId: string;
  roomId: string;
  mode: RoundMode;
  entry: CatalogEntry | null;
  closedAt: Date;
  participants: ParticipantOutcome[];
}

const toAmount = (value: unknown): number => {
  const amount = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(amount) ? amount : 0;
};

/** ¿La puja llego a 3 s o menos del cierre que tenia la ronda en ese momento? */
export function isLastSecondBid(event: { occurredAt: string; endsAt: string; previousEndsAt?: string }): boolean {
  const closing = Date.parse(event.previousEndsAt ?? event.endsAt);
  const at = Date.parse(event.occurredAt);
  if (Number.isNaN(closing) || Number.isNaN(at)) return false;
  const remaining = closing - at;
  return remaining >= 0 && remaining <= LAST_SECOND_MS;
}

/**
 * Lo que deja un `auction.round.closed.v1` para cada participante. Es una funcion pura: el
 * modelo de lectura la aplica despues, documento por documento.
 *
 * Auction publica `participants` y `runnerUpAmount` desde la gamificacion. Si el evento es
 * anterior (no los trae), los participantes salen de lo que esta ronda acumulo con sus
 * `bid.accepted`; en sobre cerrado, donde las ofertas no se publican, solo se sabe del
 * ganador.
 */
export function roundOutcome(event: AuctionRoundClosedEvent, trace: RoundTrace | null): RoundOutcome {
  const mode: RoundMode = ROUND_MODES.includes(event.mode as RoundMode) ? (event.mode as RoundMode) : 'CLASSIC';
  const winnerId = event.winnerId !== undefined ? event.winnerId : event.currentBidderId;
  const awarded = (event.result ?? (winnerId ? 'AWARDED' : 'DESERTED')) === 'AWARDED' && !!winnerId;
  const winningAmount = toAmount(event.winningAmount ?? event.currentPrice);
  const bidders = trace?.bidders ?? {};

  const reported = Array.isArray(event.participants)
    ? event.participants.map((p) => ({ userId: p.bidderId, bids: p.bids, best: toAmount(p.bestAmount) }))
    : Object.entries(bidders).map(([userId, b]) => ({ userId, bids: b.bids, best: b.best }));
  if (awarded && !reported.some((p) => p.userId === winnerId)) {
    reported.push({ userId: winnerId as string, bids: bidders[winnerId as string]?.bids ?? 1, best: winningAmount });
  }

  const runnerUp = event.runnerUpAmount === undefined || event.runnerUpAmount === null ? null : toAmount(event.runnerUpAmount);

  const participants = reported.map((p): ParticipantOutcome => {
    const won = awarded && p.userId === winnerId;
    return {
      userId: p.userId,
      won,
      amount: won ? winningAmount : p.best,
      bids: Math.max(1, p.bids),
      lastSecondWin: won && bidders[p.userId]?.lastSecond === true,
      perfectSeal: won && mode === 'SEALED' && runnerUp !== null && winningAmount - runnerUp < PERFECT_SEAL_MARGIN,
    };
  });

  const entry = Array.isArray(event.entries) && event.entries[0] ? { kind: event.entries[0].kind, catalogId: event.entries[0].catalogId } : null;

  return {
    eventId: event.eventId,
    roundId: event.roundId,
    roomId: event.roomId,
    mode,
    entry,
    closedAt: new Date(event.closedAt),
    participants,
  };
}
