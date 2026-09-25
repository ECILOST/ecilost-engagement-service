-- El cierre de ronda avisa a la sala y, aparte, al ganador: un evento, dos notificaciones.
ALTER TYPE "NotificationKind" ADD VALUE 'ROUND_WON';

DROP INDEX "notifications_eventId_key";
CREATE UNIQUE INDEX "notifications_eventId_kind_key" ON "notifications"("eventId", "kind");

ALTER TABLE "notifications" ADD COLUMN "readAt" TIMESTAMP(3);
