-- Move billing ownership from Company to Bot: one subscription/trial/token
-- balance per BOT, not shared across a company's bots — "один бот – одна
-- абонентская плата", a company with several bots pays for each separately.
-- See Bot's own schema comment for the field-by-field rationale (unchanged
-- from when they lived on Company, just relocated).

-- AlterTable: add the 6 billing columns to bots
ALTER TABLE "bots" ADD COLUMN "trial_ends_at" TIMESTAMP(3);
ALTER TABLE "bots" ADD COLUMN "subscription_active" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bots" ADD COLUMN "tariff_plan_id" TEXT;
ALTER TABLE "bots" ADD COLUMN "plan_expires_at" TIMESTAMP(3);
ALTER TABLE "bots" ADD COLUMN "token_balance_rub" DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE "bots" ADD COLUMN "auto_pay_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill #1: each company's CURRENT billing state (trial/plan/balance)
-- moves onto its OLDEST bot — the one that already existed while that state
-- was accruing. A company with only one bot today (true for every account
-- except whoever's already used the brand-new multi-bot switcher) is
-- unaffected either way: its one bot just inherits exactly what the company
-- already had.
UPDATE "bots" b
SET "trial_ends_at" = c."trial_ends_at",
    "subscription_active" = c."subscription_active",
    "tariff_plan_id" = c."tariff_plan_id",
    "plan_expires_at" = c."plan_expires_at",
    "token_balance_rub" = c."token_balance_rub",
    "auto_pay_enabled" = c."auto_pay_enabled"
FROM "companies" c
WHERE b."company_id" = c.id
  AND b.id = (
    SELECT b2.id FROM "bots" b2 WHERE b2."company_id" = c.id ORDER BY b2."created_at" ASC LIMIT 1
  );

-- Backfill #2: any OTHER pre-existing bot for a company that already had
-- more than one (the only bots this migration could possibly strand with no
-- plan and no trial, i.e. fully blocked from a still-null trial_ends_at) —
-- gets its own fresh 15-day trial starting now, same length
-- ProvisioningService.createCompanyAndBot already gives a brand-new company.
UPDATE "bots" b
SET "trial_ends_at" = CURRENT_TIMESTAMP + INTERVAL '15 days'
WHERE b.id NOT IN (
  SELECT DISTINCT ON (company_id) id FROM "bots" ORDER BY company_id, created_at ASC
);

-- AddForeignKey + index for bots.tariff_plan_id (mirrors the companies one
-- this replaces, dropped further below)
ALTER TABLE "bots" ADD CONSTRAINT "bots_tariff_plan_id_fkey" FOREIGN KEY ("tariff_plan_id") REFERENCES "tariff_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "bots_tariff_plan_id_idx" ON "bots"("tariff_plan_id");

-- AlterTable: payments now belong to a specific bot (the real billing
-- owner), not just a company — added nullable, backfilled from that
-- payment's company's oldest bot (every historical payment necessarily
-- predates any 2nd/3rd bot on that company, so this is unambiguous), then
-- locked to NOT NULL.
ALTER TABLE "payments" ADD COLUMN "bot_id" TEXT;
UPDATE "payments" p
SET "bot_id" = (
  SELECT b.id FROM "bots" b WHERE b."company_id" = p."company_id" ORDER BY b."created_at" ASC LIMIT 1
);
ALTER TABLE "payments" ALTER COLUMN "bot_id" SET NOT NULL;
ALTER TABLE "payments" ADD CONSTRAINT "payments_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "payments_bot_id_created_at_idx" ON "payments"("bot_id", "created_at");

-- Drop the old company-level billing columns + their FK — Bot is now the
-- sole source of truth for all of this (see its own schema comment).
ALTER TABLE "companies" DROP CONSTRAINT IF EXISTS "companies_tariff_plan_id_fkey";
ALTER TABLE "companies" DROP COLUMN "trial_ends_at";
ALTER TABLE "companies" DROP COLUMN "subscription_active";
ALTER TABLE "companies" DROP COLUMN "tariff_plan_id";
ALTER TABLE "companies" DROP COLUMN "plan_expires_at";
ALTER TABLE "companies" DROP COLUMN "token_balance_rub";
ALTER TABLE "companies" DROP COLUMN "auto_pay_enabled";
