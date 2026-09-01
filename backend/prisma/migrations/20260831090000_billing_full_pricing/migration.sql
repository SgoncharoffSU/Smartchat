-- AlterTable
ALTER TABLE "tariff_plans" ADD COLUMN "lead_rub_per_lead" DECIMAL(10,2);
ALTER TABLE "companies" ADD COLUMN "auto_pay_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Retire the first pass's 1-RUB placeholders (per the account owner's own
-- "потом переделаем") rather than deleting them — any Payment/Company row
-- still referencing them (real test purchases made earlier this session)
-- keeps working; they just stop showing up in listPlans() (isActive:true
-- only).
UPDATE "tariff_plans" SET "is_active" = false WHERE "price_rub" = 1.00 AND "kind" IN ('unlimited', 'token');

-- Real pricing, matching what the account owner approved building (the
-- reference prototype's own numbers): unlimited monthly/annual, three token
-- packs (top-up amount varies, real per-1000-token rate comes from the
-- active LlmProvider row — see BillingService.effectiveRates, unaffected by
-- which pack was bought), three lead packs (top-up amount varies, flat
-- 149 RUB/lead rate — see BillingService.chargeConfirmedLead).
INSERT INTO "tariff_plans" ("id", "kind", "name", "price_rub", "period_days", "token_rub_per_1k", "lead_rub_per_lead", "is_active")
VALUES
  (gen_random_uuid(), 'unlimited', 'Полный безлимит — месяц', 12900.00, 30, NULL, NULL, true),
  (gen_random_uuid(), 'unlimited', 'Полный безлимит — год', 118800.00, 365, NULL, NULL, true),
  (gen_random_uuid(), 'token', 'Токены — 100 тыс.', 390.00, NULL, NULL, NULL, true),
  (gen_random_uuid(), 'token', 'Токены — 500 тыс.', 990.00, NULL, NULL, NULL, true),
  (gen_random_uuid(), 'token', 'Токены — 1 млн', 1490.00, NULL, NULL, NULL, true),
  (gen_random_uuid(), 'lead', 'Лиды — 10 шт.', 1490.00, NULL, NULL, 149.00, true),
  (gen_random_uuid(), 'lead', 'Лиды — 30 шт.', 4470.00, NULL, NULL, 149.00, true),
  (gen_random_uuid(), 'lead', 'Лиды — 100 шт.', 14900.00, NULL, NULL, 149.00, true);
