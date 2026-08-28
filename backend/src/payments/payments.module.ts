import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { LlmProviderModule } from '../llm-provider/llm-provider.module';
import { PaymentSettingsService } from './payment-settings.service';
import { YookassaService } from './yookassa.service';
import { BillingService } from './billing.service';
import { PaymentsController } from './payments.controller';
import { PaymentSettingsAdminController } from './payment-settings-admin.controller';

@Module({
  // AuthGuard (PaymentsController) and SupportGuard (PaymentSettingsAdmin-
  // Controller) both need AuthService — found live: omitting this import
  // failed the whole app's startup with a DI resolution error, not just a
  // 401 at request time.
  imports: [AuthModule, LlmProviderModule],
  controllers: [PaymentsController, PaymentSettingsAdminController],
  providers: [PrismaService, PaymentSettingsService, YookassaService, BillingService],
  // BillingService (chargeTokenUsage/isBlocked) is used from YandexGptService
  // and WidgetService — exported so those modules can inject it without
  // duplicating YooKassa/settings wiring.
  exports: [BillingService],
})
export class PaymentsModule {}
