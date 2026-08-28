import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface YookassaCredentials {
  shopId: string;
  secretKey: string;
}

/**
 * Singleton settings row (always exactly one — see ensureRow) holding the
 * YooKassa shopId/secretKey a superadmin pastes into the admin panel. Same
 * shape as LlmProviderService: cached in memory, refreshed the instant the
 * admin saves new credentials, never sent back to the frontend in full.
 * Global (not per-company) because one "Умный Чат" YooKassa merchant
 * account collects every client's payment, not one account per client.
 */
@Injectable()
export class PaymentSettingsService implements OnModuleInit {
  private cached: YookassaCredentials | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.refreshCache();
  }

  private async ensureRow() {
    const existing = await this.prisma.paymentSettings.findFirst();
    if (existing) return existing;
    return this.prisma.paymentSettings.create({ data: {} });
  }

  private async refreshCache() {
    const row = await this.ensureRow();
    this.cached = row.shopId && row.secretKey ? { shopId: row.shopId, secretKey: row.secretKey } : null;
  }

  /** Null means "not configured yet" — YookassaService throws a clear error
   * rather than silently failing a real checkout attempt. */
  getCredentials(): YookassaCredentials | null {
    return this.cached;
  }

  /** Superadmin view — secretKey is never sent back in full, same masking
   * convention as LlmProviderService.list's apiKeyPreview. */
  async get() {
    const row = await this.ensureRow();
    return {
      shopId: row.shopId ?? '',
      secretKeyPreview: row.secretKey ? `••••${row.secretKey.slice(-4)}` : '',
      configured: Boolean(row.shopId && row.secretKey),
    };
  }

  // secretKey is only ever sent back MASKED (see get() above), so an admin
  // editing just the shopId has no real value to resubmit for it — an empty
  // secretKey here means "leave the stored one alone", not "clear it".
  // shopId isn't sensitive (shown in full in the form), so it always takes
  // whatever was submitted, blank included.
  async update(input: { shopId: string; secretKey: string }) {
    const shopId = input.shopId.trim();
    const secretKey = input.secretKey.trim();
    const row = await this.ensureRow();
    await this.prisma.paymentSettings.update({
      where: { id: row.id },
      data: { shopId: shopId || null, ...(secretKey ? { secretKey } : {}) },
    });
    await this.refreshCache();
    return { ok: true };
  }
}
