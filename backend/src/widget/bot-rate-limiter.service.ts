import { Injectable } from '@nestjs/common';

/**
 * Simple in-memory sliding-window limiter, keyed by widget token, to bound
 * YandexGPT spend per bot. Single-instance MVP only — move to Redis if the
 * backend ever runs on more than one instance.
 */
@Injectable()
export class BotRateLimiterService {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs = 60_000;
  private readonly limit = Number(process.env.WIDGET_BOT_RATE_LIMIT ?? 60);

  isAllowed(botToken: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(botToken) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(botToken, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(botToken, recent);
    return true;
  }
}
