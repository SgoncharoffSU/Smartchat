-- AlterTable
ALTER TABLE "knowledge_entries" ADD COLUMN "embedding" JSONB;

-- CreateEnum
CREATE TYPE "AiUsageKind" AS ENUM ('embedding');

-- CreateTable
CREATE TABLE "ai_usage_events" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "kind" "AiUsageKind" NOT NULL,
    "tokens" INTEGER NOT NULL,
    "estimated_cost_rub" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_events_bot_id_created_at_idx" ON "ai_usage_events"("bot_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
