-- AlterTable
ALTER TABLE "messages" ADD COLUMN "disliked_at" TIMESTAMP(3),
ADD COLUMN "dislike_note" TEXT,
ADD COLUMN "dislike_resolution" TEXT,
ADD COLUMN "dislike_resolved_at" TIMESTAMP(3);
