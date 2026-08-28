import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Throttles cabinet login/forgot-password attempts per (IP, email) pair —
 * bounds credential-stuffing against a single account without letting one
 * noisy IP (e.g. an office NAT) lock out every account behind it.
 */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const email = String(req.body?.email || 'unknown-email').toLowerCase();
    return `${req.ip}:${email}`;
  }
}
