import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { LeadsModule } from '../leads/leads.module';
import { DealsController } from './deals.controller';
import { DealsService } from './deals.service';

@Module({
  imports: [AuthModule, LeadsModule],
  controllers: [DealsController],
  providers: [DealsService, PrismaService],
  exports: [DealsService],
})
export class DealsModule {}
