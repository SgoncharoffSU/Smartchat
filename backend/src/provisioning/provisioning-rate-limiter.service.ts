import { Injectable } from '@nestjs/common';

/**
 * Simple in-memory sliding-window limiter, keyed by visitor IP, bounding how
 * many new companies can be auto-provisioned from the same source in a day —
 * basic abuse protection since this trigger has no human moderation step.
 * Single-instance MVP only, same caveat as BotRateLimiterService.
 */
@Injectable()
export class ProvisioningRateLimiterService {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs = 24 * 60 * 60 * 1000;
  private readonly limit = Number(process.env.PROVISIONING_RATE_LIMIT_PER_DAY ?? 3);

  isAllowed(ip: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    return true;
  }
}
