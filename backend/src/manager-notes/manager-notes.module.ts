import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ManagerNotesService } from './manager-notes.service';
import { ManagerNotesAdminController } from './manager-notes-admin.controller';

@Module({
  // SupportGuard (ManagerNotesAdminController) needs AuthService — same
  // "found live" startup-DI note as PaymentsModule's own.
  imports: [AuthModule],
  controllers: [ManagerNotesAdminController],
  providers: [PrismaService, ManagerNotesService],
})
export class ManagerNotesModule {}
