import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

/**
 * Same session cookie as AuthGuard, but additionally requires role ===
 * 'support' — used only on the small set of routes that read/act ACROSS
 * companies (the support ticket queue). A regular owner's session, even a
 * valid one, is rejected here rather than silently scoped to their own
 * company: those routes have no meaning scoped to one company, so a normal
 * user hitting them is a mistake or probing, not a case to quietly handle.
 */
@Injectable()
export class SupportGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = req.cookies?.[this.auth.cookieName];
    if (!token) throw new UnauthorizedException('Not signed in');

    const payload = this.auth.verifySession(token);
    if (!payload) throw new UnauthorizedException('Session expired or invalid');
    if (payload.role !== 'support') throw new ForbiddenException('Support access required');

    req.companyId = payload.companyId;
    req.userId = payload.userId;
    req.role = payload.role;
    return true;
  }
}
