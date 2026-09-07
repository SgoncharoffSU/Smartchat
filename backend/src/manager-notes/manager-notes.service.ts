import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Deliberately NOT a duplicate of CabinetService.getReadiness (the real,
 * auto-detected, owner-actionable "Статус внедрения" checklist already
 * driving the client-facing percent). This is the one thing that checklist
 * has no room for on purpose: the manager's own note from the "Знакомство с
 * менеджером" call — internal only, never shown to the client, no weight in
 * anyone's percent. Superadmin-only, see ManagerNotesAdminController.
 *
 * Also owns the per-bot "взять в работу" lock (see bot-lock.util.ts's own
 * comment) — same "Внедрение" admin tab, same per-bot row, so it lives here
 * rather than a separate module.
 */
@Injectable()
export class ManagerNotesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForAdmin() {
    const bots = await this.prisma.bot.findMany({
      select: {
        id: true,
        name: true,
        label: true,
        managerNote: true,
        managerLockedAt: true,
        company: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return bots.map((bot) => ({
      botId: bot.id,
      botLabel: bot.label || bot.name,
      companyName: bot.company.name,
      managerNote: bot.managerNote ?? '',
      locked: bot.managerLockedAt !== null,
    }));
  }

  async updateNote(botId: string, note: string) {
    const bot = await this.prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
    if (!bot) throw new NotFoundException('Bot not found');
    await this.prisma.bot.update({ where: { id: botId }, data: { managerNote: note.trim() } });
    return { ok: true };
  }

  /** "Взять в работу" — pauses the owner's own edits (see bot-lock.util.ts) until released. */
  async lock(botId: string) {
    const bot = await this.prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
    if (!bot) throw new NotFoundException('Bot not found');
    // Also clears any stale managerLockAckNeeded from a PRIOR unlock — a
    // quick unlock-then-relock before the owner ever opens the cabinet
    // would otherwise leave both the "locked" banner and the "you can edit
    // again" dialog showing at once (found via code-review).
    await this.prisma.bot.update({ where: { id: botId }, data: { managerLockedAt: new Date(), managerLockAckNeeded: false } });
    return { ok: true };
  }

  /**
   * "Закончил" — releases the lock and arms the one-time "правки могут
   * ухудшить результат" acknowledgment the owner sees on their NEXT edit
   * attempt (see cabinet.controller.ts's acknowledgeLock).
   */
  async unlock(botId: string) {
    const bot = await this.prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
    if (!bot) throw new NotFoundException('Bot not found');
    await this.prisma.bot.update({
      where: { id: botId },
      data: { managerLockedAt: null, managerLockAckNeeded: true },
    });
    return { ok: true };
  }
}
