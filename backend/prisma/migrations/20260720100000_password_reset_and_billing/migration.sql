-- AlterTable
ALTER TABLE "users" ADD COLUMN "password_reset_token" TEXT;
ALTER TABLE "users" ADD COLUMN "password_reset_expires_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "users_password_reset_token_key" ON "users"("password_reset_token");

-- AlterTable
ALTER TABLE "companies" ADD COLUMN "subscription_active" BOOLEAN NOT NULL DEFAULT false;
