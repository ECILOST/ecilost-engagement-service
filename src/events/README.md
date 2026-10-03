# Event consumers

Colas propias de `ecilost.events`, idempotencia por evento y DLQ antes de implementar consumidores.

## Auction → canal en vivo

`AuctionEventConsumer` lee la cola `engagement.events.v1` (DLQ `engagement.events.dlq`), empuja cada evento al namespace Socket.IO `/realtime` antes de persistirlo y guarda la bandeja de notificaciones. El cliente se conecta con `io('/realtime', { auth: { token } })` y emite `room.join` con `{ roomId, token }`: el roomId debe ser un UUID, el token el vigente de la misma persona, y auction (`AUCTION_SERVICE_URL`) debe confirmar que la sala existe y que esa persona puede verla; cada conexion escucha a lo sumo cinco salas. Todos los mensajes traen `eventId` (para descartar repetidos) y `serverTime` (para corregir el reloj local; el cliente nunca decide que algo terminó).

| Evento de Auction | Socket (canal) | Payload |
|---|---|---|
| `auction.bid.accepted.v1` | `round.price` (sala) | `roundId`, `position`, `currentPrice`, `currentBidderId`, `endsAt`, `sequence`, `automatic`, `extended` |
| `auction.bid.accepted.v1` con `extended: true` | `round.extended` (sala) | `roundId`, `position`, `previousEndsAt`, `endsAt`, `sequence` (HU-23) |
| `auction.bid.accepted.v1` | `bid.outbid` (usuario superado) | `roundId`, `position`, `currentPrice`, `endsAt` |
| `auction.round.activated.v1` | `round.activated` (sala) | `roundId`, `position`, `currentPrice`, `startedAt`, `endsAt`, `entries`, `roomStatus` |
| `auction.round.activated.v1` con `position: 1` | `room.status` (sala) | `status: 'ACTIVE'`, `at` (HU-18: inicio automático) |
| `auction.round.closed.v1` | `round.closed` (sala) | `roundId`, `position`, `currentPrice`, `result`, `closedAt`, `roomStatus` (sin el ganador) |
| `auction.round.closed.v1` con `roomStatus: 'CLOSED'` | `room.status` (sala) | `status: 'CLOSED'`, `at` (HU-18: fin de la sala) |
| `auction.round.closed.v1` adjudicado | `round.won` (ganador) | `roundId`, `position`, `amount` |

Los campos `roomStatus`, `extended`, `previousEndsAt` y `automatic` son opcionales: un evento anterior que no los trae se acepta y se trata como puja manual, sin extensión y sin cambio de estado de la sala. Un `roomStatus` desconocido manda el mensaje a la DLQ.
