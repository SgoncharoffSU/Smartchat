import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { TelegramService } from './telegram.service';

@Controller('api/telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  // Telegram calls this directly (no cabinet session) — authenticated instead
  // via the secret_token registered with setWebhook, echoed back on every
  // real call as this header. Same class of protection as the /api/widget/coach
  // fix: a public URL must not accept writes just because the shape looks right.
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Body() update: unknown, @Headers('x-telegram-bot-api-secret-token') secret: string) {
    if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      throw new UnauthorizedException();
    }
    await this.telegram.handleUpdate(update as Parameters<TelegramService['handleUpdate']>[0]);
    return { ok: true };
  }
}
