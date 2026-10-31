import type {
  AuctionBidAcceptedEvent,
  AuctionRoundActivatedEvent,
  AuctionRoundClosedEvent,
} from '../events/event-contracts.js';

/**
 * Lo que la sala publica de lo que paso, para quien la sigue en vivo y para quien entra
 * tarde. Nunca dice quien: ni quien pujo ni quien gano. Es lo mismo que el canal ya difunde
 * a toda la sala (`round.price`, `round.activated`, `round.closed`), guardado.
 */
export type RoomActivityItem =
  | {
      id: string;
      kind: 'BID';
      roundId: string;
      position: number;
      amount: string;
      automatic: boolean;
      /** La puja cayo en el ultimo minuto y movio el cierre (HU-23). */
      extended: boolean;
      endsAt: string;
      at: string;
    }
  | {
      id: string;
      kind: 'ROUND_STARTED';
      roundId: string;
      position: number;
      startingPrice: string;
      mode: string;
      at: string;
    }
  | {
      id: string;
      kind: 'ROUND_CLOSED';
      roundId: string;
      position: number;
      result: 'AWARDED' | 'DESERTED';
      /** Precio de cierre: lo que se pago si se adjudico. */
      amount: string;
      /** Era la ultima ronda: la sala termino. */
      roomClosed: boolean;
      at: string;
    };

/** Tipos de evento que se publican como actividad. La ruleta y los sobres no: son de la sala en vivo. */
export const ACTIVITY_EVENT_TYPES = [
  'auction.bid.accepted.v1',
  'auction.round.activated.v1',
  'auction.round.closed.v1',
] as const;

/** Un evento guardado en `consumed_events`, ya convertido en actividad publica. */
export function toActivityItem(row: { eventId: string; eventType: string; occurredAt: Date; payload: unknown }): RoomActivityItem | null {
  const at = row.occurredAt.toISOString();
  const payload = row.payload as Record<string, unknown> | null;
  if (!payload || typeof payload.roundId !== 'string') return null;

  if (row.eventType === 'auction.bid.accepted.v1') {
    const event = payload as unknown as AuctionBidAcceptedEvent;
    return {
      id: row.eventId,
      kind: 'BID',
      roundId: event.roundId,
      position: event.position,
      amount: event.currentPrice,
      automatic: event.automatic ?? false,
      extended: event.extended ?? false,
      endsAt: event.endsAt,
      at,
    };
  }

  if (row.eventType === 'auction.round.activated.v1') {
    const event = payload as unknown as AuctionRoundActivatedEvent;
    return {
      id: row.eventId,
      kind: 'ROUND_STARTED',
      roundId: event.roundId,
      position: event.position,
      startingPrice: event.currentPrice,
      mode: event.mode ?? 'CLASSIC',
      at,
    };
  }

  if (row.eventType === 'auction.round.closed.v1') {
    const event = payload as unknown as AuctionRoundClosedEvent;
    // Los eventos anteriores a HU-28 no traen `result`: se deduce de si hubo lider, como en el canal.
    const winnerId = event.winnerId !== undefined ? event.winnerId : event.currentBidderId;
    return {
      id: row.eventId,
      kind: 'ROUND_CLOSED',
      roundId: event.roundId,
      position: event.position,
      result: event.result ?? (winnerId ? 'AWARDED' : 'DESERTED'),
      amount: event.winningAmount ?? event.currentPrice,
      roomClosed: event.roomStatus === 'CLOSED',
      at,
    };
  }

  return null;
}
