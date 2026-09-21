# ECILOST Engagement Service

Esqueleto del contexto de notificaciones, historial auditable, estadísticas y recogida. Consume eventos y conserva proyecciones propias; no altera Auction.

```text
src/
  notifications/ audit/ statistics/ pickup/ events/
  presentation/http/ infrastructure/
prisma/ test/
```

Sus consumidores serán idempotentes y las proyecciones son eventualmente consistentes; este servicio no participa en la decisión ni en la serialización de una puja.
