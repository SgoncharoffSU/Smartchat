-- CreateEnum
CREATE TYPE "EscalationReason" AS ENUM ('unanswered', 'dissatisfaction');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "telegram_chat_id" TEXT,
ADD COLUMN     "telegram_connect_token" TEXT;

-- CreateTable
CREATE TABLE "escalations" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "dialog_id" TEXT,
    "reason" "EscalationReason" NOT NULL,
    "question" TEXT NOT NULL,
    "bot_reply" TEXT,
    "telegram_message_id" TEXT,
    "answer" TEXT,
    "answered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "companies_telegram_connect_token_key" ON "companies"("telegram_connect_token");

-- CreateIndex
CREATE INDEX "escalations_bot_id_answered_at_idx" ON "escalations"("bot_id", "answered_at");

-- CreateIndex
CREATE INDEX "escalations_telegram_message_id_idx" ON "escalations"("telegram_message_id");

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
