import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { SupportGuard } from './support.guard';

@Module({
  providers: [AuthService, AuthGuard, SupportGuard],
  exports: [AuthService, AuthGuard, SupportGuard],
})
export class AuthModule {}
