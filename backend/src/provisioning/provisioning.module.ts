import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { YandexGptModule } from '../yandex-gpt/yandex-gpt.module';
import { SiteAnalysisModule } from '../site-analysis/site-analysis.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { TelegramModule } from '../telegram/telegram.module';
import { CabinetModule } from '../cabinet/cabinet.module';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningRateLimiterService } from './provisioning-rate-limiter.service';
import { ProvisioningController } from './provisioning.controller';

@Module({
  imports: [YandexGptModule, SiteAnalysisModule, KnowledgeModule, TelegramModule, CabinetModule],
  controllers: [ProvisioningController],
  providers: [ProvisioningService, ProvisioningRateLimiterService, PrismaService],
  exports: [ProvisioningService],
})
export class ProvisioningModule {}
