-- AlterTable
ALTER TABLE "bots" ADD COLUMN "manager_locked_at" TIMESTAMP(3);
ALTER TABLE "bots" ADD COLUMN "manager_lock_ack_needed" BOOLEAN NOT NULL DEFAULT false;
