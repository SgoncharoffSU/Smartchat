import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Throttles widget messages per (botToken, sessionId) pair instead of per IP,
 * since many visitors can share an IP and a single visitor's sessionId is the
 * meaningful unit to bound.
 */
@Injectable()
export class SessionThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const botToken = req.body?.botToken || req.query?.botToken || 'unknown-bot';
    const sessionId = req.body?.sessionId || req.query?.sessionId || 'unknown-session';
    return `${botToken}:${sessionId}`;
  }
}
