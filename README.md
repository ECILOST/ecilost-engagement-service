# ECILOST Engagement Service

Esqueleto del contexto de notificaciones, historial auditable, estadísticas y recogida. Consume eventos y conserva proyecciones propias; no altera Auction.

```text
src/
  notifications/ audit/ statistics/ pickup/ events/
  presentation/http/ infrastructure/
prisma/ test/
```

Sus consumidores serán idempotentes y las proyecciones son eventualmente consistentes; este servicio no participa en la decisión ni en la serialización de una puja.

## Pruebas

- `npm test`: unitarias, sin infraestructura (RabbitMQ, Prisma y Socket.IO van simulados).
- `npm run test:integration`: el camino completo RabbitMQ -> consumidor -> PostgreSQL -> Socket.IO con infraestructura real (`test/realtime-pipeline.int-spec.ts`). Comprueba que una reentrega no duplica notificaciones ni avisos en vivo, que un mensaje venenoso termina en `engagement.events.dlq` sin frenar la cola, que una rafaga de pujas llega a la sala en orden y que el canal exige un JWT valido y una sala existente. Auth y auction se sustituyen por un servidor HTTP minimo con un JWKS RS256 real.

En CI corren contra los contenedores `postgres` y `rabbitmq` del workflow. En local necesitan un PostgreSQL y un RabbitMQ propios (ver `test/infrastructure.ts`); `TEST_DATABASE_URL` y `TEST_RABBITMQ_URL` los cambian. No los apuntes a dev ni a prod: las pruebas vacian tablas y purgan colas.
