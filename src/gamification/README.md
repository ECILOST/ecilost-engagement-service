# Gamificación: perfil, top semanal y medallas

Modelo de lectura en **MongoDB Atlas** alimentado por los eventos de Auction. Lo consulta el
front en "Mi perfil", en el "Top semanal" y en el chat de la sala (medallas junto al alias).
La decisión y sus alternativas están en `docs/adr/0002-modelo-de-lectura-gamificacion-mongodb.md`.

## Flujo

```
auction (outbox) ──► RabbitMQ ecilost.events
                        │
                        ├─► engagement.events.v1        → bandeja, canal en vivo (PostgreSQL)
                        └─► engagement.gamification.v1  → GamificationConsumer → MongoDB
                                                              │
               GET /profiles/me, GET /leaderboard ◄───────────┤
               chat.message (badges) ◄────────────────────────┘
```

Cola propia: si Atlas está caído, la gamificación se atrasa y lo pendiente espera en la cola
durable; la bandeja, el chat y el canal en vivo siguen funcionando. Se procesa de a uno
(`prefetch(1)`) para que el cierre de una ronda vea ya aplicadas sus pujas.

| Evento | Qué hace |
|---|---|
| `auction.bid.accepted.v1` | Traza de la ronda (`rounds`): pujas y mejor oferta por postor, y si la última fue de último segundo. |
| `auction.round.closed.v1` | Por participante: perfil (`student_profiles`), semana (`weekly_scores`), racha y medallas. El primer cierre de una semana premia el podio de la anterior (`weeks`). |

## Colecciones (base `ecilost_engagement`)

Modeladas por la consulta que las lee. No se crean a mano: Mongo crea base y colecciones con
la primera escritura y `MongoService` asegura los índices al conectar.

| Colección | Documento | Por qué así |
|---|---|---|
| `student_profiles` | uno por estudiante (`_id` = userId): contadores, medallas con fecha, últimas 5 subastas **embebidas** | "Mi perfil" es una sola lectura por `_id`. Las últimas subastas son acotadas (`$slice: 5`) y siempre se leen con el perfil. |
| `weekly_scores` | uno por estudiante y semana (`_id` = `semana:userId`) | **Referenciado**, no embebido: crece sin límite y el top se consulta por semana. Índice `{ week, wins: -1, spent: 1, userId: 1 }`: el top sale ordenado del índice. |
| `rounds` | traza de una ronda abierta | TTL de 30 días: solo sirve mientras la ronda está abierta. |
| `weeks` | semanas con podio ya premiado | Marca para premiar una sola vez. |

## Consistencia e idempotencia

- **Eventual, a propósito.** El perfil se pone al día unos milisegundos o segundos después del
  cierre. Cada respuesta trae `updatedAt` y el front dice "Actualizado hace 8 s".
- **Idempotente sin transacciones.** Cada documento guarda sus últimos 100 `eventId`. Cada
  escritura es condicional (`appliedEvents: { $ne: eventId }`) y la condición y el cambio van en
  una sola operación sobre un documento, que en MongoDB es atómica. Una reentrega no suma dos
  veces, ni siquiera si llega en paralelo (lo prueba `read-model.mongo.spec.ts`).
- Lo derivado (racha, medallas) se recalcula siempre desde los contadores, y cada medalla se
  fija una sola vez (`$exists: false`) para no pisar la fecha en que se ganó.

## Privacidad

- El top muestra un **alias público** estable (`buho-sereno-42`), nunca el nombre ni el id.
  No es el alias del chat, que cambia en cada sala para que no se pueda seguir a nadie.
- El chat lleva solo identificadores de medalla (`badges`), como mucho dos.
- La actividad pública de la sala sigue sin decir quién pujó: por eso las pujas **no** llevan
  medallas (cruzándolas con el chat se podría identificar al postor).

## Medallas

| Id | Meta |
|---|---|
| `FIRST_WIN` | Ganar una subasta. |
| `DUTCH_KING` | Ganar 5 holandesas. |
| `PERFECT_SEAL` | Ganar un sobre cerrado por menos de 10 ECICoin sobre el segundo (`runnerUpAmount`). |
| `STREAK_3` | Ganar al menos una subasta 3 semanas seguidas. |
| `DETECTIVE` | Ganar 3 lotes misteriosos. |
| `COLLECTOR` | Ganar en las cuatro modalidades. |
| `LAST_SECOND` | Ganar con una puja hecha a 3 s o menos del cierre. |
| `WEEKLY_PODIUM` | Terminar una semana en el top 3. |

Las semanas van de lunes a domingo en hora de Bogotá.

## HTTP

| Ruta | Respuesta |
|---|---|
| `GET /profiles/me` | `alias`, `stats { bids, wins, spent, streakWeeks, favoriteMode, favoriteModeBids }`, `weeklyRank`, `medals[]`, `modes[]`, `recent[] { roundId, roomId, entry { kind, catalogId }, mode, amount, result, at }`, `updatedAt` |
| `GET /leaderboard?week=current\|previous` | `week`, `from`, `to`, `entries[] { rank, alias, wins, bids, spent, favoriteMode, badges, mine }`, `me`, `updatedAt` |

Las cifras de ECICoin van como texto decimal, igual que en wallet. Sin `MONGODB_URI`, o con
Atlas caído, responden 503.

## Configuración

| Variable | Ejemplo |
|---|---|
| `MONGODB_URI` | `mongodb+srv://<usuario>:<contraseña>@<cluster>.mongodb.net/?retryWrites=true&w=majority` |
| `MONGODB_DB` | `ecilost_engagement` (por defecto) |

En Atlas, *Network Access* debe permitir la salida de los Container Apps de Azure.

## Pruebas

- `rules.spec.ts`: reglas puras (semanas, racha, medallas, resultado por participante).
- `gamification.consumer.spec.ts`: validación, confirmación, cola de muertos y reintento.
- `read-model.mongo.spec.ts`: el modelo contra un MongoDB real. Corre si existe
  `TEST_MONGODB_URL` (en CI, el servicio `mongo` del job); usa una base temporal y la borra.
