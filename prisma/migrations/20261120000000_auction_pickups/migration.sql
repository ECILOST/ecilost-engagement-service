ALTER TYPE "NotificationKind" ADD VALUE 'PICKUP_READY';

CREATE TYPE "PickupStatus" AS ENUM ('PENDING', 'BOOKED', 'NEEDS_HELP', 'DELIVERED');

CREATE TABLE "pickup_slots" (
    "id" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    CONSTRAINT "pickup_slots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pickup_slots_valid_interval" CHECK ("startsAt" < "endsAt"),
    CONSTRAINT "pickup_slots_positive_capacity" CHECK ("capacity" > 0)
);

CREATE TABLE "auction_pickups" (
    "roundId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "winnerId" TEXT NOT NULL,
    "entries" JSONB NOT NULL DEFAULT '[]',
    "status" "PickupStatus" NOT NULL DEFAULT 'PENDING',
    "slotId" TEXT,
    "deliveryCodeHash" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "deliveredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "auction_pickups_pkey" PRIMARY KEY ("roundId"),
    CONSTRAINT "auction_pickups_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "pickup_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "pickup_messages" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pickup_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pickup_messages_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "auction_pickups"("roundId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "pickup_messages_roundId_createdAt_idx" ON "pickup_messages"("roundId", "createdAt");

CREATE UNIQUE INDEX "pickup_slots_location_startsAt_endsAt_key" ON "pickup_slots"("location", "startsAt", "endsAt");
CREATE INDEX "pickup_slots_startsAt_idx" ON "pickup_slots"("startsAt");
CREATE INDEX "auction_pickups_winnerId_createdAt_idx" ON "auction_pickups"("winnerId", "createdAt");
CREATE INDEX "auction_pickups_slotId_status_idx" ON "auction_pickups"("slotId", "status");

