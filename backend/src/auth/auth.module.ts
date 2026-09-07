import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { SupportGuard } from './support.guard';
import { BlockDuringImpersonationGuard } from './block-during-impersonation.guard';

@Module({
  providers: [AuthService, AuthGuard, SupportGuard, BlockDuringImpersonationGuard],
  exports: [AuthService, AuthGuard, SupportGuard, BlockDuringImpersonationGuard],
})
export class AuthModule {}
