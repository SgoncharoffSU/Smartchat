-- DropColumn (superseded by per-entry moderation below)
ALTER TABLE "bots" DROP COLUMN IF EXISTS "pending_site_knowledge";

-- CreateEnum
CREATE TYPE "KnowledgeModerationStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "knowledge_categories" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_categories_company_id_idx" ON "knowledge_categories"("company_id");

-- AddForeignKey
ALTER TABLE "knowledge_categories" ADD CONSTRAINT "knowledge_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "knowledge_entries" ADD COLUMN "category_id" TEXT;
ALTER TABLE "knowledge_entries" ADD COLUMN "moderation_status" "KnowledgeModerationStatus" NOT NULL DEFAULT 'approved';

-- CreateIndex
CREATE INDEX "knowledge_entries_category_id_idx" ON "knowledge_entries"("category_id");

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "knowledge_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
