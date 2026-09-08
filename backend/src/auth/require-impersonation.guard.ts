import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/**
 * The mirror image of BlockDuringImpersonationGuard — requires support
 * impersonation instead of blocking it. For the deepest, most technical
 * layer of a bot's setup (the funnel/scenario STRUCTURE — see
 * CabinetController's own funnel endpoints): the owner's cabinet doesn't
 * even show this section, and the API refuses it too (defense in depth,
 * not just a hidden button) — a stageId typo or a stray exitCondition value
 * (only 'handoff'/'closed' mean anything to WidgetService's own state
 * machine) can silently break the whole conversation, unlike an
 * instructions-text tweak. Found live: "системные инструкции должны быть
 * доступны только менеджерам, а другие пользователю."
 *
 * Stack AFTER AuthGuard (needs req.impersonating, set there):
 * `@UseGuards(AuthGuard, RequireImpersonationGuard)`.
 */
@Injectable()
export class RequireImpersonationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.impersonating !== true) {
      throw new ForbiddenException('Доступно только менеджеру в режиме поддержки');
    }
    return true;
  }
}
