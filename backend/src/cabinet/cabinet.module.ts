import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { YandexGptModule } from '../yandex-gpt/yandex-gpt.module';
import { EmailModule } from '../email/email.module';
import { LeadsModule } from '../leads/leads.module';
import { CabinetController } from './cabinet.controller';
import { CabinetService } from './cabinet.service';
import { LoginThrottlerGuard } from './login-throttler.guard';

@Module({
  imports: [
    // Throttler config (including the "cabinet-login" limit used below) is
    // registered once, app-wide, in AppModule — see the comment there.
    AuthModule,
    TelegramModule,
    KnowledgeModule,
    YandexGptModule,
    EmailModule,
    // Just for CrmIntegrationService — register() pushes a completed
    // self-sell registration to CRM the same way a normal lead capture does.
    LeadsModule,
  ],
  controllers: [CabinetController],
  providers: [CabinetService, PrismaService, LoginThrottlerGuard],
  exports: [CabinetService],
})
export class CabinetModule {}
