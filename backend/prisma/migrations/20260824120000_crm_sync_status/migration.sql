-- AlterTable
ALTER TABLE "leads" ADD COLUMN "bitrix24_synced_at" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN "amocrm_synced_at" TIMESTAMP(3);
