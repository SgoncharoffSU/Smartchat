import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { CompaniesModule } from './companies/companies.module';
import { BotsModule } from './bots/bots.module';
import { DialogsModule } from './dialogs/dialogs.module';
import { MessagesModule } from './messages/messages.module';
import { LeadsModule } from './leads/leads.module';
import { YandexGptModule } from './yandex-gpt/yandex-gpt.module';
import { WidgetModule } from './widget/widget.module';
import { WidgetController } from './widget/widget.controller';
import { widgetCorsMiddleware } from './widget/widget-cors.middleware';
import { AuthModule } from './auth/auth.module';
import { ProvisioningModule } from './provisioning/provisioning.module';
import { SiteAnalysisModule } from './site-analysis/site-analysis.module';
import { CabinetModule } from './cabinet/cabinet.module';
import { TelegramModule } from './telegram/telegram.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { DislikesModule } from './dislikes/dislikes.module';
import { SupportTicketsModule } from './support-tickets/support-tickets.module';
import { LlmProviderModule } from './llm-provider/llm-provider.module';
import { DealsModule } from './deals/deals.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { PaymentsModule } from './payments/payments.module';

@Module({
  imports: [
    // ThrottlerModule.forRoot is @Global() — registering it more than once (one
    // call per feature module) makes two competing global providers for the
    // same token, and one silently wins app-wide (found live: the widget's
    // "widget-session" limit was being enforced on cabinet login instead of
    // "cabinet-login"). Every named throttler used anywhere in the app must be
    // declared in this single call.
    ThrottlerModule.forRoot([
      {
        name: 'widget-session',
        ttl: 60_000,
        limit: Number(process.env.WIDGET_SESSION_RATE_LIMIT ?? 10),
      },
      {
        name: 'cabinet-login',
        ttl: 5 * 60_000,
        limit: Number(process.env.CABINET_LOGIN_RATE_LIMIT ?? 5),
      },
    ]),
    CompaniesModule,
    BotsModule,
    DialogsModule,
    MessagesModule,
    LeadsModule,
    YandexGptModule,
    WidgetModule,
    AuthModule,
    SiteAnalysisModule,
    ProvisioningModule,
    CabinetModule,
    TelegramModule,
    KnowledgeModule,
    DislikesModule,
    SupportTicketsModule,
    LlmProviderModule,
    DealsModule,
    WebhooksModule,
    PaymentsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(widgetCorsMiddleware).forRoutes(WidgetController);
  }
}
