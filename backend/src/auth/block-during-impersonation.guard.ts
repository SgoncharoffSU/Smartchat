import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * Blocks writes to the CLIENT'S ACCOUNT layer during a support impersonation
 * session — company name, notification/contact settings, team membership,
 * billing. Support can still configure the BOT itself while impersonating
 * (knowledge, funnel, appearance, CRM integrations, deal/dialog actions) —
 * that's the whole point of "Войти" (see CompaniesAdminController's own
 * comment: "lets a support agent actually configure a real client's bot").
 * Found live: "сотрудник поддержки не должен иметь возможность менять
 * данные аккаунта клиента... поддержка должна... влиять на самого бота."
 *
 * Stack AFTER AuthGuard (needs req.impersonating, set there) — order matters
 * since Nest runs guards in the array's order:
 * `@UseGuards(AuthGuard, BlockDuringImpersonationGuard)`.
 */
@Injectable()
export class BlockDuringImpersonationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    // Fail closed: blocks unless req.impersonating is the CONFIRMED `false`
    // AuthGuard always sets, not just "not yet true" — if this guard is
    // ever misordered ahead of AuthGuard, or AuthGuard is left off a future
    // route, req.impersonating is undefined and a plain truthy check would
    // silently let the write through instead of denying it.
    if (req.impersonating !== false) {
      throw new ForbiddenException('Недоступно в режиме поддержки — это данные аккаунта клиента, а не настройки бота');
    }
    return true;
  }
}
