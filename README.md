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

- `npm test`: unitarias.
- `npm run test:integration`: el camino de tiempo real de punta a punta. Levanta `dist/main.js`
  (corre antes `npm run build`) contra PostgreSQL y RabbitMQ reales, publica eventos de auction y
  exige que lleguen por Socket.IO en menos de 1 s. Usa la base `ecilost_engagement_it` y el vhost
  `engagement_it`, para no competir con un engagement que este corriendo. En local, crea el vhost
  una vez:

  ```bash
  docker exec ecilost-rabbitmq rabbitmqctl add_vhost engagement_it
  docker exec ecilost-rabbitmq rabbitmqctl set_permissions -p engagement_it ecilost ".*" ".*" ".*"
  ```
