import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { SupportGuard } from './support.guard';
import { BlockDuringImpersonationGuard } from './block-during-impersonation.guard';
import { RequireImpersonationGuard } from './require-impersonation.guard';

@Module({
  providers: [AuthService, AuthGuard, SupportGuard, BlockDuringImpersonationGuard, RequireImpersonationGuard],
  exports: [AuthService, AuthGuard, SupportGuard, BlockDuringImpersonationGuard, RequireImpersonationGuard],
})
export class AuthModule {}
