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
}

export interface AuctionRoundActivatedEvent extends EventMetadata<'auction.round.activated.v1'> {
  roomId: string;
  roundId: string;
  position: number;
  currentPrice: string;
  startedAt: string;
  endsAt: string;
  entries: Array<{ kind: string; catalogId: string }>;
}

export interface AuctionRoundClosedEvent extends EventMetadata<'auction.round.closed.v1'> {
  roomId: string;
  roundId: string;
  position: number;
  currentPrice: string;
  currentBidderId: string | null;
  closedAt: string;
}

export type AuctionEvent = AuctionBidAcceptedEvent | AuctionRoundActivatedEvent | AuctionRoundClosedEvent;
