import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { FunnelStage } from '../yandex-gpt/yandex-gpt.types';

@Injectable()
export class BotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly knowledge: KnowledgeService,
  ) {}

  async findActiveByWidgetToken(widgetToken: string) {
    return this.prisma.bot.findFirst({
      where: { widgetToken, isActive: true },
      include: { company: true },
    });
  }

  getFunnelStages(bot: { funnelConfig: unknown }): FunnelStage[] {
    return Array.isArray(bot.funnelConfig) ? (bot.funnelConfig as unknown as FunnelStage[]) : [];
  }

  getInitialStage(bot: { funnelConfig: unknown }): FunnelStage | undefined {
    return this.getFunnelStages(bot)[0];
  }

  /** Returns undefined if stageId doesn't match a known stage — callers decide the fallback. */
  findStage(bot: { funnelConfig: unknown }, stageId: string | null | undefined): FunnelStage | undefined {
    if (!stageId) return undefined;
    return this.getFunnelStages(bot).find((s) => s.stageId === stageId);
  }

  /**
   * Owner-given coaching advice (from the "Дать совет боту" training button,
   * or classifyTrainingInput deciding free text is a command). Used to
   * append raw text straight onto Bot.systemPrompt with a string marker —
   * invisible anywhere in the cabinet, no way to view or remove one specific
   * line short of re-parsing that string. Now a real, listable KnowledgeEntry
   * (source: 'instruction') — see KnowledgeService.createInstruction/
   * getInstructionsForPrompt. Kept as a thin delegation here, same signature,
   * so every existing call site (widget.service.ts) needed zero changes.
   */
  async addCoachingAdvice(botId: string, advice: string): Promise<{ ok: boolean; reason?: string }> {
    const bot = await this.prisma.bot.findUnique({ where: { id: botId } });
    if (!bot) return { ok: false, reason: 'not_found' };
    return this.knowledge.createInstruction(bot.companyId, advice, botId);
  }

  /** Auto-captured from the real page hostname widget.js reports on first load — see WidgetService.checkDomainIntegrity. */
  async setSourceWebsite(botId: string, website: string): Promise<void> {
    await this.prisma.bot.update({ where: { id: botId }, data: { sourceWebsite: website } });
  }

  /** One-shot gate so a persistently mismatched install only alerts once, not on every visitor load. */
  async markDomainMismatchAlerted(botId: string): Promise<void> {
    await this.prisma.bot.update({ where: { id: botId }, data: { domainMismatchAlertedAt: new Date() } });
  }
}
