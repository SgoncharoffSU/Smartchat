-- AlterTable
ALTER TABLE "bots" ADD COLUMN "pending_site_knowledge" TEXT;

-- AlterTable
ALTER TABLE "escalations" ADD COLUMN "visitor_question" TEXT;
