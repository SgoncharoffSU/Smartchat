-- AlterTable (table is empty in production — safe to add NOT NULL directly, no backfill needed)
ALTER TABLE "knowledge_categories" ADD COLUMN "bot_id" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "knowledge_categories_bot_id_idx" ON "knowledge_categories"("bot_id");

-- AddForeignKey
ALTER TABLE "knowledge_categories" ADD CONSTRAINT "knowledge_categories_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
