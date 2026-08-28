-- AlterEnum
ALTER TYPE "KnowledgeSource" ADD VALUE 'bulk';

-- AlterEnum
ALTER TYPE "AiUsageKind" ADD VALUE 'generation';

-- AlterTable
ALTER TABLE "escalations" ADD COLUMN "draft_answer" TEXT;
ALTER TABLE "escalations" ADD COLUMN "draft_message_id" TEXT;

-- AlterTable
ALTER TABLE "dialogs" ADD COLUMN "is_preview" BOOLEAN NOT NULL DEFAULT false;
