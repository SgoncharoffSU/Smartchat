import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = req.cookies?.[this.auth.cookieName];
    if (!token) throw new UnauthorizedException('Not signed in');

    const payload = this.auth.verifySession(token);
    if (!payload) throw new UnauthorizedException('Session expired or invalid');

    req.companyId = payload.companyId;
    req.userId = payload.userId;
    req.role = payload.role ?? 'owner';
    req.companyRole = payload.companyRole ?? 'owner';
    req.impersonating = payload.impersonating === true;
    return true;
  }
}
