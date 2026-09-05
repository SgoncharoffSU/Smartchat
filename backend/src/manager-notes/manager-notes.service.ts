import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Deliberately NOT a duplicate of CabinetService.getReadiness (the real,
 * auto-detected, owner-actionable "Статус внедрения" checklist already
 * driving the client-facing percent). This is the one thing that checklist
 * has no room for on purpose: the manager's own note from the "Знакомство с
 * менеджером" call — internal only, never shown to the client, no weight in
 * anyone's percent. Superadmin-only, see ManagerNotesAdminController.
 */
@Injectable()
export class ManagerNotesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForAdmin() {
    const bots = await this.prisma.bot.findMany({
      select: { id: true, name: true, label: true, managerNote: true, company: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return bots.map((bot) => ({
      botId: bot.id,
      botLabel: bot.label || bot.name,
      companyName: bot.company.name,
      managerNote: bot.managerNote ?? '',
    }));
  }

  async updateNote(botId: string, note: string) {
    const bot = await this.prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
    if (!bot) throw new NotFoundException('Bot not found');
    await this.prisma.bot.update({ where: { id: botId }, data: { managerNote: note.trim() } });
    return { ok: true };
  }
}
