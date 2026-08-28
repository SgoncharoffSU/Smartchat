-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "notify_leads_via_telegram" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notification_email" TEXT;
