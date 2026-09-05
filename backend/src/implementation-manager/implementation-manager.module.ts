import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ImplementationManagerService } from './implementation-manager.service';
import { ImplementationManagerController } from './implementation-manager.controller';
import { ImplementationManagerAdminController } from './implementation-manager-admin.controller';

@Module({
  // AuthGuard (ImplementationManagerController) and SupportGuard
  // (ImplementationManagerAdminController) both need AuthService — same
  // "found live" startup-DI note as PaymentsModule's own.
  imports: [AuthModule],
  controllers: [ImplementationManagerController, ImplementationManagerAdminController],
  providers: [PrismaService, ImplementationManagerService],
})
export class ImplementationManagerModule {}
