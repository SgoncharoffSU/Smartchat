import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MessageRole, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
import { AuthService } from '../auth/auth.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { YandexGptService } from '../yandex-gpt/yandex-gpt.service';
import { EmailService } from '../email/email.service';
import { CrmIntegrationService } from '../leads/crm-integration.service';
import { MessagesService } from '../messages/messages.service';
import { FunnelStage } from '../yandex-gpt/yandex-gpt.types';
import { DEFAULT_FUNNEL_TEMPLATE } from '../yandex-gpt/default-funnel-template';
import { GENERAL_SALES_PERSONA_RULES } from '../yandex-gpt/persona-rules';

// Fixed presets shown in the cabinet's "Цель бота" picker — a custom
// free-text goal is also accepted (preset key "custom"). Each preset's
// instruction is injected into the handoff stage at runtime (see
// widget.service.ts), not baked into the AI-generated funnel, so changing
// the goal later doesn't require regenerating anything.
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const WIDGET_POSITIONS = ['bottom-right', 'bottom-left'];
const BOT_GENDERS = ['male', 'female'];

// "YYYY-MM-DD" in the SERVER's own local time — not toISOString().slice(0,10),
// which reads the UTC calendar day. Used by getConversionChart to both build
// bucket keys and place each dialog's createdAt into one: since's own
// day-boundary (setHours(0,0,0,0)) is likewise computed in local time, so
// this must match it exactly. Mixing the two (a local-time boundary paired
// with UTC-labeled buckets) silently shifts every date on the chart by up to
// a day on any server whose local time isn't UTC.
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const GOAL_PRESETS: Record<string, { label: string; instruction: string }> = {
  chat_sale: {
    label: 'Продать в чате',
    instruction:
      'Цель этого бота — довести разговор до реальной продажи прямо в чате: помоги посетителю выбрать ' +
      'конкретный товар или услугу, назови цену и оформи заказ или дай точную инструкцию, как оплатить и ' +
      'получить товар прямо сейчас. Не переводи на менеджера, если можешь закрыть сделку сам. Обязательно ' +
      'зафиксируй в leadData.interest, что именно выбрал посетитель и по какой цене вы договорились — без ' +
      'оплаты онлайн владелец должен по одному этому полю понять, что именно продавать и что получать по ' +
      'оплате, не переспрашивая клиента заново.',
  },
  call: {
    label: 'Вывести клиента на звонок',
    instruction:
      'Цель этого бота — договориться о звонке с менеджером: как только посетитель заинтересован, предложи ' +
      'созвон, уточни удобное время и получи номер телефона. Зафиксируй в leadData.interest суть вопроса, ' +
      'с которым нужен звонок.',
  },
  registration: {
    label: 'Получить регистрацию',
    instruction:
      'Цель этого бота — довести посетителя до успешной регистрации или заявки на сайте: объясни, как ' +
      'зарегистрироваться или оставить заявку, и получи подтверждение, что это сделано, прямо в разговоре.',
  },
  consultation: {
    label: 'Записать на консультацию',
    instruction:
      'Цель этого бота — записать посетителя на консультацию со специалистом: уточни суть вопроса и удобное ' +
      'время для связи, получи контакт. Зафиксируй в leadData.interest тему консультации.',
  },
};

// What the dashboard's third stat card is called depends on the goal — the
// underlying number is always the same lead count, "Заявок получено" (the
// pre-goal default) just isn't the right word for every goal.
export const GOAL_METRIC_LABELS: Record<string, string> = {
  chat_sale: 'Заявок',
  call: 'Выведено на звонок',
  registration: 'Получено регистраций',
  consultation: 'Записей на консультацию',
};

// Same idea as GOAL_METRIC_LABELS but for the dashboard's conversion-rate line
// under that stat card — "Конверсия в X%" needs a goal-appropriate noun too.
export const GOAL_CONVERSION_LABELS: Record<string, string> = {
  chat_sale: 'Конверсия в заявку',
  call: 'Конверсия в звонок',
  registration: 'Конверсия в регистрацию',
  consultation: 'Конверсия в консультацию',
};

// One clarifying question per goal, asked right after picking it in the
// training-mode chat (see widget.service.ts) — the answer gets structured
// straight into the knowledge base, same as any other training-mode answer.
export const GOAL_FOLLOWUP_QUESTIONS: Record<string, string> = {
  chat_sale: 'Отлично! Ещё уточню: какие способы оплаты вы принимаете, и как клиент получает товар или доступ после оплаты?',
  call: 'Отлично! Ещё уточню: в какое время вам удобно принимать звонки, и на какой номер лучше звонить?',
  registration: 'Отлично! Ещё уточню: что нужно указать при регистрации, и куда она ведёт на сайте?',
  consultation: 'Отлично! Ещё уточню: сколько длится консультация и как она проходит — звонок, видео или очно?',
};

@Injectable()
export class CabinetService {
  private readonly baseUrl = process.env.PUBLIC_BASE_URL ?? 'https://chat.glavinstrument.com';
  private readonly logger = new Logger(CabinetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly knowledge: KnowledgeService,
    private readonly yandexGpt: YandexGptService,
    private readonly email: EmailService,
    private readonly crmIntegration: CrmIntegrationService,
    private readonly messages: MessagesService,
  ) {}

  async getRegistrationInfo(token: string) {
    const company = await this.findPendingCompany(token);
    return { companyName: company.name };
  }

  /**
   * Doesn't log the owner in — creates the account unverified and emails a
   * confirmation link instead. Registration only actually completes once
   * they click that link (see confirmEmail below); this is the "прислать
   * ссылку на почту, подтвердить по первому переходу" flow.
   */
  async register(token: string, email: string, password: string, name: string, consent: boolean): Promise<{ email: string }> {
    const company = await this.findPendingCompany(token);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('A valid email is required');
    }
    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    if (!name || name.trim().length < 2) {
      throw new BadRequestException('Name is required');
    }
    // The checkbox's own `required` attribute already blocks submission in a
    // real browser, but that's client-side only — a raw API call could skip
    // it entirely, so this is the actual enforcement point for 152-FZ
    // consent, same reasoning as every other code-verified consent gate in
    // this app (see widget.service.ts).
    if (consent !== true) {
      throw new BadRequestException('Consent to personal data processing is required');
    }

    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new BadRequestException('An account with this email already exists');
    }

    const passwordHash = await this.auth.hashPassword(password);
    const emailVerifyToken = randomUUID();
    const user = await this.prisma.user.create({
      data: { companyId: company.id, email, passwordHash, name: name.trim(), emailVerifyToken },
    });
    await this.prisma.company.update({ where: { id: company.id }, data: { registeredAt: new Date() } });

    // Fire-and-forget, same as a normal chat-captured lead (see
    // widget.service.ts) — a CRM being down or not connected must never
    // block registration itself. Whichever self-sell bot's conversation
    // provisioned this company gets looked up internally; if that bot has no
    // CRM connected, this is a no-op.
    this.crmIntegration.notifyRegistrationCompleted(company.id, { name: name.trim(), email, interest: company.name }).catch((error) => {
      this.logger.error(`CRM push for provisioned registration ${company.id} failed: ${String(error)}`);
    });

    // The bot (and any dialogs against it, e.g. a visitor clicking the
    // "попробовать бота" test-chat link mid-sales-conversation) already
    // existed before this moment — without this, the owner's first look at
    // their own dashboard shows pre-registration test traffic as unexplained
    // "показов"/conversion, which reads as "I just registered, where did
    // this come from?" Registration is the right point to start counting
    // from, not whenever the bot happened to be provisioned.
    await this.prisma.bot.updateMany({ where: { companyId: company.id }, data: { analyticsResetAt: new Date() } });

    await this.sendConfirmationEmail(user.email, user.name, emailVerifyToken);
    return { email: user.email };
  }

  private async sendConfirmationEmail(email: string, name: string | null, token: string): Promise<void> {
    const confirmUrl = `${this.baseUrl}/cabinet/confirm.html?token=${token}`;
    await this.email.sendConfirmationEmail(email, name ?? '', confirmUrl);
  }

  /** Only the owner themself can trigger this a second time — needs the same email+password as registration, not just knowledge of the address. */
  async resendConfirmation(email: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid email or password');
    const valid = await this.auth.verifyPassword(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid email or password');
    if (user.emailVerifiedAt) throw new BadRequestException('This account is already verified — just log in');

    const emailVerifyToken = randomUUID();
    await this.prisma.user.update({ where: { id: user.id }, data: { emailVerifyToken } });
    await this.sendConfirmationEmail(user.email, user.name, emailVerifyToken);
  }

  /** The confirmation link's target — verifies the account AND signs the owner in in the same step. */
  async confirmEmail(token: string): Promise<string> {
    if (!token) throw new NotFoundException('Invalid or expired confirmation link');
    const user = await this.prisma.user.findUnique({ where: { emailVerifyToken: token } });
    if (!user) throw new NotFoundException('Invalid or expired confirmation link');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), emailVerifyToken: null },
    });
    return this.auth.signSession({ companyId: user.companyId, userId: user.id, role: user.role, companyRole: user.companyRole });
  }

  /**
   * Always resolves the same way whether or not the email exists — the
   * controller returns a generic "if this email is registered..." message
   * either way, so this endpoint can't be used to enumerate registered
   * accounts.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;

    const passwordResetToken = randomUUID();
    const passwordResetExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken, passwordResetExpiresAt },
    });

    const resetUrl = `${this.baseUrl}/cabinet/reset-password.html?token=${passwordResetToken}`;
    await this.email.sendPasswordResetEmail(user.email, user.name ?? '', resetUrl);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (!token) throw new BadRequestException('Invalid or expired reset link');
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }

    const user = await this.prisma.user.findUnique({ where: { passwordResetToken: token } });
    if (!user || !user.passwordResetExpiresAt || user.passwordResetExpiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired reset link');
    }

    const passwordHash = await this.auth.hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetToken: null, passwordResetExpiresAt: null },
    });
  }

  async login(email: string, password: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid email or password');

    const valid = await this.auth.verifyPassword(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException('Invalid email or password');

    if (!user.emailVerifiedAt) {
      throw new UnauthorizedException('Подтвердите почту — мы прислали письмо со ссылкой при регистрации.');
    }

    return this.auth.signSession({ companyId: user.companyId, userId: user.id, role: user.role, companyRole: user.companyRole });
  }

  /** Owner-only — the CRM's own team management, separate from bot/billing access. */
  async listTeam(companyId: string, requesterCompanyRole: string) {
    // Owner AND manager can list (a manager needs it to reassign deals in the
    // CRM board) — only owner can invite/change roles, see inviteTeammate/
    // updateTeammateRole below.
    if (requesterCompanyRole !== 'owner' && requesterCompanyRole !== 'manager') {
      throw new UnauthorizedException('Недостаточно прав для просмотра команды');
    }
    const users = await this.prisma.user.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      companyRole: u.companyRole,
      emailVerifiedAt: u.emailVerifiedAt,
    }));
  }

  /**
   * Adds a teammate to the CRM without touching bot/billing access at all —
   * this is the only way a second User row on an existing Company gets
   * created (registration always makes exactly one). Doesn't log them in:
   * same "create unverified, email a link, they set their own password"
   * shape as register()/confirmEmail, just without the company-creation part
   * since the company already exists.
   */
  async inviteTeammate(companyId: string, requesterCompanyRole: string, email: string, name: string, companyRole: string): Promise<{ email: string }> {
    if (requesterCompanyRole !== 'owner') throw new UnauthorizedException('Только владелец может приглашать сотрудников');
    if (!['manager', 'employee'].includes(companyRole)) {
      throw new BadRequestException('Роль должна быть "manager" или "employee"');
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('A valid email is required');
    }
    if (!name || name.trim().length < 2) {
      throw new BadRequestException('Name is required');
    }
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) throw new BadRequestException('An account with this email already exists');

    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');

    // No usable password yet — acceptInvite is the only way to set one, same
    // as a fresh registration never has a password until the owner submits
    // the register form. A random hash here just guarantees login() can never
    // succeed against this row before that happens.
    const passwordHash = await this.auth.hashPassword(randomUUID());
    const emailVerifyToken = randomUUID();
    const user = await this.prisma.user.create({
      data: { companyId, email, passwordHash, name: name.trim(), companyRole, emailVerifyToken },
    });

    const acceptUrl = `${this.baseUrl}/cabinet/accept-invite.html?token=${emailVerifyToken}`;
    await this.email.sendTeamInviteEmail(user.email, company.name, acceptUrl);
    return { email: user.email };
  }

  async updateTeammateRole(companyId: string, requesterCompanyRole: string, userId: string, companyRole: string): Promise<void> {
    if (requesterCompanyRole !== 'owner') throw new UnauthorizedException('Только владелец может менять роли');
    if (!['owner', 'manager', 'employee'].includes(companyRole)) {
      throw new BadRequestException('Недопустимая роль');
    }
    const user = await this.prisma.user.findFirst({ where: { id: userId, companyId } });
    if (!user) throw new NotFoundException('User not found');
    await this.prisma.user.update({ where: { id: userId }, data: { companyRole } });
  }

  /** The invite email's link target — sets the teammate's own password and verifies + signs them in, in one step. */
  async acceptInvite(token: string, password: string): Promise<string> {
    if (!token) throw new NotFoundException('Invalid or expired invite link');
    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }
    const user = await this.prisma.user.findUnique({ where: { emailVerifyToken: token } });
    if (!user) throw new NotFoundException('Invalid or expired invite link');

    const passwordHash = await this.auth.hashPassword(password);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, emailVerifiedAt: new Date(), emailVerifyToken: null },
    });
    return this.auth.signSession({ companyId: user.companyId, userId: user.id, role: user.role, companyRole: user.companyRole });
  }

  async getMe(companyId: string, userId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { bots: { orderBy: { createdAt: 'asc' } }, tariffPlan: true },
    });
    if (!company) throw new NotFoundException('Company not found');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    // Every existing company has exactly one bot today, so the cabinet's bot
    // switcher can stay hidden for them (list of length 1) — this only
    // starts mattering once a company actually creates a second bot for a
    // different product/skill (see createBot below).
    const bots = company.bots.map((b) => ({
      id: b.id,
      name: b.name,
      label: b.label,
      widgetToken: b.widgetToken,
      funnelGeneratedAt: b.funnelGeneratedAt,
      sourceWebsite: b.sourceWebsite,
    }));
    return {
      companyName: company.name,
      trialEndsAt: company.trialEndsAt,
      subscriptionActive: company.subscriptionActive,
      // Real billing state (see BillingService) — separate from the older,
      // manually-flipped subscriptionActive above, which predates any
      // payment gateway and stays untouched by this. tariffPlan is null
      // until the first successful payment.
      tariffPlan: company.tariffPlan
        ? { id: company.tariffPlan.id, kind: company.tariffPlan.kind, name: company.tariffPlan.name }
        : null,
      planExpiresAt: company.planExpiresAt,
      tokenBalanceRub: company.tokenBalanceRub,
      autoPayEnabled: company.autoPayEnabled,
      userName: user?.name ?? null,
      userEmail: user?.email ?? null,
      role: user?.role ?? 'owner',
      companyRole: user?.companyRole ?? 'owner',
      bots,
      // Deprecated singular alias, kept only so any not-yet-updated caller
      // doesn't crash outright — the frontend should use bots[] + botId from
      // here on.
      bot: bots[0] ?? null,
    };
  }

  /** List for the cabinet's bot switcher — a company only sees its own bots. */
  async listBots(companyId: string) {
    const bots = await this.prisma.bot.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    return bots.map((b) => ({ id: b.id, name: b.name, label: b.label, widgetToken: b.widgetToken, funnelGeneratedAt: b.funnelGeneratedAt }));
  }

  /**
   * A second (or third...) bot for the same company — a blank slate on the
   * generic default funnel, same starting point a brand-new auto-provisioned
   * client bot gets (see ProvisioningService), just created directly instead
   * of through Алина's sales conversation. The owner trains it from scratch
   * via "Обучение и настройка", same as any bot.
   */
  async createBot(companyId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('Название бота обязательно');
    if (trimmed.length > 60) throw new BadRequestException('Название бота слишком длинное');

    const bot = await this.prisma.bot.create({
      data: {
        companyId,
        name: trimmed,
        label: trimmed,
        systemPrompt: `Ты — ИИ-консультант по продажам на сайте компании.\n\n${GENERAL_SALES_PERSONA_RULES}`,
        funnelConfig: DEFAULT_FUNNEL_TEMPLATE as any,
        widgetToken: randomUUID(),
        isActive: true,
      },
    });
    return { id: bot.id, name: bot.name, label: bot.label, widgetToken: bot.widgetToken, funnelGeneratedAt: bot.funnelGeneratedAt };
  }

  /**
   * Every bot-scoped method below takes an optional botId: explicit when the
   * cabinet's bot switcher picked one, falling back to "this company's
   * oldest bot" when omitted — every existing frontend call predates the
   * switcher and never sends one, and every company had exactly one bot
   * until multi-bot existed, so this keeps them working unchanged.
   */
  private async findOwnedBot(companyId: string, botId?: string) {
    const bot = botId
      ? await this.prisma.bot.findFirst({ where: { id: botId, companyId } })
      : await this.prisma.bot.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    if (!bot) throw new NotFoundException('No bot found for this company');
    return bot;
  }

  /**
   * Real, computed status — never a static promised ETA ("будет готово через
   * 2 минуты"). Each item is derived from an actual timestamp or count at
   * request time. "Сила вашего бота" is always present (see below) and grows
   * as real signals improve; it never just vanishes once initial setup ends.
   */
  /**
   * Replaces the old "Сила вашего бота" status badge + its dropdown of
   * onboarding nudges. That version scored six loosely-related signals into
   * one opaque number with no fixed weights (e.g. knowledge count scaled
   * continuously up to 20, funnel-generation progress ate its own 15%
   * regardless of anything the owner actually did) — an owner could see
   * "62%" and have no idea which of six different nudge cards below it
   * would move the number, or by how much. This is a fixed six-step
   * checklist instead: every step is binary (done or not), every step has a
   * FIXED weight that sums to exactly 100, and the percent is always
   * literally "sum of completed steps' weights" — no hidden curve, no
   * partial credit. Trial-expired and pending-escalations alerts (also
   * previously folded into the old endpoint) already have their own
   * dedicated UI (trialBanner, the "Требует внимания" nav badge) and don't
   * need a third place to surface from, so they're not part of this.
   */
  async getReadiness(companyId: string, botId?: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');
    const bot = await this.findOwnedBot(companyId, botId);

    const [installedDialogCount, knowledgeCount, siteSourceCount, testDialogGroups] = await Promise.all([
      // isPreview: false — the owner's own test/training chat shouldn't make
      // "installed on site" look true for a bot that's never actually been
      // embedded anywhere real yet. A real (non-preview) dialog only ever
      // exists because a real visitor loaded the widget on an actual page.
      this.prisma.dialog.count({ where: { botId: bot.id, isPreview: false } }),
      this.prisma.knowledgeEntry.count({ where: { botId: bot.id } }),
      this.prisma.knowledgeEntry.count({ where: { botId: bot.id, source: 'site' } }),
      // "Полноценный" test dialog, not just an accidental click: requires at
      // least 2 VISITOR messages in the same preview dialog, i.e. the owner
      // actually exchanged a couple of turns, not just opened the widget and
      // left. Grouped per-dialog (not a flat count across all test dialogs)
      // so two separate 1-message test opens don't add up to "one real test".
      this.prisma.message.groupBy({
        by: ['dialogId'],
        where: { role: MessageRole.visitor, dialog: { botId: bot.id, isPreview: true } },
        _count: { id: true },
      }),
    ]);
    const hasFullTestDialog = testDialogGroups.some((g) => g._count.id >= 2);

    type StepKey = 'knowledge' | 'site' | 'goal' | 'telegram' | 'test' | 'install';
    type View = 'knowledge' | 'install' | 'dashboard' | 'telegram' | 'training';
    const steps: Array<{
      key: StepKey;
      title: string;
      // Shown ONLY in the "Рекомендуемый следующий шаг" panel when this step
      // is the recommendation — falls back to `title` when not set. Split
      // out because a couple of steps need situation-specific phrasing there
      // ("Не удалось прочитать сайт X") that would look wrong as a permanent
      // checklist-card heading — the card needs the stable, generic name.
      nextStepTitle?: string;
      description: string;
      weight: number;
      completed: boolean;
      view: View;
      buttonLabel: string;
    }> = [
      {
        key: 'site',
        // Seen live: a bot's sourceWebsite was set (a site was genuinely
        // given at setup) but the automated crawl produced zero usable
        // entries — with the generic copy below, that reads as "you never
        // gave us a site", which isn't true and isn't actionable the same
        // way. Distinguish "never told us a site" from "told us, couldn't
        // read it" — same distinction the old getStatus already drew for
        // its own nudge, just missing here until now.
        title: 'Добавить сайт и ссылки',
        nextStepTitle: siteSourceCount === 0 && bot.sourceWebsite ? `Не удалось прочитать сайт ${bot.sourceWebsite}` : undefined,
        description:
          siteSourceCount === 0 && bot.sourceWebsite
            ? 'Автоматический разбор не нашёл на сайте ничего подходящего — добавьте информацию вручную или укажите другую страницу (каталог, услуги, цены).'
            : 'Добавьте сайт компании или отдельные страницы (каталог, услуги, доставка, цены) — бот изучит их автоматически.',
        weight: 10,
        completed: siteSourceCount > 0,
        view: 'knowledge',
        buttonLabel: siteSourceCount === 0 && bot.sourceWebsite ? 'Добавить информацию вручную →' : 'Добавить сайт →',
      },
      {
        key: 'knowledge',
        title: 'Добавить базу знаний',
        description: 'Загрузите информацию о компании, товарах или услугах — чтобы бот отвечал по существу, а не в общих словах.',
        weight: 25,
        completed: knowledgeCount > 0,
        view: 'knowledge',
        buttonLabel: 'Добавить базу знаний →',
      },
      {
        key: 'goal',
        title: 'Настроить цель бота',
        description: 'Заявка, запись, продажа в чате, квалификация или перевод на менеджера — цель определяет, чем бот завершает разговор.',
        weight: 10,
        // Set from the "Цель бота" panel on the dashboard, not Настройки —
        // that's where the actual edit form lives (see cabinet/index.html).
        completed: Boolean(bot.goalLabel),
        view: 'dashboard',
        buttonLabel: 'Настроить бота →',
      },
      {
        key: 'telegram',
        title: 'Подключить Telegram',
        description: 'Уведомления о новых заявках и возможность подключиться к диалогу в реальном времени.',
        weight: 10,
        completed: Boolean(company.telegramChatId),
        view: 'telegram',
        buttonLabel: 'Подключить Telegram →',
      },
      {
        key: 'test',
        title: 'Обучить бота',
        description: 'Проведите хотя бы один настоящий тестовый диалог — задайте пару вопросов, как это сделал бы посетитель, и поправьте неудачные ответы.',
        // Heaviest single step — this is the one that actually shapes how
        // the bot talks, not just whether a setting is filled in.
        weight: 35,
        completed: hasFullTestDialog,
        view: 'training',
        buttonLabel: 'Обучить бота →',
      },
      {
        key: 'install',
        title: 'Установить бота на сайт',
        description: 'Без установленного виджета реальные посетители не смогут написать боту — это ключевой шаг.',
        // Last on purpose, not just alphabetically-last-by-accident —
        // installing on the real site is naturally the LAST thing an owner
        // does, once everything else is actually configured. 10% (down from
        // the ТЗ's original 25%) because the signal behind it (a real,
        // non-preview dialog) depends on outside traffic actually showing
        // up, not just an action the owner takes — a step they have no
        // further move to make on shouldn't be able to hold the whole score
        // hostage to traffic timing.
        weight: 10,
        completed: installedDialogCount > 0,
        view: 'install',
        buttonLabel: 'Установить бота →',
      },
    ];

    const percent = steps.reduce((sum, s) => sum + (s.completed ? s.weight : 0), 0);
    const stepsCompleted = steps.filter((s) => s.completed).length;
    const nextStep = steps.find((s) => !s.completed) ?? null;

    return {
      percent,
      stepsCompleted,
      totalSteps: steps.length,
      isComplete: stepsCompleted === steps.length,
      steps,
      nextStep,
    };
  }

  /**
   * Variants are stored as the full pinned instruction ("Твоя первая реплика
   * должна быть РОВНО такой, без изменений: \"<hook>\" Не добавляй..."), not
   * the bare hook text — the A/B/C/D report shows the actual phrase, not the
   * template wrapped around it, so pull out the quoted part for display.
   * Falls back to the raw instruction if a variant somehow doesn't match the
   * template (never invents or drops text, just shows what's there).
   */
  private extractVariantHook(instruction: string): string {
    const match = instruction.match(/"([^"]+)"/);
    return match ? match[1] : instruction;
  }

  async getEmbedSnippet(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);

    return {
      snippet:
        `<script src="${this.baseUrl}/widget.js" data-bot-token="${bot.widgetToken}" ` +
        `data-color="${bot.widgetColor}" data-position="${bot.widgetPosition}"></script>`,
      testUrl: `${this.baseUrl}/test-chat.html?token=${bot.widgetToken}`,
    };
  }

  /**
   * Company.name defaults to whatever the lead typed when asked what their
   * business does ("продажа бань" — see ProvisioningService), never an
   * actual brand name, because nothing ever asked for one. That default text
   * then leaks straight into the bot's own introduction (the systemPrompt
   * literally says "Бизнес: продажа бань"), so without this the model has no
   * real name to give and paraphrases the description into something like
   * "компания по продаже бань" — reads as generic/unprofessional, not a real
   * business. This lets the owner set the actual name once; see
   * WidgetService's runtime prompt injection for where it then gets used
   * (immediately, no funnel regeneration or redeploy needed).
   */
  async updateCompanyName(companyId: string, name: string) {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 80) {
      throw new BadRequestException('Название компании должно быть от 1 до 80 символов');
    }
    await this.prisma.company.update({ where: { id: companyId }, data: { name: trimmed } });
    return { companyName: trimmed };
  }

  async getAppearance(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    return {
      name: bot.name,
      label: bot.label,
      gender: bot.gender,
      color: bot.widgetColor,
      position: bot.widgetPosition,
    };
  }

  async updateAppearance(
    companyId: string,
    input: { name?: string; label?: string; gender?: string; color?: string; position?: string },
    botId?: string,
  ) {
    const bot = await this.findOwnedBot(companyId, botId);

    const data: { name?: string; label?: string | null; gender?: string; widgetColor?: string; widgetPosition?: string } = {};
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (trimmed.length < 1 || trimmed.length > 40) {
        throw new BadRequestException('Имя бота должно быть от 1 до 40 символов');
      }
      data.name = trimmed;
    }
    if (input.label !== undefined) {
      const trimmed = input.label.trim();
      if (trimmed.length > 60) {
        throw new BadRequestException('Название бота слишком длинное');
      }
      // Empty clears back to null — callers fall back to the persona name.
      data.label = trimmed.length > 0 ? trimmed : null;
    }
    if (input.gender !== undefined) {
      if (!BOT_GENDERS.includes(input.gender)) throw new BadRequestException('Некорректный пол бота');
      data.gender = input.gender;
    }
    if (input.color !== undefined) {
      if (!HEX_COLOR_PATTERN.test(input.color)) throw new BadRequestException('Цвет должен быть в формате #RRGGBB');
      data.widgetColor = input.color;
    }
    if (input.position !== undefined) {
      if (!WIDGET_POSITIONS.includes(input.position)) throw new BadRequestException('Некорректное расположение чата');
      data.widgetPosition = input.position;
    }

    await this.prisma.bot.update({ where: { id: bot.id }, data });
    return this.getAppearance(companyId, bot.id);
  }

  /**
   * "week"/"month"/"yesterday" compare against an equal-length prior window
   * (real period-over-period, not calendar weeks/months) — "all" has no
   * previous period to compare against. "custom" compares against the same
   * number of days immediately before the chosen range.
   */
  private getPeriodRange(
    period: 'week' | 'month' | 'all' | 'yesterday' | 'custom',
    from?: string,
    to?: string,
  ): { curStart: Date; curEnd?: Date; prevStart: Date } | null {
    if (period === 'all') return null;

    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

    if (period === 'yesterday') {
      const todayStart = startOfDay(new Date());
      const yesterdayStart = new Date(todayStart.getTime() - 86400000);
      const dayBeforeStart = new Date(yesterdayStart.getTime() - 86400000);
      return { curStart: yesterdayStart, curEnd: todayStart, prevStart: dayBeforeStart };
    }

    if (period === 'custom') {
      const fromDate = from ? startOfDay(new Date(from)) : null;
      const toDate = to ? startOfDay(new Date(to)) : null;
      if (!fromDate || !toDate || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        throw new BadRequestException('from and to must be valid dates for a custom period');
      }
      const curEnd = new Date(toDate.getTime() + 86400000); // "to" is inclusive
      const rangeMs = curEnd.getTime() - fromDate.getTime();
      return { curStart: fromDate, curEnd, prevStart: new Date(fromDate.getTime() - rangeMs) };
    }

    const days = period === 'week' ? 7 : 30;
    const now = Date.now();
    return {
      curStart: new Date(now - days * 86400000),
      prevStart: new Date(now - 2 * days * 86400000),
    };
  }

  private percentDelta(current: number, previous: number): number | null {
    if (previous === 0) return current > 0 ? 100 : null;
    return ((current - previous) / previous) * 100;
  }

  /**
   * "Обнулить статистику" moves this floor forward without deleting any
   * rows — a date range that already starts after the reset point is left
   * alone; one that would start earlier gets clamped up to it. Applied to
   * every count/findMany below so old test/dev traffic can never leak back
   * in through the "all time" period.
   */
  private withResetFloor(
    filter: { gte?: Date; lt?: Date } | undefined,
    resetAt: Date | null,
  ): { gte: Date; lt?: Date } | undefined {
    if (!resetAt) return filter as { gte: Date; lt?: Date } | undefined;
    const gte = filter?.gte && filter.gte > resetAt ? filter.gte : resetAt;
    return filter?.lt ? { gte, lt: filter.lt } : { gte };
  }

  /**
   * The company a given dialog provisioned is only ever recorded as a JSON
   * field (visitorMeta.provisioning.companyId, see ProvisioningService), not
   * a real foreign key — shared by both methods below so they scan the same
   * dialogs the same way instead of drifting apart.
   */
  private async provisionedCompanyIds(botId: string): Promise<string[]> {
    const dialogs = await this.prisma.dialog.findMany({
      where: { botId, isPreview: false },
      select: { visitorMeta: true },
    });
    return Array.from(
      new Set(
        dialogs
          .map((d) => (d.visitorMeta as Record<string, any> | null)?.provisioning?.companyId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    );
  }

  /**
   * "Registration" for a self-sell provisioning bot (Алина) isn't a Lead —
   * see the getAnalytics call site for the full explanation. Counts how many
   * of the companies THIS bot's own dialogs provisioned actually completed
   * registration (registeredAt set) in the requested window.
   */
  private async countProvisionedRegistrations(botId: string, dateFilter?: { gte?: Date; lt?: Date }): Promise<number> {
    const companyIds = await this.provisionedCompanyIds(botId);
    if (companyIds.length === 0) return 0;
    return this.prisma.company.count({
      where: { id: { in: companyIds }, registeredAt: dateFilter ?? { not: null } },
    });
  }

  /**
   * Same gap, for the "Заявки" table itself (see getAnalytics) — shaped to
   * match a real Lead row (id/name/phone/email/interest/createdAt/paidAt) so
   * the cabinet's existing leads table renders it with zero frontend changes.
   * name/email come from the account actually created at registration (the
   * first User on that company — there's only ever one at signup time);
   * phone is never collected in this flow, so always null. interest reuses
   * businessDescription, captured earlier in the same sales conversation
   * (see ProvisioningService) — the closest existing equivalent to "what
   * they were interested in". paidAt stays null: Company has no separate
   * "became paying customer" timestamp to report here, only the
   * subscriptionActive flag itself.
   */
  private async listProvisionedRegistrations(
    botId: string,
    resetAt: Date | null,
  ): Promise<Array<{ id: string; name: string | null; phone: string | null; email: string | null; interest: string | null; createdAt: Date; paidAt: Date | null }>> {
    const companyIds = await this.provisionedCompanyIds(botId);
    if (companyIds.length === 0) return [];
    const companies = await this.prisma.company.findMany({
      where: {
        id: { in: companyIds },
        registeredAt: resetAt ? { gte: resetAt } : { not: null },
      },
      include: { users: { orderBy: { createdAt: 'asc' }, take: 1 } },
      orderBy: { registeredAt: 'desc' },
    });
    return companies.map((c) => ({
      id: c.id,
      name: c.users[0]?.name ?? null,
      phone: null,
      email: c.users[0]?.email ?? null,
      interest: c.name,
      createdAt: c.registeredAt as Date,
      paidAt: null,
    }));
  }

  async getAnalytics(
    companyId: string,
    period: 'week' | 'month' | 'all' | 'yesterday' | 'custom' = 'week',
    from?: string,
    to?: string,
    botId?: string,
  ) {
    const bot = await this.findOwnedBot(companyId, botId);

    const range = this.getPeriodRange(period, from, to);
    const curFilter = this.withResetFloor(
      range ? { gte: range.curStart, ...(range.curEnd ? { lt: range.curEnd } : {}) } : undefined,
      bot.analyticsResetAt,
    );
    const prevFilter = this.withResetFloor(
      range ? { gte: range.prevStart, lt: range.curStart } : undefined,
      bot.analyticsResetAt,
    );

    const [
      shownCur,
      shownPrev,
      openedCur,
      openedPrev,
      dialogsCur,
      dialogsPrev,
      leadsCur,
      leadsPrev,
      paidCur,
      paidPrev,
      problemsCur,
      problemsCurResolved,
      allDialogsForVariants,
      allLeads,
      provisionedRegistrations,
      pendingEscalations,
      unverifiedEscalations,
      recentVerified,
      processedEscalations,
      verifiedCount,
      reviewedCount,
    ] = await Promise.all([
      // "Показов" — the teaser/opening line was served at all (fires on
      // isInit, i.e. a dialog row exists) — visitor may never have engaged.
      // isPreview: false throughout this block — the owner's own test/
      // training chat must never inflate real-visitor funnel numbers.
      this.prisma.dialog.count({ where: { botId: bot.id, isPreview: false, ...(curFilter && { createdAt: curFilter }) } }),
      range
        ? this.prisma.dialog.count({ where: { botId: bot.id, isPreview: false, createdAt: prevFilter } })
        : Promise.resolve(0),
      // "Открыли чат" — the widget panel was actually opened. isInit's own
      // teaser is persisted as a real assistant Message immediately (see
      // widget.service.ts's isInit branch), so `messages: {some: {}}` is
      // ALWAYS true and useless here — every dialog has that first message
      // whether the visitor opened anything or not (confirmed live: it
      // matched "Показов" exactly, count for count). The real second
      // assistant line only gets generated by isReveal, which chat.js fires
      // "right when the visitor actually opens the chat" (its own comment) —
      // so 2+ messages is the honest signal. No `some`/`count`-with-relation
      // filter in Prisma for "at least N related rows", so fetch+filter in
      // JS, same pattern getConversionChart already uses below.
      this.prisma.dialog
        .findMany({
          where: { botId: bot.id, isPreview: false, ...(curFilter && { createdAt: curFilter }) },
          select: { messages: { select: { id: true }, take: 2 } },
        })
        .then((rows) => rows.filter((d) => d.messages.length >= 2).length),
      range
        ? this.prisma.dialog
            .findMany({
              where: { botId: bot.id, isPreview: false, createdAt: prevFilter },
              select: { messages: { select: { id: true }, take: 2 } },
            })
            .then((rows) => rows.filter((d) => d.messages.length >= 2).length)
        : Promise.resolve(0),
      // "Диалогов" — the visitor actually sent a message of their own. This
      // (not the raw dialog-row count above) is the real funnel denominator.
      this.prisma.dialog.count({
        where: {
          botId: bot.id,
          isPreview: false,
          ...(curFilter && { createdAt: curFilter }),
          messages: { some: { role: 'visitor' } },
        },
      }),
      range
        ? this.prisma.dialog.count({
            where: { botId: bot.id, isPreview: false, createdAt: prevFilter, messages: { some: { role: 'visitor' } } },
          })
        : Promise.resolve(0),
      // For a self-sell provisioning bot (Алина — enablesProvisioning),
      // "registration" doesn't work like a normal lead: the visitor's
      // email/password are entered on a separate page (register.html), not
      // collected in the chat, so leadCaptured/leads.upsertAndCheckNew never fires for
      // it (see widget.service.ts) — Lead.count was silently 0 forever
      // here, for EVERY real signup this bot ever produced. Confirmed live:
      // 6 real, completed registrations, 0 Lead rows. The real signal is
      // Company.registeredAt on the company THIS bot's own dialog
      // provisioned (see ProvisioningService) — count that instead for this
      // one bot type; every other bot keeps counting Lead rows as before.
      bot.enablesProvisioning
        ? this.countProvisionedRegistrations(bot.id, curFilter)
        : this.prisma.lead.count({
            where: { dialog: { botId: bot.id, isPreview: false }, ...(curFilter && { createdAt: curFilter }) },
          }),
      range
        ? bot.enablesProvisioning
          ? this.countProvisionedRegistrations(bot.id, prevFilter)
          : this.prisma.lead.count({ where: { dialog: { botId: bot.id, isPreview: false }, createdAt: prevFilter } })
        : Promise.resolve(0),
      this.prisma.lead.count({
        where: { dialog: { botId: bot.id, isPreview: false }, paidAt: curFilter ? curFilter : { not: null } },
      }),
      range
        ? this.prisma.lead.count({ where: { dialog: { botId: bot.id, isPreview: false }, paidAt: prevFilter } })
        : Promise.resolve(0),
      this.prisma.escalation.count({ where: { botId: bot.id, ...(curFilter && { createdAt: curFilter }) } }),
      this.prisma.escalation.count({
        where: { botId: bot.id, verifiedAt: { not: null }, ...(curFilter && { createdAt: curFilter }) },
      }),
      this.prisma.dialog.findMany({
        where: {
          botId: bot.id,
          isPreview: false,
          ...(bot.analyticsResetAt && { createdAt: { gte: bot.analyticsResetAt } }),
        },
        include: { messages: { where: { role: 'visitor' }, take: 1 } },
      }),
      this.prisma.lead.findMany({
        where: {
          dialog: { botId: bot.id, isPreview: false },
          ...(bot.analyticsResetAt && { createdAt: { gte: bot.analyticsResetAt } }),
        },
        orderBy: { createdAt: 'desc' },
      }),
      // Same gap as the count above, for the "Заявки" table itself — without
      // this the list just looks permanently empty for this bot, even with
      // real registrations sitting right there in the count above it.
      bot.enablesProvisioning
        ? this.listProvisionedRegistrations(bot.id, bot.analyticsResetAt)
        : Promise.resolve([]),
      this.prisma.escalation.findMany({
        where: { botId: bot.id, answer: null, processedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.escalation.findMany({
        where: { botId: bot.id, answer: { not: null }, verifiedAt: null, processedAt: null },
        orderBy: { answeredAt: 'desc' },
      }),
      this.prisma.escalation.findMany({
        where: { botId: bot.id, verifiedAt: { not: null } },
        orderBy: { verifiedAt: 'desc' },
        take: 10,
      }),
      // Manually checked off via the "Обработано" checkbox — see
      // setEscalationProcessed. Independent of verifiedAt: something can be
      // dismissed here without ever having a real answer written for it.
      this.prisma.escalation.findMany({
        where: { botId: bot.id, processedAt: { not: null } },
        orderBy: { processedAt: 'desc' },
        take: 30,
      }),
      // Real totals for the "Ответы под контролем" dashboard card — that card
      // was still showing the reference's static demo numbers (0/34/8) even
      // after the Attention page itself became real, because recentVerified/
      // processedEscalations above are capped lists (10/30) meant for their
      // own sections, not totals.
      this.prisma.escalation.count({ where: { botId: bot.id, verifiedAt: { not: null } } }),
      // OR, not verifiedCount+processedCount summed on the frontend — verify
      // and "Обработано" are independent actions (setEscalationProcessed has
      // no guard against processing an already-verified row), so a single row
      // could in principle satisfy both filters; OR counts it once, a sum of
      // the two separate counts would double-count it.
      this.prisma.escalation.count({
        where: { botId: bot.id, OR: [{ verifiedAt: { not: null } }, { processedAt: { not: null } }] },
      }),
    ]);

    const stages = Array.isArray(bot.funnelConfig) ? (bot.funnelConfig as unknown as FunnelStage[]) : [];
    const greetingVariants = stages.find((s) => s.stageId === 'greeting')?.variants ?? [];

    // "Показов" = the variant got assigned at all (fires on isInit, i.e. the
    // teaser was fetched — the visitor may never have opened the chat).
    // "Диалогов" = the visitor actually engaged (sent at least one message of
    // their own) — the real signal that a hook worked, not just that it was
    // technically served.
    const variantBuckets = new Map<number, { shown: number; engaged: number; converted: number }>();
    for (const d of allDialogsForVariants as Array<(typeof allDialogsForVariants)[number] & { messages: unknown[] }>) {
      const meta = (d.visitorMeta as Record<string, any>) ?? {};
      const idx = meta?.experiments?.greeting;
      if (idx === undefined || idx === null) continue;
      const bucket = variantBuckets.get(idx) ?? { shown: 0, engaged: 0, converted: 0 };
      bucket.shown++;
      if (d.messages.length > 0) bucket.engaged++;
      if (d.status === 'handoff') bucket.converted++;
      variantBuckets.set(idx, bucket);
    }

    const variantReport = Array.from(variantBuckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([idx, b]) => ({
        label: String.fromCharCode(65 + idx),
        text: greetingVariants[idx] ? this.extractVariantHook(greetingVariants[idx]) : null,
        shown: b.shown,
        engaged: b.engaged,
        converted: b.converted,
        conversionRate: b.engaged > 0 ? (b.converted / b.engaged) * 100 : 0,
      }));

    return {
      period,
      goalLabel: bot.goalLabel,
      leadsLabel: (bot.goalPreset && GOAL_METRIC_LABELS[bot.goalPreset]) || 'Заявок получено',
      leadsConversionLabel: (bot.goalPreset && GOAL_CONVERSION_LABELS[bot.goalPreset]) || 'Конверсия в заявку',
      shown: { count: shownCur, deltaPct: range ? this.percentDelta(shownCur, shownPrev) : null },
      // New field, additive only — dialogs.conversionRate below is UNCHANGED
      // (still shown-based) since cabinet/index.html already reads it for
      // "Конверсия в диалог" and its funnel-arrow display; openedToDialogRate
      // is a second, separate number for the reference's own 4-stage funnel,
      // not a replacement.
      opened: {
        count: openedCur,
        conversionRate: shownCur > 0 ? (openedCur / shownCur) * 100 : 0,
        openedToDialogRate: openedCur > 0 ? (dialogsCur / openedCur) * 100 : 0,
        deltaPct: range ? this.percentDelta(openedCur, openedPrev) : null,
      },
      dialogs: {
        count: dialogsCur,
        conversionRate: shownCur > 0 ? (dialogsCur / shownCur) * 100 : 0,
        deltaPct: range ? this.percentDelta(dialogsCur, dialogsPrev) : null,
      },
      leads: {
        count: leadsCur,
        conversionRate: dialogsCur > 0 ? (leadsCur / dialogsCur) * 100 : 0,
        deltaPct: range ? this.percentDelta(leadsCur, leadsPrev) : null,
      },
      paid: {
        count: paidCur,
        conversionRate: leadsCur > 0 ? (paidCur / leadsCur) * 100 : 0,
        deltaPct: range ? this.percentDelta(paidCur, paidPrev) : null,
      },
      problems: { count: problemsCur, resolved: problemsCurResolved },
      funnelGeneratedAt: bot.funnelGeneratedAt,
      tracksPayments: bot.tracksPayments,
      // provisionedRegistrations is already empty for every bot except the
      // self-sell one — see its own comment for why it exists at all.
      // Merged (not appended) and re-sorted so the table still reads as one
      // coherent, newest-first list either way.
      leadsList: allLeads
        .map((l) => ({
          id: l.id,
          name: l.name,
          phone: l.phone,
          email: l.email,
          interest: (l.rawCapture as Record<string, any> | null)?.interest ?? null,
          createdAt: l.createdAt,
          paidAt: l.paidAt,
        }))
        .concat(provisionedRegistrations)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      variantReport,
      variantsAvailable: greetingVariants.length,
      escalations: {
        pending: pendingEscalations.map((e) => ({
          id: e.id,
          reason: e.reason,
          question: e.question,
          botReply: e.botReply,
          createdAt: e.createdAt,
        })),
        needsVerification: unverifiedEscalations.map((e) => ({
          id: e.id,
          reason: e.reason,
          question: e.question,
          answer: e.answer,
          answeredAt: e.answeredAt,
        })),
        recentVerified: recentVerified.map((e) => ({
          id: e.id,
          question: e.question,
          answer: e.answer,
          verifiedAt: e.verifiedAt,
        })),
        processed: processedEscalations.map((e) => ({
          id: e.id,
          reason: e.reason,
          question: e.visitorQuestion || e.question,
          botReply: e.botReply,
          answer: e.answer,
          processedAt: e.processedAt,
        })),
        // Totals (not the capped 10/30-row lists above) for the dashboard's
        // "Ответы под контролем" summary card.
        verifiedCount,
        reviewedCount,
      },
    };
  }

  /**
   * Real day-by-day conversion rates for the dashboard's line chart — the
   * reference design has this panel, we didn't have any per-day breakdown
   * before (getAnalytics above only computes two totals: current period vs
   * previous). No new tables: buckets the same Dialog rows getAnalytics
   * already reads (isPreview: false), by calendar day of createdAt.
   * "В открытие чата" = dialogs with a real visitor message / all dialogs
   * shown that day; "В заявку" = leads confirmed that day / dialogs opened
   * that day — same two ratios (and the same bases) as the "Конверсия в
   * диалог" / "Конверсия в регистрацию" labels already shown on the metric
   * cards above, just split per day instead of summed over the whole
   * period.
   *
   * Leads are bucketed by the Lead's OWN createdAt, queried separately from
   * dialogs — matching getAnalytics' leadsCur/leadsPrev above, which also
   * filter by Lead.createdAt, never its dialog's. A dialog can open on one
   * day and only confirm a lead (a later message supplying contact info)
   * days after — attributing that lead to the dialog's OPEN day (or
   * dropping it if the dialog itself falls outside the window even though
   * the lead was confirmed inside it) would silently disagree with what the
   * metric cards above show for the very same period.
   */
  async getConversionChart(companyId: string, botId?: string, days = 7) {
    const bot = await this.findOwnedBot(companyId, botId);
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));
    // Same floor getAnalytics applies to every one of its own queries — without
    // it, a "Сбросить статистику" click cleans the metric cards above but old
    // test/dev dialogs from before the reset keep reappearing in this chart
    // for up to `days` more. Bucket generation below still spans the full
    // requested window (dates before the reset just come back at 0, which is
    // the intended "hidden" look, not a shrunk window).
    const sinceFilter = this.withResetFloor({ gte: since }, bot.analyticsResetAt);

    const [dialogs, leadDates] = await Promise.all([
      this.prisma.dialog.findMany({
        where: { botId: bot.id, isPreview: false, createdAt: sinceFilter },
        select: {
          createdAt: true,
          // 2+ messages of ANY role, not "at least one visitor message" — same
          // definition getAnalytics uses for this same "Открыли чат" label
          // (see its own comment above: isInit's teaser is always message #1,
          // so 2+ is the honest "the visitor actually opened the chat" signal).
          // This used to filter by role:'visitor' here, which measures a
          // stricter, different thing (the visitor sent a message — that's
          // "Диалоги", not "Открыли чат") and silently disagreed with the
          // dashboard card sharing this chart's label.
          messages: { take: 2, select: { id: true } },
        },
      }),
      // Same enablesProvisioning gap as getAnalytics (see its own comment,
      // countProvisionedRegistrations): Алина-type bots never create Lead
      // rows, so counting Lead here would flatline "В заявку" at 0% while the
      // metric cards above show a real, non-zero registration rate for the
      // very same period.
      bot.enablesProvisioning
        ? this.provisionedCompanyIds(bot.id).then((companyIds) =>
            companyIds.length === 0
              ? []
              : this.prisma.company
                  .findMany({ where: { id: { in: companyIds }, registeredAt: sinceFilter }, select: { registeredAt: true } })
                  .then((rows) => rows.map((r) => r.registeredAt as Date)),
          )
        : this.prisma.lead
            .findMany({ where: { dialog: { botId: bot.id, isPreview: false }, createdAt: sinceFilter }, select: { createdAt: true } })
            .then((rows) => rows.map((r) => r.createdAt)),
    ]);

    const buckets = new Map<string, { shown: number; opened: number; leads: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      buckets.set(localDateKey(d), { shown: 0, opened: 0, leads: 0 });
    }
    for (const dialog of dialogs) {
      const bucket = buckets.get(localDateKey(dialog.createdAt));
      if (!bucket) continue; // outside the requested window after rounding — ignore
      bucket.shown += 1;
      if (dialog.messages.length >= 2) bucket.opened += 1;
    }
    for (const leadDate of leadDates) {
      const bucket = buckets.get(localDateKey(leadDate));
      if (bucket) bucket.leads += 1; // outside the requested window after rounding — ignore
    }

    return {
      days: [...buckets.entries()].map(([date, b]) => ({
        date,
        shown: b.shown,
        openRate: b.shown > 0 ? Math.round((b.opened / b.shown) * 1000) / 10 : 0,
        leadRate: b.opened > 0 ? Math.round((b.leads / b.opened) * 1000) / 10 : 0,
      })),
    };
  }

  /**
   * "Обработано" checkbox in "Требует внимания" — a manual, always-available
   * dismiss that doesn't require an actual answer to exist (unlike
   * verifyEscalation, which also mirrors into KnowledgeEntry and requires
   * one). Toggleable: unchecking clears processedAt and the row reappears in
   * its normal pending/verify list.
   */
  async setEscalationProcessed(companyId: string, escalationId: string, processed: boolean) {
    const escalation = await this.prisma.escalation.findUnique({ where: { id: escalationId } });
    if (!escalation || escalation.companyId !== companyId) throw new NotFoundException('Escalation not found');
    await this.prisma.escalation.update({
      where: { id: escalationId },
      data: { processedAt: processed ? new Date() : null },
    });
    return { ok: true };
  }

  /**
   * "Требует внимания" used to treat a 'dissatisfaction' row exactly like an
   * 'unanswered' one — draft ONE reply to send back into that (often
   * already-over) dialog, with no way to fix the actual underlying gap in
   * how the bot handles this situation for the NEXT visitor (found live:
   * "это же не научит бота быть лучше?"). This is the same
   * classify-then-store pipeline DislikesService.resolve already uses for
   * the test-chat's 👎 button (reused here, not duplicated: same
   * classifyDislikeNote + createForBot/createInstruction/createCorrection
   * calls) — just keyed off the Escalation row's own stored visitorQuestion/
   * botReply instead of a Message row, since a real-customer dissatisfaction
   * escalation has no dislikedMessageId (that field is 'disliked'-only, see
   * its own schema comment) for DislikesService.resolve to look up.
   * Auto-marks the escalation processed on success — same field/meaning as
   * the "Обработано" checkbox above, so it drops off the pending list either
   * way.
   */
  async resolveDissatisfaction(companyId: string, escalationId: string, note: string) {
    const escalation = await this.prisma.escalation.findUnique({ where: { id: escalationId } });
    if (!escalation || escalation.companyId !== companyId) throw new NotFoundException('Escalation not found');
    if (escalation.reason !== 'dissatisfaction') {
      throw new BadRequestException('Only a dissatisfaction escalation can be turned into a correction this way');
    }
    const trimmedNote = note.trim();
    if (!trimmedNote) throw new BadRequestException('Note cannot be empty');

    const situationContext = escalation.visitorQuestion ?? escalation.question;
    const badReply = escalation.botReply ?? '';
    const classification = await this.yandexGpt.classifyDislikeNote(situationContext, badReply, trimmedNote);

    if (classification.type === 'fact') {
      await this.knowledge.createForBot(escalation.botId, companyId, situationContext, trimmedNote, 'test_chat', {
        moderationStatus: 'approved',
      });
    } else if (classification.type === 'instruction') {
      await this.knowledge.createInstruction(companyId, trimmedNote, escalation.botId);
    } else {
      await this.knowledge.createCorrection(companyId, situationContext, badReply, trimmedNote, escalation.botId);
    }

    await this.prisma.escalation.update({ where: { id: escalationId }, data: { processedAt: new Date() } });
    return { ok: true, type: classification.type };
  }

  /**
   * Owner-typed alternative greeting hook, wrapped into the same pinned
   * instruction shape as the AI-generated ones (see YandexGptService) and
   * appended to the greeting stage's variant pool — from this point on it's
   * assigned to new dialogs on the same random-pick basis as every other
   * variant, and its own show/dialog/conversion numbers show up in the same
   * A/B/C/D report.
   */
  async addGreetingVariant(companyId: string, text: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);

    const stages = Array.isArray(bot.funnelConfig) ? (bot.funnelConfig as unknown as FunnelStage[]) : [];
    const greetingIdx = stages.findIndex((s) => s.stageId === 'greeting');
    if (greetingIdx === -1) throw new BadRequestException('This bot has no greeting stage to test variants on');

    const instruction = this.yandexGpt.buildPinnedOpenerInstruction(text);
    const existingVariants = stages[greetingIdx].variants ?? [];
    const updatedStages = stages.map((s, i) =>
      i === greetingIdx ? { ...s, variants: [...existingVariants, instruction] } : s,
    );

    await this.prisma.bot.update({ where: { id: bot.id }, data: { funnelConfig: updatedStages as any } });
    return { ok: true };
  }

  /**
   * Doesn't delete anything — just moves the analytics floor to now(), so
   * old test/dev traffic (or anything else predating this point) stops
   * counting toward Показов/Диалогов/Заявок without destroying the actual
   * dialog/lead rows.
   */
  async resetStats(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    await this.prisma.bot.update({ where: { id: bot.id }, data: { analyticsResetAt: new Date() } });
    return { ok: true };
  }

  async getGoal(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    return {
      goalLabel: bot.goalLabel,
      goalPreset: bot.goalPreset,
      presets: Object.entries(GOAL_PRESETS).map(([key, p]) => ({ key, label: p.label })),
    };
  }

  async setGoal(companyId: string, preset: string, customText?: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);

    let label: string;
    let instruction: string;
    if (preset === 'custom') {
      if (!customText || customText.trim().length < 3) {
        throw new BadRequestException('customText is required for a custom goal');
      }
      label = customText.trim().slice(0, 60);
      instruction = `Цель этого бота, заданная владельцем: ${customText.trim()}`;
    } else {
      const p = GOAL_PRESETS[preset];
      if (!p) throw new BadRequestException('Unknown goal preset');
      label = p.label;
      instruction = p.instruction;
    }

    await this.prisma.bot.update({
      where: { id: bot.id },
      data: {
        goalLabel: label,
        goalInstruction: instruction,
        goalPreset: preset,
        // One-way: picking "Продать в чате" turns payment tracking on since
        // it's now directly relevant; picking something else never turns it
        // back off (a bot legitimately tracking payments for other reasons
        // shouldn't lose that just because the goal changed).
        ...(preset === 'chat_sale' && { tracksPayments: true }),
      },
    });
    return { ok: true, goalLabel: label, goalPreset: preset };
  }

  async getCrmIntegrations(companyId: string, botId?: string) {
    let bot = await this.findOwnedBot(companyId, botId);
    // Self-heal: any bot connected BEFORE the inbound-webhook feature shipped
    // has bitrix24WebhookUrl set but no token, so bitrix24InboundWebhookUrl
    // below would silently stay null forever — the owner would never even
    // see the field to paste into Bitrix's "Исходящий вебхук" config, with
    // no way to trigger regeneration short of clearing and re-pasting the
    // same outbound URL. Since the token is just an opaque routing secret
    // (nothing depends on WHEN it was minted), it's safe to backfill on read.
    if (bot.bitrix24WebhookUrl && !bot.bitrix24WebhookToken) {
      bot = await this.prisma.bot.update({ where: { id: bot.id }, data: { bitrix24WebhookToken: randomUUID() } });
    }
    return {
      bitrix24Connected: Boolean(bot.bitrix24WebhookUrl),
      // Only meaningful once bitrix24WebhookUrl is actually set (see
      // saveBitrix24) — the owner pastes this into their portal's own
      // "Разработчикам → Другое → Исходящий вебхук" config so
      // ONCRMDEALUPDATE/ONCRMLEADUPDATE reach Bitrix24WebhookController.
      bitrix24InboundWebhookUrl: bot.bitrix24WebhookToken ? `${this.baseUrl}/api/webhooks/bitrix24/${bot.bitrix24WebhookToken}` : null,
      amocrmConnected: Boolean(bot.amocrmSubdomain && bot.amocrmAccessToken),
      amocrmSubdomain: bot.amocrmSubdomain,
    };
  }

  // Feeds the pipeline-settings stage-mapping dropdowns — see
  // CrmIntegrationService.getStageMappingOptions's own comment on why this
  // exists (nobody could reasonably type a raw Bitrix/amoCRM stage id by
  // hand). companyId param is only there because CrmTargetBot requires it;
  // getStageMappingOptions itself never reads it.
  async getCrmStageOptions(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    return this.crmIntegration.getStageMappingOptions({
      bitrix24WebhookUrl: bot.bitrix24WebhookUrl,
      amocrmSubdomain: bot.amocrmSubdomain,
      amocrmAccessToken: bot.amocrmAccessToken,
      companyId,
    });
  }

  // Read-side for WidgetService's leadCaptured branch — kept here (not on
  // TelegramService, which self-contains its own equivalent lookup) because
  // CabinetService already owns EmailService and every other Company-level
  // notification-config read (getCrmIntegrations, etc.).
  async getNotificationEmailConfig(companyId: string): Promise<{ email: string; companyName: string } | null> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company?.notificationEmail) return null;
    return { email: company.notificationEmail, companyName: company.name };
  }

  async getLeadNotificationSettings(companyId: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Company not found');
    return {
      telegramConnected: Boolean(company.telegramChatId),
      notifyLeadsViaTelegram: company.notifyLeadsViaTelegram,
      notificationEmail: company.notificationEmail,
    };
  }

  async setLeadNotificationSettings(companyId: string, input: { notifyLeadsViaTelegram?: boolean; notificationEmail?: string | null }) {
    const data: Prisma.CompanyUpdateInput = {};
    if (typeof input.notifyLeadsViaTelegram === 'boolean') data.notifyLeadsViaTelegram = input.notifyLeadsViaTelegram;
    if (input.notificationEmail !== undefined) {
      const trimmed = input.notificationEmail?.trim() ?? '';
      if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        throw new BadRequestException('Некорректный email');
      }
      data.notificationEmail = trimmed || null;
    }
    await this.prisma.company.update({ where: { id: companyId }, data });
    return { ok: true };
  }

  async saveBitrix24(companyId: string, webhookUrl: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    const trimmed = webhookUrl.trim();
    if (trimmed && !/^https:\/\/[^/]+\.bitrix24\.[a-z.]+\/rest\/\d+\/[A-Za-z0-9]+\/?$/.test(trimmed)) {
      throw new BadRequestException(
        'Похоже, это не ссылка входящего вебхука Bitrix24 — она должна выглядеть как ' +
          'https://ваш-портал.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/',
      );
    }
    // Empty string clears the connection — same convention as the LLM
    // provider's systemPromptOverride (see LlmProviderService.setSystemPrompt).
    // The inbound token is generated once and kept forever after (even
    // across a webhook URL being cleared/re-saved) — the owner would
    // otherwise have to re-paste a new inbound URL into Bitrix every time
    // they touch this field.
    await this.prisma.bot.update({
      where: { id: bot.id },
      data: {
        bitrix24WebhookUrl: trimmed ? (trimmed.endsWith('/') ? trimmed : trimmed + '/') : null,
        ...(trimmed && !bot.bitrix24WebhookToken ? { bitrix24WebhookToken: randomUUID() } : {}),
      },
    });
    return { ok: true };
  }

  async saveAmoCrm(companyId: string, subdomain: string, accessToken: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    const trimmedSubdomain = subdomain.trim().toLowerCase();
    const trimmedToken = accessToken.trim();
    if (trimmedSubdomain && !/^[a-z0-9-]+$/.test(trimmedSubdomain)) {
      throw new BadRequestException('Поддомен amoCRM — это только часть до ".amocrm.ru", например "mycompany".');
    }
    // Both empty clears the connection; if only one is given, keep whichever
    // was already saved for the other (so re-saving just the token to
    // rotate it doesn't require retyping the subdomain, and vice versa).
    await this.prisma.bot.update({
      where: { id: bot.id },
      data: {
        amocrmSubdomain: trimmedSubdomain || (trimmedToken ? bot.amocrmSubdomain : null),
        amocrmAccessToken: trimmedToken || (trimmedSubdomain ? bot.amocrmAccessToken : null),
      },
    });
    return { ok: true };
  }

  /** Ownership check inline — a lead only belongs to one company via its dialog's bot. */
  async markLeadPaid(companyId: string, leadId: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, include: { dialog: { include: { bot: true } } } });
    if (!lead || lead.dialog.bot.companyId !== companyId) throw new NotFoundException('Lead not found');
    await this.prisma.lead.update({ where: { id: leadId }, data: { paidAt: new Date() } });
    return { ok: true };
  }

  /**
   * Same ownership pattern — an escalation only belongs to one company
   * directly. Verifying also mirrors the Q&A into the bot's knowledge base
   * (source: telegram) — the same event that already made it live in the
   * prompt now also makes it a visible, editable row on "База знаний".
   */
  async verifyEscalation(companyId: string, escalationId: string) {
    const escalation = await this.prisma.escalation.findUnique({ where: { id: escalationId } });
    if (!escalation || escalation.companyId !== companyId) throw new NotFoundException('Escalation not found');
    if (!escalation.answer) throw new BadRequestException('Cannot verify an escalation with no answer yet');
    await this.prisma.escalation.update({ where: { id: escalationId }, data: { verifiedAt: new Date() } });
    // For "dissatisfaction" escalations, escalation.question is the model's own
    // "what went wrong" summary, not the real question — indexing the KB entry
    // under that summary would make it unfindable for the actual question a
    // future visitor asks. visitorQuestion (when present) is the real one.
    const kbQuestion = escalation.visitorQuestion ?? escalation.question;
    await this.knowledge.createForBot(escalation.botId, companyId, kbQuestion, escalation.answer, 'telegram');
    return { ok: true };
  }

  // Structured PII only — phone/email are what a visitor actually types
  // inline in chat text (leadData already went through the code-verified
  // consent gate elsewhere; this is just about not echoing raw contact
  // details back into a conversation-quality debugging view). Free-text
  // names aren't touched — no reliable pattern to redact them by, and unlike
  // phone/email they're not identifying on their own in this context.
  private redactPii(text: string): string {
    return text
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email скрыт]')
      .replace(/(?:\+7|8|7)?[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}(?!\d)/g, '[телефон скрыт]');
  }

  async getEscalationDialog(companyId: string, escalationId: string) {
    const escalation = await this.prisma.escalation.findUnique({ where: { id: escalationId } });
    if (!escalation || escalation.companyId !== companyId) throw new NotFoundException('Escalation not found');
    if (!escalation.dialogId) throw new NotFoundException('This escalation has no linked conversation');

    const messages = await this.prisma.message.findMany({
      where: { dialogId: escalation.dialogId },
      orderBy: { createdAt: 'asc' },
    });

    return {
      reason: escalation.reason,
      question: escalation.question,
      visitorQuestion: escalation.visitorQuestion,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: this.redactPii(m.content),
        createdAt: m.createdAt,
        dislikedAt: m.dislikedAt,
      })),
    };
  }

  // Surfaces, inside "Требует внимания", which unanswered questions keep
  // coming up across DIFFERENT visitors — the strongest signal for what's
  // actually worth fixing first vs. a one-off. Deliberately NOT run
  // automatically (an LLM call per request) — the tab has its own "Найти
  // повторы" button that calls this on demand.
  async getRecurringQuestions(companyId: string, botId?: string) {
    const where: Prisma.EscalationWhereInput = { companyId, reason: 'unanswered' };
    if (botId) where.botId = botId;
    const escalations = await this.prisma.escalation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: { id: true, question: true, dialogId: true, answeredAt: true, createdAt: true },
    });
    if (escalations.length < 2) return { clusters: [] };

    const clusters = await this.yandexGpt.clusterRecurringQuestions(
      escalations.map((e) => ({ id: e.id, text: e.question })),
    );
    const byId = new Map(escalations.map((e) => [e.id, e]));

    return {
      clusters: clusters
        .filter((c) => c.ids.length >= 2)
        .map((c) => ({
          representativeText: c.representativeText,
          count: c.ids.length,
          escalations: c.ids
            .map((id) => byId.get(id))
            .filter((e): e is (typeof escalations)[number] => !!e)
            .map((e) => ({
              id: e.id,
              question: e.question,
              dialogId: e.dialogId,
              answered: !!e.answeredAt,
              createdAt: e.createdAt,
            })),
        }))
        .sort((a, b) => b.count - a.count),
    };
  }

  // "Реестр диалогов" — every real conversation across every bot of this
  // company, not just the ones that happened to escalate (getEscalationDialog
  // above only ever shows one escalation's own dialog). Lazy-loaded by the
  // cabinet's own "Диалоги" tab, same convention as loadSupportTickets — not
  // bot-scoped, so it can't ride the generic loadBotScopedData() chain.
  async listDialogs(companyId: string, opts: { botId?: string; page?: number } = {}) {
    const pageSize = 30;
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const where: Prisma.DialogWhereInput = { bot: { companyId }, isPreview: false };
    if (opts.botId) where.botId = opts.botId;

    const [dialogs, total] = await Promise.all([
      this.prisma.dialog.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          bot: { select: { name: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          lead: { select: { name: true, phone: true, email: true, redactedAt: true } },
          _count: { select: { messages: true } },
        },
      }),
      this.prisma.dialog.count({ where }),
    ]);

    const dialogIds = dialogs.map((d) => d.id);
    const [escalations, deals] = dialogIds.length
      ? await Promise.all([
          this.prisma.escalation.findMany({
            where: { dialogId: { in: dialogIds } },
            select: { dialogId: true, answeredAt: true },
          }),
          this.prisma.deal.findMany({
            where: { dialogId: { in: dialogIds } },
            select: { id: true, dialogId: true, title: true },
          }),
        ])
      : [[], []];

    const escByDialog = new Map<string, { unanswered: number }>();
    for (const e of escalations) {
      if (!e.dialogId) continue;
      const cur = escByDialog.get(e.dialogId) ?? { unanswered: 0 };
      if (!e.answeredAt) cur.unanswered += 1;
      escByDialog.set(e.dialogId, cur);
    }
    const dealByDialog = new Map(deals.filter((d) => d.dialogId).map((d) => [d.dialogId as string, d]));

    return {
      total,
      page,
      pageSize,
      dialogs: dialogs.map((d) => {
        const esc = escByDialog.get(d.id);
        const deal = dealByDialog.get(d.id);
        const lastMessage = d.messages[0];
        return {
          id: d.id,
          botName: d.bot.name,
          status: d.status,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          messageCount: d._count.messages,
          lastMessagePreview: lastMessage ? this.redactPii(lastMessage.content).slice(0, 140) : null,
          lastMessageRole: lastMessage?.role ?? null,
          hasEscalation: !!esc,
          hasUnansweredEscalation: !!esc && esc.unanswered > 0,
          lead: d.lead && !d.lead.redactedAt ? { name: d.lead.name, phone: d.lead.phone, email: d.lead.email } : null,
          dealId: deal?.id ?? null,
          dealTitle: deal?.title ?? null,
        };
      }),
    };
  }

  // Full transcript for one dialog, keyed by dialogId directly rather than by
  // escalationId (unlike getEscalationDialog above) — used both by the
  // "Диалоги" registry and by the CRM deal panel (a Deal carries dialogId
  // when it originated from a chat lead or self-sell provisioning).
  async getDialogDetail(companyId: string, dialogId: string) {
    const dialog = await this.prisma.dialog.findFirst({
      where: { id: dialogId, bot: { companyId } },
      include: { bot: { select: { name: true } }, lead: true },
    });
    if (!dialog) throw new NotFoundException('Dialog not found');

    const [messages, escalations, deal] = await Promise.all([
      this.prisma.message.findMany({ where: { dialogId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.escalation.findMany({ where: { dialogId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.deal.findFirst({ where: { dialogId } }),
    ]);

    return {
      id: dialog.id,
      botName: dialog.bot.name,
      status: dialog.status,
      createdAt: dialog.createdAt,
      lead: dialog.lead && !dialog.lead.redactedAt
        ? { name: dialog.lead.name, phone: dialog.lead.phone, email: dialog.lead.email }
        : null,
      dealId: deal?.id ?? null,
      dealTitle: deal?.title ?? null,
      escalations: escalations.map((e) => ({
        id: e.id,
        reason: e.reason,
        question: e.question,
        answer: e.answer,
        answeredAt: e.answeredAt,
      })),
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: this.redactPii(m.content),
        createdAt: m.createdAt,
        dislikedAt: m.dislikedAt,
      })),
    };
  }

  /**
   * On-demand only (see YandexGptService.summarizeDialog's own comment) —
   * called when the "Диалоги" panel's own summary button is clicked, never
   * pre-generated for the whole list. Same ownership check + PII redaction
   * as getDialogDetail above, since this reads the same messages.
   */
  async summarizeDialog(companyId: string, dialogId: string): Promise<{ summary: string }> {
    const dialog = await this.prisma.dialog.findFirst({ where: { id: dialogId, bot: { companyId } } });
    if (!dialog) throw new NotFoundException('Dialog not found');

    const messages = await this.prisma.message.findMany({ where: { dialogId }, orderBy: { createdAt: 'asc' } });
    if (messages.length === 0) return { summary: 'В этом диалоге пока нет сообщений.' };

    const { text } = await this.yandexGpt.summarizeDialog(
      messages.map((m) => ({ role: m.role, content: this.redactPii(m.content) })),
    );
    return { summary: text };
  }

  /**
   * The cabinet's own equivalent of typing a Telegram reply to an
   * escalation — same draft-then-confirm safety net (see
   * TelegramService.handleReplyAnswer's own comment for why this is never
   * one step): text=your own rough draft gets grammar-polished (facts
   * untouched, same polishAnswer used for a Telegram draft), text omitted
   * asks the model to propose an answer from scratch using the bot's own
   * systemPrompt as context. Either way this only returns a preview —
   * nothing is written until confirmAnswer below.
   */
  async previewEscalationAnswer(companyId: string, escalationId: string, text?: string): Promise<{ text: string }> {
    const escalation = await this.prisma.escalation.findFirst({
      where: { id: escalationId, companyId },
      include: { bot: { select: { systemPrompt: true } } },
    });
    if (!escalation) throw new NotFoundException('Escalation not found');
    if (escalation.answeredAt) throw new BadRequestException('Escalation already answered');

    if (text?.trim()) {
      const { text: polished } = await this.yandexGpt.polishAnswer(text);
      return { text: polished };
    }
    const question = escalation.visitorQuestion ?? escalation.question;
    const { text: suggested } = await this.yandexGpt.suggestEscalationAnswer(question, escalation.bot.systemPrompt);
    return { text: suggested };
  }

  /**
   * Finalizes whatever the owner confirmed (the preview above, edited or
   * not) — same effect as a confirmed Telegram reply: sets answer/answeredAt,
   * delivers into the live chat session if it's still open (the visitor's
   * widget picks it up via its own poll — see WidgetService.getNewMessages),
   * moves the escalation into "Ответили — осталось проверить" (already
   * wired: /escalations/:id/verify is what pushes it into the knowledge base
   * once the owner has actually checked it in the test chat).
   */
  async confirmEscalationAnswer(companyId: string, escalationId: string, text: string): Promise<{ ok: true }> {
    const escalation = await this.prisma.escalation.findFirst({ where: { id: escalationId, companyId } });
    if (!escalation) throw new NotFoundException('Escalation not found');
    if (escalation.answeredAt) throw new BadRequestException('Escalation already answered');
    if (!text?.trim()) throw new BadRequestException('Answer text is required');

    // updateMany with answeredAt: null in the WHERE, not a separate read-then-write,
    // so the "already answered?" check and the write are one atomic statement — a
    // double-click or a client retry racing this same call only ever lets one of
    // them win, instead of both passing the earlier findFirst check and both
    // appending a duplicate assistant message into the live dialog below. Same
    // WHERE shape as TelegramService.handleReplyAnswer's own confirm write, so
    // an owner confirming in Telegram and in this cabinet UI at nearly the same
    // moment for the same escalation also serialize against EACH OTHER through
    // Postgres, not just against a second call to this same method.
    const { count } = await this.prisma.escalation.updateMany({
      where: { id: escalationId, answeredAt: null },
      data: { answer: text.trim(), answeredAt: new Date() },
    });
    if (count === 0) throw new BadRequestException('Escalation already answered');
    if (escalation.dialogId) {
      // MessagesService.append, not a raw prisma.message.create — the same
      // helper TelegramService.handleReplyAnswer's confirm branch already
      // uses for this identical "deliver the confirmed answer into the live
      // dialog" step, so both confirm paths stay behaviorally identical if
      // append ever grows a side effect (e.g. bumping a dialog's
      // lastMessageAt) instead of silently diverging.
      await this.messages.append(escalation.dialogId, MessageRole.assistant, text.trim());
    }
    return { ok: true };
  }

  private async findPendingCompany(token: string) {
    if (!token) throw new NotFoundException('Invalid or already-used registration link');
    const company = await this.prisma.company.findUnique({ where: { registrationToken: token } });
    if (!company || company.registeredAt) {
      throw new NotFoundException('Invalid or already-used registration link');
    }
    return company;
  }
}
