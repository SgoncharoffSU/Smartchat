import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { CompaniesService } from './companies.service';
import { CompaniesAdminController } from './companies-admin.controller';

@Module({
  imports: [AuthModule],
  controllers: [CompaniesAdminController],
  providers: [CompaniesService, PrismaService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
