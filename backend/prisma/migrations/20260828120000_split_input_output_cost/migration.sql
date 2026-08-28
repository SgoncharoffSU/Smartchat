-- AlterTable
-- Note: an earlier migration (20260828110000_token_cost_markup) that would
-- have added a blended "cost_rub_per_1k" column plus tariff_plans'
-- markup_multiplier was written but never actually deployed to this
-- database (its folder never made it to the server) — that migration was
-- deleted and both changes are folded in here, split from the start.
ALTER TABLE "llm_providers" ADD COLUMN "cost_rub_per_1k_input" DECIMAL(10,4);
ALTER TABLE "llm_providers" ADD COLUMN "cost_rub_per_1k_output" DECIMAL(10,4);
ALTER TABLE "tariff_plans" ADD COLUMN "markup_multiplier" DECIMAL(6,2) NOT NULL DEFAULT 4;

-- Real RouterAI pricing for openai/gpt-4o-mini (the currently active row):
-- 16 RUB / 1M input tokens = 0.016 RUB/1k, 67 RUB / 1M output tokens =
-- 0.067 RUB/1k — given directly by the account owner, not estimated.
UPDATE "llm_providers"
SET "cost_rub_per_1k_input" = 0.016, "cost_rub_per_1k_output" = 0.067
WHERE "model" = 'openai/gpt-4o-mini';
