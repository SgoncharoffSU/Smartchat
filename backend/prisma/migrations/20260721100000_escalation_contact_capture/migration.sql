-- AlterTable
ALTER TABLE "escalations" ADD COLUMN "contact_phone" TEXT;
ALTER TABLE "escalations" ADD COLUMN "contact_email" TEXT;
ALTER TABLE "escalations" ADD COLUMN "contact_sent_at" TIMESTAMP(3);
