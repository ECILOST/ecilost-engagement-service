# ECILOST Engagement Service

Entrega eventos de subasta por Socket.IO y conserva las proyecciones de actividad y notificaciones. Consume eventos de Auction mediante RabbitMQ. PostgreSQL almacena las notificaciones, la actividad y el chat. MongoDB alimenta el perfil de gamificación, las medallas y el ranking semanal.

## Inicio local

Requiere Node.js 22, una base PostgreSQL propia y RabbitMQ. Usa Auth para validar JWT y Auction para comprobar el acceso a las salas. Configura MongoDB si vas a probar gamificación.

```bash
cp .env.example .env
npm ci
npm run db:generate
npm run db:deploy
npm run start:dev
```

Completa `DATABASE_URL`, `RABBITMQ_URL`, `AUTH_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` y `AUCTION_SERVICE_URL` en `.env` antes de instalar. `MONGODB_URI` y `MONGODB_DB` habilitan la gamificación. El servicio HTTP escucha en el puerto `3005`.

## OpenAPI HTTP

Importa el [contrato OpenAPI](docs/openapi.json) en Swagger Editor para consultar rutas y esquemas. Para llamar al servicio local, usa un JWT vigente emitido por Auth.

```bash
curl -H "Authorization: Bearer $ACCESS_TOKEN" http://localhost:3005/notifications
```

| Ruta | Uso |
|---|---|
| `GET /notifications` | Bandeja personal del usuario autenticado |
| `POST /notifications/read` | Marca como leídos los avisos propios y responde `204` |
| `GET /rooms/{roomId}/activity` | Actividad reciente de una sala visible para el usuario |
| `GET /profiles/me` | Estadísticas, medallas e historial del participante |
| `GET /leaderboard?week=current` | Ranking de la semana seleccionada |

Los recursos de gamificación devuelven `503` cuando el modelo de MongoDB está deshabilitado o no responde.

## Socket.IO

Conecta al namespace `/realtime` en `http://localhost:3005` con `auth: { token }`. El servidor cierra el socket al llegar el `exp` del JWT usado en el handshake. El cliente obtiene un JWT vigente, reconecta, restaura las suscripciones y relee el estado de la sala en Auction.

| Mensaje | Propósito |
|---|---|
| `room.join` | Suscribe a una sala con `{ roomId, token }`. Auction confirma el acceso |
| `room.leave` | Cancela la suscripción a una sala con `{ roomId }` |
| `chat.join` y `chat.leave` | Abren o cierran el chat de la sala |
| `chat.send` | Envía texto en una sala con `{ roomId, text, token }` |
| `round.price`, `round.extended`, `round.activated`, `round.closed` | Actualizaciones de puja, tiempo y ronda |
| `room.status`, `round.mode`, `round.sealed` | Estado de sala y modalidades dinámicas |
| `bid.outbid`, `round.won` | Avisos al canal personal del participante |
| `chat.message` | Mensaje nuevo en el chat de la sala |

## Pruebas

```bash
npm test
npm run typecheck
npm run build
npm run test:integration
```

La suite de integración arranca el servicio compilado con PostgreSQL y RabbitMQ. Usa la base `ecilost_engagement_it` y el vhost `engagement_it`. Configura `TEST_DATABASE_URL` y `TEST_RABBITMQ_URL` para apuntar a las dependencias de prueba. Si usas el contenedor local de Auth, prepara el vhost una vez:

```bash
docker exec ecilost-rabbitmq rabbitmqctl add_vhost engagement_it
docker exec ecilost-rabbitmq rabbitmqctl set_permissions -p engagement_it ecilost ".*" ".*" ".*"
```

Las pruebas del modelo de gamificación usan un MongoDB de prueba definido en `TEST_MONGODB_URL`. Consulta el [detalle del modelo de gamificación](src/gamification/README.md).
