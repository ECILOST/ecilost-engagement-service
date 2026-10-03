export interface EventMetadata<TEventType extends string> {
  eventId: string;
  eventType: TEventType;
  occurredAt: string;
}

export interface AuctionBidAcceptedEvent extends EventMetadata<'auction.bid.accepted.v1'> {
  roomId: string;
  roundId: string;
  position: number;
  bidId: string;
  bidderId: string;
  amount: string;
  previousBidderId: string | null;
  previousPrice: string | null;
  currentBidderId: string;
  currentPrice: string;
  endsAt: string;
  sequence: string;
  /** Desde HU-23: el cierre que tenia la ronda antes de esta puja, y si la puja lo extendio. */
  previousEndsAt?: string;
  extended?: boolean;
  /** Desde HU-22: la hizo el motor de puja automatica. */
  automatic?: boolean;
}

/** Estado de la sala tras una transicion de ronda (HU-18). `CLOSED` es la sala terminada. */
export type RoomStatus = 'ACTIVE' | 'CLOSED';

export interface AuctionRoundActivatedEvent extends EventMetadata<'auction.round.activated.v1'> {
  roomId: string;
  roundId: string;
  position: number;
  currentPrice: string;
  startedAt: string;
  endsAt: string;
  entries: Array<{ kind: string; catalogId: string }>;
  /** Desde HU-18. Los eventos anteriores no lo traen. */
  roomStatus?: RoomStatus;
}

export interface AuctionRoundClosedEvent extends EventMetadata<'auction.round.closed.v1'> {
  roomId: string;
  roundId: string;
  position: number;
  currentPrice: string;
  currentBidderId: string | null;
  closedAt: string;
  /** Desde HU-28. Los eventos anteriores no lo traen: se deduce de `currentBidderId`. */
  result?: 'AWARDED' | 'DESERTED';
  winnerId?: string | null;
  winningAmount?: string | null;
  /** Desde HU-18: `CLOSED` cuando era la ultima ronda. Los eventos anteriores no lo traen. */
  roomStatus?: RoomStatus;
}

export type AuctionEvent = AuctionBidAcceptedEvent | AuctionRoundActivatedEvent | AuctionRoundClosedEvent;
