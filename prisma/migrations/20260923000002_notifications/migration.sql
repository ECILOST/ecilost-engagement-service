CREATE TYPE "NotificationKind" AS ENUM ('OUTBID', 'ROUND_CLOSED');

CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "roomId" TEXT NOT NULL,
    "recipientId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notifications_eventId_key" ON "notifications"("eventId");
CREATE INDEX "notifications_recipientId_createdAt_idx"
    ON "notifications"("recipientId", "createdAt");
CREATE INDEX "notifications_roomId_createdAt_idx"
    ON "notifications"("roomId", "createdAt");
