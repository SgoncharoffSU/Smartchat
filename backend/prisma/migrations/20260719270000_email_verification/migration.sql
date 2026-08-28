-- AlterTable
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "email_verify_token" TEXT;
CREATE UNIQUE INDEX "users_email_verify_token_key" ON "users"("email_verify_token");

-- Backfill: every account that already existed before this migration already
-- proved access some other way (it's already in production use) — treat it
-- as verified so login doesn't suddenly lock out real, working accounts.
-- Only accounts registered AFTER this point go through the new email-confirm flow.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
