import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PaymentSettingsService } from './payment-settings.service';
import { SupportGuard } from '../auth/support.guard';

/** Superadmin-only, applies platform-wide — one YooKassa merchant account
 * collects for every company, same convention as LlmProviderAdminController. */
@Controller('api/admin/payment-settings')
@UseGuards(SupportGuard)
export class PaymentSettingsAdminController {
  constructor(private readonly settings: PaymentSettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Post()
  update(@Body() body: { shopId: string; secretKey: string }) {
    return this.settings.update(body);
  }
}
