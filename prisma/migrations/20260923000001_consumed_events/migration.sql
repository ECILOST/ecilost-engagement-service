CREATE TABLE "consumed_events" (
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "consumed_events_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX "consumed_events_processedAt_receivedAt_idx"
    ON "consumed_events"("processedAt", "receivedAt");
