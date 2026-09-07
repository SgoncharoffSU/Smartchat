import { ForbiddenException } from '@nestjs/common';

/**
 * The manager "берёт бота в работу" while actively setting it up (see
 * ManagerNotesService.lock/unlock) — pauses the owner's own configuration
 * edits for the duration. Bypassed entirely during impersonation (that's
 * the manager's own session, the one actually doing the work). Found live:
 * "теоретически пользователь может мешать настроить бота?... блокировка
 * нужна, когда назначается ответственный менеджер (берет в работу)".
 *
 * Deliberately narrow: only the structural "how this bot is set up" actions
 * (appearance/widget, goal, greeting variants, CRM connection) — knowledge
 * base articles, answering real customer escalations, CRM deals, and stats
 * reset are never gated by this (see each call site's own comment for why).
 */
export function assertBotUnlockedForOwner(managerLockedAt: Date | null, impersonating: boolean): void {
  if (managerLockedAt && !impersonating) {
    throw new ForbiddenException('Сейчас бота настраивает ваш менеджер внедрения — дождитесь окончания или обратитесь к нему');
  }
}
