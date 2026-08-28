import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { EmailModule } from '../email/email.module';
import { SupportTicketsService } from './support-tickets.service';
import { SupportTicketsController } from './support-tickets.controller';
import { SupportTicketsAdminController } from './support-tickets-admin.controller';

@Module({
  imports: [AuthModule, TelegramModule, EmailModule],
  controllers: [SupportTicketsController, SupportTicketsAdminController],
  providers: [SupportTicketsService, PrismaService],
})
export class SupportTicketsModule {}
