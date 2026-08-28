-- Needed for gen_random_uuid() used in this migration's seed inserts below.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateTable
CREATE TABLE "tariff_plans" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_rub" DECIMAL(10,2) NOT NULL,
    "period_days" INTEGER,
    "token_rub_per_1k" DECIMAL(10,4),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tariff_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "tariff_plan_id" TEXT NOT NULL,
    "amount_rub" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "yookassa_payment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_settings" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT,
    "secret_key" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_yookassa_payment_id_key" ON "payments"("yookassa_payment_id");
CREATE INDEX "payments_company_id_created_at_idx" ON "payments"("company_id", "created_at");

-- AlterTable
ALTER TABLE "companies" ADD COLUMN "tariff_plan_id" TEXT;
ALTER TABLE "companies" ADD COLUMN "plan_expires_at" TIMESTAMP(3);
ALTER TABLE "companies" ADD COLUMN "token_balance_rub" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_tariff_plan_id_fkey" FOREIGN KEY ("tariff_plan_id") REFERENCES "tariff_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_tariff_plan_id_fkey" FOREIGN KEY ("tariff_plan_id") REFERENCES "tariff_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the two tariffs at the placeholder 1 RUB price requested — real
-- pricing is just an UPDATE on these rows later, no migration needed.
-- token_rub_per_1k: real embedding cost today is ~0.02 RUB/1k tokens (see
-- embeddings.service.ts's RUB_PER_1K_TOKENS) — 1 RUB/1k is already a large
-- markup over that at 1 RUB pricing; swap in the real completion-model rate
-- once known and re-apply the same 300-500% markup on top of it.
INSERT INTO "tariff_plans" ("id", "kind", "name", "price_rub", "period_days", "token_rub_per_1k", "is_active")
VALUES
  (gen_random_uuid(), 'unlimited', 'Безлимит на месяц', 1.00, 30, NULL, true),
  (gen_random_uuid(), 'token', 'Оплата за токены', 1.00, NULL, 1.00, true);

-- Singleton row PaymentSettingsService always reads/updates — created empty
-- (both keys null) so the admin field has something to PATCH into.
INSERT INTO "payment_settings" ("id", "shop_id", "secret_key", "updated_at")
VALUES (gen_random_uuid(), NULL, NULL, CURRENT_TIMESTAMP);
