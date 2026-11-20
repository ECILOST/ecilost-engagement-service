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

## Cobertura y SonarQube

Ejecuta `npm ci` y luego `npm run test:cov` para generar `coverage/index.html` y
`coverage/lcov.info`. La cobertura corresponde a la suite que ejecuta `npm test`.
Vitest exige al menos un 80 % de cobertura global de líneas por repositorio.

El proyecto de SonarQube Cloud es `ECILOST_ecilost-engagement-service` en la organización `ecilost`.
Para importar LCOV, desactiva **Automatic Analysis** en **Administration > Analysis Method**.
Configura `SONAR_TOKEN` como secreto de GitHub Actions con permiso de análisis.
En cada push a la rama predeterminada, CI invoca `sonarcloud.yml` con el LCOV
generado por `npm run test:cov` y espera el resultado del Quality Gate.
