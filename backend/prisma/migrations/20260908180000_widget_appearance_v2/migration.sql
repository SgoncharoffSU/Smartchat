-- AlterTable
ALTER TABLE "bots" ADD COLUMN "chat_background_color" TEXT NOT NULL DEFAULT '#ffffff',
ADD COLUMN "send_button_color" TEXT NOT NULL DEFAULT '#4f46e5',
ADD COLUMN "teaser_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "teaser_text" TEXT,
ADD COLUMN "teaser_delay_seconds" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN "teaser_buttons" JSONB,
ADD COLUMN "teaser_bg_color" TEXT NOT NULL DEFAULT '#ffffff',
ADD COLUMN "teaser_button_color" TEXT NOT NULL DEFAULT '#f5f5f7';

-- Backfill: every existing bot's single "Акцентный цвет" (widget_color) used
-- to drive the send button/message-bubble color too — without this, the
-- moment this migration runs, every live bot's send button would silently
-- flip from whatever accent they'd actually configured back to the bare
-- column default (#4f46e5), independent of the header color it still
-- matches. Only send_button_color needs this: chat_background_color is a
-- genuinely new capability with no prior value (white either way), and
-- widget_color itself (now "Цвет шапки") isn't changing at all.
UPDATE "bots" SET "send_button_color" = "widget_color";
