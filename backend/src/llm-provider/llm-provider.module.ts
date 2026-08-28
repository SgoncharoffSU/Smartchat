import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { LlmProviderService } from './llm-provider.service';
import { LlmProviderAdminController } from './llm-provider-admin.controller';

@Module({
  imports: [AuthModule],
  controllers: [LlmProviderAdminController],
  providers: [LlmProviderService, PrismaService],
  exports: [LlmProviderService],
})
export class LlmProviderModule {}
