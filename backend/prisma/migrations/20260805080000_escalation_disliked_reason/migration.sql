-- AlterEnum
ALTER TYPE "EscalationReason" ADD VALUE 'disliked';

-- AlterTable
ALTER TABLE "escalations" ADD COLUMN "disliked_message_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "escalations_disliked_message_id_key" ON "escalations"("disliked_message_id");
