import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PaymentSettingsService } from './payment-settings.service';

export interface YookassaPayment {
  id: string;
  status: string; // 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled'
  paid: boolean;
  confirmationUrl: string | null;
  metadata: Record<string, string>;
}

/**
 * Thin wrapper over YooKassa's REST API v3 — https://yookassa.ru/developers/api.
 * Both calls this needs (create + read-back) use HTTP Basic auth with
 * shopId:secretKey, exactly as YooKassa's docs specify (not a session token,
 * no SDK dependency needed for two endpoints).
 */
@Injectable()
export class YookassaService {
  private readonly logger = new Logger(YookassaService.name);
  private readonly baseUrl = 'https://api.yookassa.ru/v3';

  constructor(private readonly settings: PaymentSettingsService) {}

  private authHeader(): string {
    const creds = this.settings.getCredentials();
    if (!creds) {
      throw new Error('YooKassa is not configured yet — set shopId/secretKey in the admin panel first');
    }
    return 'Basic ' + Buffer.from(`${creds.shopId}:${creds.secretKey}`).toString('base64');
  }

  /**
   * idempotenceKey defaults to a fresh UUID per call — pass the SAME one in
   * only if a caller needs to safely retry an identical request (we don't
   * today, PaymentsService creates exactly one Payment row per attempt).
   */
  async createPayment(input: {
    amountRub: string; // "1.00" — already formatted with 2 decimals, see PaymentsService
    description: string;
    returnUrl: string;
    metadata: Record<string, string>;
  }): Promise<YookassaPayment> {
    const response = await fetch(`${this.baseUrl}/payments`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        'Idempotence-Key': randomUUID(),
      },
      body: JSON.stringify({
        amount: { value: input.amountRub, currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: input.returnUrl },
        capture: true,
        description: input.description,
        metadata: input.metadata,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`YooKassa createPayment failed: ${response.status} ${errorText}`);
      throw new Error(`YooKassa createPayment failed with status ${response.status}`);
    }
    const data = await response.json();
    return this.mapPayment(data);
  }

  /**
   * The ONLY thing PaymentsWebhookController trusts — a webhook body is
   * never credited on its own (an unauthenticated POST body is trivially
   * fakeable). Reading the payment back with OUR OWN credentials confirms
   * the real status directly from YooKassa, so a spoofed webhook call can't
   * forge a "succeeded" that never happened on their side.
   */
  async getPayment(yookassaPaymentId: string): Promise<YookassaPayment> {
    const response = await fetch(`${this.baseUrl}/payments/${yookassaPaymentId}`, {
      headers: { Authorization: this.authHeader() },
    });
    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`YooKassa getPayment failed: ${response.status} ${errorText}`);
      throw new Error(`YooKassa getPayment failed with status ${response.status}`);
    }
    const data = await response.json();
    return this.mapPayment(data);
  }

  private mapPayment(data: any): YookassaPayment {
    return {
      id: data.id,
      status: data.status,
      paid: data.paid === true,
      confirmationUrl: data.confirmation?.confirmation_url ?? null,
      metadata: data.metadata ?? {},
    };
  }
}
