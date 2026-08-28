import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { LeadsService } from './leads.service';
import { CrmIntegrationService } from './crm-integration.service';
import { AmoCrmPollService } from './amocrm-poll.service';

@Module({
  providers: [LeadsService, CrmIntegrationService, AmoCrmPollService, PrismaService],
  exports: [LeadsService, CrmIntegrationService],
})
export class LeadsModule {}
