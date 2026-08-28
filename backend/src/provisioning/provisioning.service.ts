import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Bot, Company } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { YandexGptService } from '../yandex-gpt/yandex-gpt.service';
import { SiteAnalysisService } from '../site-analysis/site-analysis.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { TelegramService } from '../telegram/telegram.service';
import { DEFAULT_FUNNEL_TEMPLATE } from '../yandex-gpt/default-funnel-template';
import { GENERAL_SALES_PERSONA_RULES } from '../yandex-gpt/persona-rules';
import { ProvisioningRateLimiterService } from './provisioning-rate-limiter.service';

interface LeadDataLike {
  name?: string;
  phone?: string;
  email?: string;
  website?: string;
  businessDescription?: string;
  knowledgeBase?: string;
  preferredChannel?: string;
  [key: string]: unknown;
}

function buildDefaultSystemPrompt(businessDescription: string): string {
  return `
Ты — ИИ-консультант по продажам на сайте компании. Бизнес: ${businessDescription || 'информация уточняется'}.

${GENERAL_SALES_PERSONA_RULES}
`.trim();
}

export type ProvisionResult =
  | { ok: true; registrationUrl: string }
  // 'rate_limited' — too many provisions from this IP recently. A duplicate
  // site is no longer a refusal (see getOrProvision) — the account still
  // gets created, just without a free trial.
  | { ok: false; reason: 'rate_limited' };

@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);
  private readonly baseUrl = process.env.PUBLIC_BASE_URL ?? 'https://chat.glavinstrument.com';

  constructor(
    private readonly prisma: PrismaService,
    private readonly yandexGpt: YandexGptService,
    private readonly siteAnalysis: SiteAnalysisService,
    private readonly knowledge: KnowledgeService,
    private readonly rateLimiter: ProvisioningRateLimiterService,
    private readonly telegram: TelegramService,
  ) {}

  /**
   * Strips protocol/"www."/path/query/case so "https://Example.com/",
   * "www.example.com" and "example.com/kontakty" all compare equal — a real
   * business's own domain is a far more stable identity than an IP address
   * (which a repeat trial-abuser can just change).
   */
  normalizeWebsite(url: string): string | null {
    const trimmed = url.trim().toLowerCase();
    if (!trimmed) return null;
    const host = trimmed.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
    return host || null;
  }

  /** Scans existing bots' sourceWebsite in-app (normalizing both sides) — plenty fast at this scale, and avoids needing a normalized column/index. */
  async isDuplicateSite(url: string): Promise<boolean> {
    const normalized = this.normalizeWebsite(url);
    if (!normalized) return false;
    const bots = await this.prisma.bot.findMany({ where: { sourceWebsite: { not: null } }, select: { sourceWebsite: true } });
    return bots.some((b) => this.normalizeWebsite(b.sourceWebsite as string) === normalized);
  }

  /**
   * Same "domain already had a free trial → paid" policy as the duplicate
   * check in getOrProvision, applied when the duplicate is only discovered
   * later — at actual widget install time (see
   * WidgetService.checkDomainIntegrity), for an account that got through
   * registration without a site to check yet. subscriptionActive is left
   * false, so WidgetService.sendMessage's existing trial-expired gate takes
   * over on the very next message — no separate enforcement path needed.
   */
  async markTrialForfeited(companyId: string): Promise<void> {
    await this.prisma.company.update({ where: { id: companyId }, data: { trialEndsAt: new Date() } });
  }

  /**
   * Creates (once per dialog) a client Company + default-template Bot, or
   * returns the same URLs again if this dialog already provisioned one —
   * a visitor can be offered "try it" and later "go to the cabinet" in the
   * same conversation and both must point at the same bot. Gated on having a
   * business description (not contact info): the "try it now" path is meant
   * to work before the visitor has given any contact details at all.
   */
  async getOrProvision(
    dialog: { id: string; visitorMeta: unknown },
    leadData: LeadDataLike,
    visitorIp: string | undefined,
  ): Promise<ProvisionResult> {
    const meta = (dialog.visitorMeta as Record<string, any>) ?? {};
    if (meta.provisioning?.registrationToken) {
      // The cached link is only still good while the company behind it is
      // genuinely still unclaimed — seen live: a visitor registers with a
      // typo'd email, the account is created (registeredAt gets set right
      // away, before email verification — see CabinetService.register) but
      // never verified since the confirmation email went nowhere reachable.
      // Every later "give me the link again" in the same dialog then kept
      // handing back that exact same now-dead token forever — findPending-
      // Company rejects it (registeredAt is set), and there was no way to
      // ever get a fresh one short of contacting support. Once the cached
      // company is gone or already registered, fall through and provision a
      // genuinely new one instead of trusting the cache blindly.
      const cachedCompany = await this.prisma.company.findUnique({
        where: { id: meta.provisioning.companyId },
        select: { registeredAt: true },
      });
      if (cachedCompany && !cachedCompany.registeredAt) {
        return {
          ok: true,
          registrationUrl: `${this.baseUrl}/cabinet/register.html?token=${meta.provisioning.registrationToken}`,
        };
      }
      this.logger.warn(
        `getOrProvision: cached registration link for dialog ${dialog.id} is stale (company already registered or gone) — provisioning fresh`,
      );
    }

    if (visitorIp && !this.rateLimiter.isAllowed(visitorIp)) {
      this.logger.warn(`getOrProvision: rate limit hit for IP ${visitorIp}`);
      return { ok: false, reason: 'rate_limited' };
    }

    const { company, bot, registrationToken } = await this.createCompanyAndBot(leadData, 'getOrProvision');

    await this.prisma.dialog.update({
      where: { id: dialog.id },
      data: {
        visitorMeta: {
          ...meta,
          provisioning: { companyId: company.id, botId: bot.id, widgetToken: bot.widgetToken, registrationToken },
        },
      },
    });

    return {
      ok: true,
      registrationUrl: `${this.baseUrl}/cabinet/register.html?token=${registrationToken}`,
    };
  }

  /**
   * The same account-creation core as getOrProvision above, minus the
   * dialog-caching wrapper — used by the standalone site signup form (see
   * signup below), which has no chat dialog to cache anything against.
   * Pulled out once two call sites needed it, not preemptively.
   */
  private async createCompanyAndBot(
    leadData: LeadDataLike,
    logPrefix: string,
  ): Promise<{ company: Company; bot: Bot; registrationToken: string }> {
    // Ideally the funnel has already learned the visitor's business by the time
    // it reaches a handoff — but the model can jump straight to "try it now"
    // for an eager visitor without ever asking. A generic-but-working bot is
    // still far better than leaving the visitor with a broken non-link, so
    // provisioning must never bail just because this is empty.
    const businessDescription = leadData.businessDescription?.trim() || '';
    if (!businessDescription) {
      this.logger.warn(`${logPrefix}: no businessDescription yet, provisioning a generic bot anyway`);
    }

    // No longer a refusal — always let the account through (fewer dead ends
    // for a genuinely new visitor), but a site that's already had a free
    // trial never gets a second one: trialEndsAt is set already-elapsed, so
    // the existing trial-expired gate in WidgetService.sendMessage applies
    // to this bot from its very first message. Same policy, same mechanism,
    // as WidgetService.checkDomainIntegrity applies when the duplicate is
    // only discovered later, at actual install time.
    const isDuplicate = Boolean(leadData.website?.trim() && (await this.isDuplicateSite(leadData.website)));
    if (isDuplicate) {
      this.logger.warn(`${logPrefix}: site ${leadData.website} already had a free trial — creating as paid-only`);
    }

    const companyName = businessDescription.slice(0, 60) || leadData.website?.trim() || 'Новый клиент Smartchat';
    const registrationToken = randomUUID();
    const trialEndsAt = isDuplicate ? new Date() : new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

    const company = await this.prisma.company.create({
      data: { name: companyName, registrationToken, trialEndsAt },
    });

    if (isDuplicate) {
      this.telegram.alertPlatformAdmin(
        `Домен «${leadData.website}» уже участвовал в бесплатном триале — новый аккаунт «${companyName}» ` +
          'создан без бесплатного периода (сразу платно). Проверьте вручную, если это ошибка.',
      ).catch((error) => this.logger.error(`alertPlatformAdmin failed: ${String(error)}`));
    }

    const bot = await this.prisma.bot.create({
      data: {
        companyId: company.id,
        name: `${companyName} — ИИ-консультант`,
        systemPrompt: buildDefaultSystemPrompt(businessDescription),
        funnelConfig: DEFAULT_FUNNEL_TEMPLATE as any,
        widgetToken: randomUUID(),
        isActive: true,
        enablesProvisioning: false,
        funnelGeneratedAt: null,
        sourceWebsite: leadData.website?.trim() || null,
      },
    });

    // Slow part runs in the background — the client already has a working
    // default-template bot regardless of how this turns out.
    this.runSiteAnalysisAndGenerateFunnel(bot, businessDescription, leadData.knowledgeBase).catch((error) => {
      this.logger.error(`Background funnel generation crashed for bot ${bot.id}: ${String(error)}`);
    });

    return { company, bot, registrationToken };
  }

  /**
   * The site-based entry point next to the chat one — until now the ONLY way
   * to register was to have a conversation with the self-sell bot first and
   * get a link out of it; a visitor who'd rather just fill out a form had no
   * path in at all. Provisions a company+bot from the submitted business
   * description exactly like the chat flow does, then hands the token
   * straight back as a registrationUrl for the caller to follow up with
   * CabinetService.register — same two-step shape (provision, then
   * register), just without a chat dialog in between.
   */
  async provisionStandalone(leadData: LeadDataLike, visitorIp: string | undefined): Promise<ProvisionResult> {
    if (visitorIp && !this.rateLimiter.isAllowed(visitorIp)) {
      this.logger.warn(`provisionStandalone: rate limit hit for IP ${visitorIp}`);
      return { ok: false, reason: 'rate_limited' };
    }
    const { registrationToken } = await this.createCompanyAndBot(leadData, 'provisionStandalone');
    return {
      ok: true,
      registrationUrl: `${this.baseUrl}/cabinet/register.html?token=${registrationToken}`,
    };
  }

  private async runSiteAnalysisAndGenerateFunnel(
    bot: Bot,
    businessDescription: string,
    knowledgeBase: string | undefined,
  ): Promise<void> {
    // thorough: true — this runs as a background job (not a live chat turn),
    // so it's fine to always pay for a real headless render when needed.
    const siteText = bot.sourceWebsite
      ? await this.siteAnalysis.fetchVisibleText(bot.sourceWebsite, { thorough: true })
      : null;
    // Real, observable step — not a guess at elapsed-time percentage. The
    // cabinet status dropdown reads this directly.
    await this.prisma.bot.update({ where: { id: bot.id }, data: { provisioningStep: 1 } });

    const funnelConfig = await this.yandexGpt.generateFunnelConfig({
      businessDescription,
      knowledgeBase,
      siteText,
    });
    await this.prisma.bot.update({ where: { id: bot.id }, data: { provisioningStep: 2 } });

    await this.prisma.bot.update({
      where: { id: bot.id },
      data: { funnelConfig: funnelConfig as any, funnelGeneratedAt: new Date() },
    });

    // Structured straight into KnowledgeEntry rows (source: 'site' defaults
    // them to moderationStatus 'pending') rather than held as one raw blob —
    // sites are often out of date, so this never reaches the live bot prompt
    // until the owner reviews it in "База знаний", at their own pace, not as
    // a forced yes/no in the training chat.
    if (siteText) {
      await this.knowledge.createFromBulkText(bot.companyId, siteText, 'site', bot.id).catch((error) => {
        this.logger.error(`Site-derived KB structuring failed for bot ${bot.id}: ${String(error)}`);
      });
    }

    this.logger.log(`Generated tailored funnel for bot ${bot.id}`);
  }
}
