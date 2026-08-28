-- AlterEnum
ALTER TYPE "KnowledgeSource" ADD VALUE 'correction';

-- AlterTable
ALTER TABLE "knowledge_entries" ADD COLUMN "bad_example" TEXT;
