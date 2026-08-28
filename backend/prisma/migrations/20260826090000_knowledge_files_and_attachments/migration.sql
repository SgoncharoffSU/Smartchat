-- AlterTable
ALTER TABLE "knowledge_entries" ADD COLUMN     "file_url" TEXT,
ADD COLUMN     "file_name" TEXT,
ADD COLUMN     "file_mime_type" TEXT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "attachment_url" TEXT,
ADD COLUMN     "attachment_name" TEXT,
ADD COLUMN     "attachment_mime_type" TEXT;
