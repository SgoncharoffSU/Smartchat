import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface ActiveLlmConfig {
  type: string;
  apiKey: string;
  baseUrl: string | null;
  model: string;
  folderId: string | null;
  systemPromptOverride: string | null;
  // Real RUB cost per 1000 tokens for whichever model this is — split input
  // vs output because real providers (RouterAI included) price them very
  // differently (seen live: gpt-4o-mini is 4x more expensive per output
  // token than input). Null until a superadmin fills them in (see setCost).
  // BillingService reads these to compute what a 'token'-plan company is
  // actually charged.
  costRubPer1kInput: number | null;
  costRubPer1kOutput: number | null;
}

/**
 * The one place the rest of the backend learns which LLM backend is
 * currently live — YandexGptService.callCompletion asks getActiveConfig()
 * instead of reading process.env directly, so a superadmin switching
 * providers in the cabinet (POST .../activate) takes effect on the very
 * next completion call, no restart. The active row is cached in memory
 * (this app runs as a single pm2 fork instance, so there's no cross-process
 * staleness to worry about) and only re-read from the DB on module start or
 * right after a switch — every other request just reads the cache.
 */
@Injectable()
export class LlmProviderService implements OnModuleInit {
  private readonly logger = new Logger(LlmProviderService.name);
  private cachedActive: ActiveLlmConfig | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.refreshCache();
  }

  private async refreshCache() {
    const row = await this.prisma.llmProvider.findFirst({ where: { isActive: true } });
    this.cachedActive = row
      ? {
          type: row.type,
          apiKey: row.apiKey,
          baseUrl: row.baseUrl,
          model: row.model,
          folderId: row.folderId,
          systemPromptOverride: row.systemPromptOverride,
          costRubPer1kInput: row.costRubPer1kInput ? row.costRubPer1kInput.toNumber() : null,
          costRubPer1kOutput: row.costRubPer1kOutput ? row.costRubPer1kOutput.toNumber() : null,
        }
      : null;
    if (!row) {
      this.logger.warn('No active LlmProvider row found — callers fall back to their own process.env defaults');
    }
  }

  /**
   * Null means "no row configured yet" — callers (YandexGptService) fall
   * back to their existing process.env-based defaults in that case, so an
   * empty table on a fresh deploy never breaks anything.
   */
  getActiveConfig(): ActiveLlmConfig | null {
    return this.cachedActive;
  }

  /** Superadmin list view — api_key is never sent back in full. */
  async list() {
    const rows = await this.prisma.llmProvider.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      model: r.model,
      baseUrl: r.baseUrl,
      isActive: r.isActive,
      apiKeyPreview: r.apiKey ? `••••${r.apiKey.slice(-4)}` : '',
      systemPromptOverride: r.systemPromptOverride,
      costRubPer1kInput: r.costRubPer1kInput ? r.costRubPer1kInput.toNumber() : null,
      costRubPer1kOutput: r.costRubPer1kOutput ? r.costRubPer1kOutput.toNumber() : null,
    }));
  }

  /**
   * Not exposed through any "add provider" form — each provider type is a
   * real request/response shape in YandexGptService.callCompletion, so a
   * genuinely new provider means writing that branch first. This just
   * persists the row once that code exists (or for a new instance of an
   * already-supported type, e.g. another openai_compatible gateway).
   */
  async create(input: {
    name: string;
    type: string;
    apiKey: string;
    baseUrl?: string | null;
    model: string;
    folderId?: string | null;
    systemPromptOverride?: string | null;
  }) {
    const name = input.name.trim();
    const type = input.type.trim();
    const apiKey = input.apiKey.trim();
    const model = input.model.trim();
    if (!name || !type || !apiKey || !model) {
      throw new BadRequestException('name, type, apiKey and model are all required');
    }
    if (type !== 'yandex' && type !== 'openai_compatible') {
      throw new BadRequestException('type must be "yandex" or "openai_compatible"');
    }
    if (type === 'openai_compatible' && !input.baseUrl?.trim()) {
      throw new BadRequestException('baseUrl is required for an openai_compatible provider');
    }
    return this.prisma.llmProvider.create({
      data: {
        name,
        type,
        apiKey,
        model,
        baseUrl: input.baseUrl?.trim() || null,
        folderId: input.folderId?.trim() || null,
        systemPromptOverride: input.systemPromptOverride?.trim() || null,
      },
    });
  }

  /**
   * The one field on a provider row a superadmin can tune from the cabinet
   * without going through Claude — everything else about "adding a
   * provider" still needs real code (see create() above), but steering an
   * already-wired model's quirks via its system prompt doesn't.
   */
  async setSystemPrompt(id: string, systemPromptOverride: string | null) {
    const target = await this.prisma.llmProvider.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Provider not found');
    const value = systemPromptOverride?.trim() || null;
    await this.prisma.llmProvider.update({ where: { id }, data: { systemPromptOverride: value } });
    if (target.isActive) await this.refreshCache();
    return { ok: true };
  }

  /**
   * The real per-1000-tokens RUB cost this provider/model charges us, input
   * and output separately (real providers price them very differently —
   * see this field's own schema comment) — from the provider's own billing
   * page. Whatever row is currently active feeds directly into
   * BillingService's token-plan pricing (cost * TariffPlan.markupMultiplier)
   * — editing this changes what clients pay on the very next completion
   * call, no redeploy.
   */
  async setCost(id: string, costRubPer1kInput: number | null, costRubPer1kOutput: number | null) {
    const target = await this.prisma.llmProvider.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Provider not found');
    await this.prisma.llmProvider.update({ where: { id }, data: { costRubPer1kInput, costRubPer1kOutput } });
    if (target.isActive) await this.refreshCache();
    return { ok: true };
  }

  /** Flips the old active row off and the new one on together, then updates
   * the in-memory cache immediately — the switch is live before this
   * request even returns. */
  async setActive(id: string) {
    const target = await this.prisma.llmProvider.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Provider not found');

    await this.prisma.$transaction([
      this.prisma.llmProvider.updateMany({ where: { isActive: true }, data: { isActive: false } }),
      this.prisma.llmProvider.update({ where: { id }, data: { isActive: true } }),
    ]);
    await this.refreshCache();
    this.logger.log(`LLM provider switched to "${target.name}" (${target.type}/${target.model})`);
    return { ok: true, active: target.name };
  }
}
