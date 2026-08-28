import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { BotsModule } from '../bots/bots.module';
import { DialogsModule } from '../dialogs/dialogs.module';
import { MessagesModule } from '../messages/messages.module';
import { LeadsModule } from '../leads/leads.module';
import { YandexGptModule } from '../yandex-gpt/yandex-gpt.module';
import { ProvisioningModule } from '../provisioning/provisioning.module';
import { SiteAnalysisModule } from '../site-analysis/site-analysis.module';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { CabinetModule } from '../cabinet/cabinet.module';
import { EmailModule } from '../email/email.module';
import { PaymentsModule } from '../payments/payments.module';
import { WidgetController } from './widget.controller';
import { WidgetService } from './widget.service';
import { BotRateLimiterService } from './bot-rate-limiter.service';

@Module({
  imports: [
    // Throttler config (including the "widget-session" limit used below) is
    // registered once, app-wide, in AppModule — see the comment there.
    BotsModule,
    DialogsModule,
    MessagesModule,
    LeadsModule,
    YandexGptModule,
    ProvisioningModule,
    SiteAnalysisModule,
    AuthModule,
    TelegramModule,
    KnowledgeModule,
    CabinetModule,
    EmailModule,
    PaymentsModule,
  ],
  controllers: [WidgetController],
  providers: [WidgetService, PrismaService, BotRateLimiterService],
  // DislikesModule reuses previewCorrectedReply so a preview regenerates
  // with the exact same live prompt-building logic the bot itself runs.
  exports: [WidgetService],
})
export class WidgetModule {}
