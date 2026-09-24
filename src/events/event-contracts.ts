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

export interface AuctionRoundClosedEvent extends EventMetadata<'auction.round.closed.v1'> {
  roomId: string;
  roundId: string;
  position: number;
  currentPrice: string;
  currentBidderId: string | null;
  startedAt: string | null;
  endsAt: string | null;
  maximumEndsAt: string | null;
  entries: Array<{ kind: string; catalogId: string }>;
  closedAt: string;
}

export interface AuctionRoomAccessClosedEvent extends EventMetadata<'auction.room.access.closed.v1'> {
  roomId: string;
  userId: string;
  reason: 'ROOM_FULL' | 'ROOM_STARTED';
}

export type AuctionEvent =
  | AuctionBidAcceptedEvent
  | AuctionRoundClosedEvent
  | AuctionRoomAccessClosedEvent;
