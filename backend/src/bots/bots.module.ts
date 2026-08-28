import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { BotsService } from './bots.service';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  imports: [KnowledgeModule],
  providers: [BotsService, PrismaService],
  exports: [BotsService],
})
export class BotsModule {}
