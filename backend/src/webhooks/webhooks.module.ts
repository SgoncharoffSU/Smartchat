import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { LeadsModule } from '../leads/leads.module';
import { PaymentsModule } from '../payments/payments.module';
import { Bitrix24WebhookController } from './bitrix24-webhook.controller';
import { YookassaWebhookController } from './yookassa-webhook.controller';

@Module({
  imports: [LeadsModule, PaymentsModule],
  controllers: [Bitrix24WebhookController, YookassaWebhookController],
  providers: [PrismaService],
})
export class WebhooksModule {}
