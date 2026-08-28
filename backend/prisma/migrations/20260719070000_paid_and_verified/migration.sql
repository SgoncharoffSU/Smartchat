-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "paid_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "escalations" ADD COLUMN     "verified_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "escalations_bot_id_verified_at_idx" ON "escalations"("bot_id", "verified_at");
