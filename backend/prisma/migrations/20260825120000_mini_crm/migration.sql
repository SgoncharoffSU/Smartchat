-- Needed for gen_random_uuid() used in this migration's backfill inserts below
-- (Prisma-generated ids normally come from the application layer, not a DB
-- default, but this one-time backfill runs as raw SQL with no app in the loop).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "company_role" TEXT NOT NULL DEFAULT 'owner';

-- AlterTable
ALTER TABLE "bots" ADD COLUMN "bitrix24_webhook_token" TEXT;
ALTER TABLE "bots" ADD COLUMN "amocrm_last_polled_at" TIMESTAMP(3);
CREATE UNIQUE INDEX "bots_bitrix24_webhook_token_key" ON "bots"("bitrix24_webhook_token");

-- CreateTable
CREATE TABLE "pipelines" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Основная воронка',
    "is_default" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stages" (
    "id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#94a3b8',
    "order" INTEGER NOT NULL,
    "is_won" BOOLEAN NOT NULL DEFAULT false,
    "is_lost" BOOLEAN NOT NULL DEFAULT false,
    "bitrix24_category_id" TEXT,
    "bitrix24_stage_id" TEXT,
    "bitrix24_target_type" TEXT,
    "amocrm_status_id" INTEGER,
    "amocrm_pipeline_id" INTEGER,

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "bot_id" TEXT,
    "lead_id" TEXT,
    "dialog_id" TEXT,
    "title" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "amount" DECIMAL(12,2),
    "currency" TEXT DEFAULT 'RUB',
    "stage_id" TEXT NOT NULL,
    "assigned_user_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "redacted_at" TIMESTAMP(3),
    "bitrix24_deal_id" TEXT,
    "bitrix24_lead_id" TEXT,
    "bitrix24_synced_at" TIMESTAMP(3),
    "amocrm_lead_id" TEXT,
    "amocrm_synced_at" TIMESTAMP(3),
    "last_crm_fingerprint" TEXT,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_custom_field_values" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "value" TEXT,

    CONSTRAINT "deal_custom_field_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_activities" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "author_user_id" TEXT,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deals_lead_id_key" ON "deals"("lead_id");

-- CreateIndex
CREATE INDEX "deals_company_id_stage_id_idx" ON "deals"("company_id", "stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_company_id_key_key" ON "custom_field_definitions"("company_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "deal_custom_field_values_deal_id_field_id_key" ON "deal_custom_field_values"("deal_id", "field_id");

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "pipeline_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_custom_field_values" ADD CONSTRAINT "deal_custom_field_values_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_custom_field_values" ADD CONSTRAINT "deal_custom_field_values_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_activities" ADD CONSTRAINT "deal_activities_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_activities" ADD CONSTRAINT "deal_activities_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one default pipeline + 4 stages (Новая/В работе/Успешно/Отказ) per existing company.
INSERT INTO "pipelines" ("id", "company_id", "name", "is_default", "created_at")
SELECT gen_random_uuid(), "id", 'Основная воронка', true, CURRENT_TIMESTAMP
FROM "companies";

INSERT INTO "pipeline_stages" ("id", "pipeline_id", "name", "color", "order", "is_won", "is_lost")
SELECT gen_random_uuid(), p."id", s.name, s.color, s.ord, s.is_won, s.is_lost
FROM "pipelines" p
CROSS JOIN (VALUES
    ('Новая', '#94a3b8', 0, false, false),
    ('В работе', '#4f46e5', 1, false, false),
    ('Успешно', '#16a34a', 2, true, false),
    ('Отказ', '#dc2626', 3, false, true)
) AS s(name, color, ord, is_won, is_lost);

-- Backfill: a Deal for every existing, non-redacted Lead — dropped into that
-- company's default pipeline's first ("Новая") stage. amount/customFields
-- stay empty; the owner fills those in going forward.
INSERT INTO "deals" ("id", "company_id", "bot_id", "lead_id", "dialog_id", "title", "name", "phone", "email", "stage_id", "source", "created_at", "updated_at")
SELECT
    gen_random_uuid(),
    b."company_id",
    b."id",
    l."id",
    d."id",
    COALESCE('Заявка от ' || l."name", 'Заявка из Умного Чата'),
    l."name",
    l."phone",
    l."email",
    ps."id",
    'chat',
    l."created_at",
    l."created_at"
FROM "leads" l
JOIN "dialogs" d ON d."id" = l."dialog_id"
JOIN "bots" b ON b."id" = d."bot_id"
JOIN "pipelines" p ON p."company_id" = b."company_id" AND p."is_default" = true
JOIN "pipeline_stages" ps ON ps."pipeline_id" = p."id" AND ps."order" = 0
WHERE l."redacted_at" IS NULL;

-- Backfill: a Deal for every completed self-sell provisioned registration —
-- same originating-bot lookup CrmIntegrationService.findProvisioningOrigin
-- uses (Dialog.visitor_meta->'provisioning'->>'companyId'), first matching
-- dialog per company.
INSERT INTO "deals" ("id", "company_id", "bot_id", "dialog_id", "title", "name", "email", "stage_id", "source", "created_at", "updated_at")
SELECT
    gen_random_uuid(),
    c."id",
    origin.bot_id,
    origin.dialog_id,
    COALESCE('Регистрация: ' || c."name", 'Заявка из Умного Чата'),
    u."name",
    u."email",
    ps."id",
    'provisioning',
    c."registered_at",
    c."registered_at"
FROM "companies" c
JOIN LATERAL (
    SELECT d."id" AS dialog_id, d."bot_id" AS bot_id
    FROM "dialogs" d
    WHERE d."visitor_meta"->'provisioning'->>'companyId' = c."id"
    LIMIT 1
) origin ON true
JOIN "pipelines" p ON p."company_id" = c."id" AND p."is_default" = true
JOIN "pipeline_stages" ps ON ps."pipeline_id" = p."id" AND ps."order" = 0
LEFT JOIN LATERAL (
    SELECT u2."name", u2."email" FROM "users" u2 WHERE u2."company_id" = c."id" ORDER BY u2."created_at" ASC LIMIT 1
) u ON true
WHERE c."registered_at" IS NOT NULL;
