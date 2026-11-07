/** Tipos de evento que se publican como actividad. La ruleta y los sobres no: son de la sala en vivo. */
export const ACTIVITY_EVENT_TYPES = [
    'auction.bid.accepted.v1',
    'auction.round.activated.v1',
    'auction.round.closed.v1',
];
/** Un evento guardado en `consumed_events`, ya convertido en actividad publica. */
export function toActivityItem(row) {
    const at = row.occurredAt.toISOString();
    const payload = row.payload;
    if (!payload || typeof payload.roundId !== 'string')
        return null;
    if (row.eventType === 'auction.bid.accepted.v1') {
        const event = payload;
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
        const event = payload;
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
        const event = payload;
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
//# sourceMappingURL=room-activity.js.map