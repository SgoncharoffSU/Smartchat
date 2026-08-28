import { BadRequestException, Body, Controller, HttpCode, Post } from '@nestjs/common';
import { BillingService } from '../payments/billing.service';

/**
 * YooKassa POSTs here on every payment status change (configured as the
 * merchant's HTTP notification URL in the YooKassa dashboard). The body
 * itself is NEVER trusted — an unauthenticated POST is trivially fakeable —
 * BillingService.verifyAndConfirmPayment re-fetches the real status
 * directly from YooKassa (our own credentials) before crediting anything.
 */
@Controller('api/webhooks/yookassa')
export class YookassaWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post()
  @HttpCode(200)
  async handle(@Body() body: { event?: string; object?: { id?: string } }) {
    const yookassaPaymentId = body?.object?.id;
    if (!yookassaPaymentId) throw new BadRequestException('Missing object.id');
    await this.billing.verifyAndConfirmPayment(yookassaPaymentId);
    return { ok: true };
  }
}
