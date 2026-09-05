-- Needed for gen_random_uuid() in the seed insert below — already enabled
-- by an earlier migration (20260828100000_billing_tariffs), IF NOT EXISTS
-- just makes this safe to run regardless.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateTable
CREATE TABLE "implementation_manager" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "photo_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "implementation_manager_pkey" PRIMARY KEY ("id")
);

-- Seed the single row ImplementationManagerService.ensureRow expects to find
-- (same convention as payment_settings' own migration) — pre-filled with
-- the real name given ("должен быть Сергей"), photo added afterwards via
-- the admin panel's own upload (a migration can't reach a local image file).
INSERT INTO "implementation_manager" ("id", "name", "photo_url", "updated_at")
VALUES (gen_random_uuid(), 'Сергей', NULL, CURRENT_TIMESTAMP);
