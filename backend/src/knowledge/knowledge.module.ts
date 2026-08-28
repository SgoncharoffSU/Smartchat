import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { SiteAnalysisModule } from '../site-analysis/site-analysis.module';
import { YandexGptModule } from '../yandex-gpt/yandex-gpt.module';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';

@Module({
  imports: [AuthModule, SiteAnalysisModule, YandexGptModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, PrismaService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
