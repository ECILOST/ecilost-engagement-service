-- La actividad publica de una sala se lee de la bandeja de eventos: la sala sale del JSON
-- a su propia columna, con indice, y los eventos ya guardados la toman de su payload.
ALTER TABLE "consumed_events" ADD COLUMN "roomId" TEXT;

UPDATE "consumed_events" SET "roomId" = "payload"->>'roomId' WHERE "roomId" IS NULL;

CREATE INDEX "consumed_events_roomId_occurredAt_idx"
    ON "consumed_events"("roomId", "occurredAt");
