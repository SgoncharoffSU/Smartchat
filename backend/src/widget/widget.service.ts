import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DialogStatus, MessageRole } from '@prisma/client';
import { BotsService } from '../bots/bots.service';
import { DialogsService } from '../dialogs/dialogs.service';
import { MessagesService } from '../messages/messages.service';
import { LeadsService } from '../leads/leads.service';
import { CrmIntegrationService } from '../leads/crm-integration.service';
import { YandexGptService } from '../yandex-gpt/yandex-gpt.service';
import { ChatTurn } from '../yandex-gpt/yandex-gpt.types';
import { BotRateLimiterService } from './bot-rate-limiter.service';
import { SendMessageDto } from './dto/send-message.dto';
import { ProvisioningService, ProvisionResult } from '../provisioning/provisioning.service';
import { SiteAnalysisService } from '../site-analysis/site-analysis.service';
import { TelegramService } from '../telegram/telegram.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { CabinetService, GOAL_PRESETS, GOAL_FOLLOWUP_QUESTIONS } from '../cabinet/cabinet.service';
import { AuthService } from '../auth/auth.service';
import { EmailService } from '../email/email.service';
import { BillingService } from '../payments/billing.service';

// Loose match for "the visitor just typed a domain or URL" — deliberately
// permissive (no protocol required) since visitors paste bare domains like
// "glavinstrument.com" as often as full URLs.
const URL_IN_TEXT_PATTERN = /(https?:\/\/[^\s,]+|(?:[a-zA-Zа-яёА-ЯЁ0-9-]+\.)+[a-zA-Zа-яёА-ЯЁ]{2,}(?:\/[^\s,]*)?)/;

// Anchored on purpose — only fires when the ENTIRE message is just a bare
// greeting, not when a real question happens to start with one (e.g.
// "Здравствуйте, подскажите стоимость" keeps its normal reply). Seen live:
// mid-conversation the model treated a bare "привет" exactly like a brand
// new dialog — re-introducing itself and re-running its last pitch almost
// verbatim, which reads as pushy and forgetful rather than attentive.
const BARE_GREETING_PATTERN =
  /^(привет|здравствуй(?:те)?|добрый\s*(?:день|вечер|ночи)|доброе\s*утро|хай|хеллоу|hello|hi)[!.,\s]*$/i;

// Anchored, same reasoning as BARE_GREETING_PATTERN above — only fires when
// the visitor's ENTIRE message is a bare "yes"/"let's go", not when a real
// sentence happens to start with one of these words.
const AFFIRMATIVE_PATTERN =
  /^(да|давай(?:те)?|хочу|ок|окей|хорошо|согласн[аы]?|конечно|угу|ага|поехали|го|готов[а]?|я передумал[аи]?)[!.,\s]*$/i;

// Self-referential short predicate adjectives only — the safest slice of
// Russian gender agreement to regex reliably. Deliberately NOT `\b` for the
// boundaries: JS regex `\b` is defined against ASCII word characters only,
// so it doesn't work as a boundary around Cyrillic letters at all — every
// version of this pattern that used `\b` around a Cyrillic word silently
// matched almost nothing. Word edges are spelled out explicitly instead
// (start-of-string/sentence, or literal " я ", and a following space/
// punctuation/end). Russian commonly drops the subject pronoun ("Рад
// видеть", not "Я рад видеть"), so these match either right after "я" or at
// the start of a sentence. Excludes "<adjective> ли" (a yes/no question
// about something else — "Готов ли ваш сайт..." — not a self-reference).
// Deliberately NOT trying to catch past-tense verb agreement (сделал/
// сделала) or a wider adjective list — those shapes have far more
// non-self-referential false positives than these four common, low-risk
// words (see hasWrongGenderSelfReference).
const MASCULINE_SELF_ADJECTIVE_PATTERN =
  /(^|[.!?]\s+|\sя\s+|^я\s+)(рад|готов|уверен|согласен)(?=$|[\s.,!?])(?!\s+ли(?=$|[\s.,!?]))/i;
const FEMININE_SELF_ADJECTIVE_PATTERN =
  /(^|[.!?]\s+|\sя\s+|^я\s+)(рада|готова|уверена|согласна)(?=$|[\s.,!?])(?!\s+ли(?=$|[\s.,!?]))/i;

const EXIT_CONDITION_TO_STATUS: Record<string, DialogStatus> = {
  handoff: DialogStatus.handoff,
  closed: DialogStatus.closed,
};

const REGISTRATION_LINK_PLACEHOLDER = '{{REGISTRATION_LINK}}';

// Consent is decided here, in code, not by the model's free-text judgment —
// found live: a visitor asked "what does that mean?" (a question, not an
// answer) and the model still set pdConsentGiven=true, thanking them for
// consent they never gave. A fixed button the visitor actually clicks is the
// one signal that can never be ambiguous; it's checked below via
// dto.buttonPayload regardless of what any given bot's own funnel/systemPrompt
// text says (those vary per bot and are baked in at generation time, so a
// prompt-only fix wouldn't reach bots whose funnel was already generated).
const PD_CONSENT_BUTTON_LABEL = 'Согласен(на) на обработку данных';
// Explicit decline, shown right alongside the consent button — never force a
// visitor to either agree or find their own way out of the conversation.
const PD_DECLINE_BUTTON_LABEL = 'Не сейчас';
const PRIVACY_POLICY_URL = `${process.env.PUBLIC_BASE_URL ?? 'https://chat.glavinstrument.com'}/cabinet/privacy.html`;
// The URL must be the last thing before a period, not wrapped in parentheses
// or followed by any other trailing character — chat.js's link-detection
// regex treats a handful of punctuation marks as safe-to-strip trailing
// punctuation, but not ")": "(...${URL})." got the stray ")" pulled into the
// href itself (a real link to ".../privacy.html)" — 404s, looks broken).
const PD_CONSENT_REQUEST_TEXT =
  'Чтобы передать это менеджеру, нужно ваше согласие на обработку персональных данных. Вот наша политика ' +
  `обработки данных: ${PRIVACY_POLICY_URL} Если согласны — нажмите кнопку ниже.`;

// Used when the visitor opened the chat too quickly for the outside teaser
// bubble to appear first — there's no hook to react to, this genuinely is the
// very first thing they see, so it has to stand on its own as a real greeting
// (self-intro + hook + first question all in one) rather than reacting to
// something the visitor never actually saw.
const COLD_OPEN_INSTRUCTIONS =
  'Это самое первое сообщение разговора — посетитель открыл чат до того, как успел появиться превью снаружи, ' +
  'так что никакого твоего вопроса-крючка он ещё не видел. Одним живым сообщением: поздоровайся, представься ' +
  'по имени коротко и естественно, зацепи внимание чем-то неожиданным по существу (не общими фразами вроде ' +
  '"я ИИ-ассистент"), и сразу задай ОДИН лёгкий вопрос, на который легко ответить одним словом или кликом ' +
  '(например, есть ли у него сайт компании — да/нет, или какая у него ниша, с готовыми вариантами кнопок). ' +
  'ЗАПРЕЩЕНО открывать разговор вопросом вроде "расскажите о вашем бизнесе" или "какой у вас бизнес?" — это ' +
  'требует от собеседника усилия сформулировать ответ с нуля, и в переписке на такое обычно просто не отвечают.';

// Used only for the "reveal" turn — fired the moment the visitor actually opens
// the chat, right after the outside teaser hook (isInit) already ran. Replaces
// whatever the current stage's own instructions are for this one turn, since
// the stage instructions are written for generating the hook itself, not for
// following up on it.
const REVEAL_INSTRUCTIONS =
  'Собеседник только что открыл чат, уже увидев твой первый вопрос-крючок снаружи. Твоя реплика ОБЯЗАНА ' +
  'содержать ровно два элемента, оба в одном живом сообщении: (1) представление по имени — прямо и открыто, ' +
  'например "Добрый день, меня зовут Айна!" (используй своё настоящее имя из системного промпта выше, не ' +
  '"Айна" буквально). Это первое настоящее знакомство после крючка — полноценное приветствие с именем здесь ' +
  'уместно и естественно, не нужно прятать имя как деталь "кстати" или мимоходом; без представления реплика ' +
  'выглядит куцо и обрывочно, сокращать до одного голого вопроса нельзя; (2) сразу следом — ОДИН ' +
  'лёгкий, конкретный вопрос, на который легко ответить одним словом или кликом (например, есть ли у него ' +
  'сайт компании — да/нет, или на какую нишу/сайт посмотреть).\n' +
  'ЗАПРЕЩЕНО задавать открытый вопрос вроде "расскажите о вашем бизнесе" или "какой у вас бизнес?" — ' +
  'собеседнику трудно с ходу сформулировать ответ на такое, и в переписке на это обычно просто не отвечают; ' +
  'узкий вопрос с понятным и коротким ответом работает лучше.\n' +
  'ЗАПРЕЩЕНО повторять фразу-крючок нигде в этой реплике — ни в начале, ни в середине, ни близко к тексту, ' +
  'даже частично. Собеседник её уже прочитал секунду назад; повтор выглядит так, будто ты разговариваешь ' +
  'сама с собой. Это должен быть полностью новый текст, просто продолжающий разговор дальше.\n' +
  'Это касается не только буквального текста, но и СУТИ вопроса: если крючок уже был построен как вопрос ' +
  'или уже затрагивал конкретную тему (например, крючок сам спрашивал про цвета, материалы, бюджет или ' +
  'другую деталь) — новый вопрос в этой реплике ОБЯЗАН быть про другую тему, не той же самой другими ' +
  'словами. Собеседник ещё ни на что не успел ответить: если крючок и твой новый вопрос по сути об одном и ' +
  'том же, это читается как один и тот же вопрос, заданный дважды подряд за несколько секунд, — раздражает ' +
  'и выглядит так, будто его не услышали, хотя он ещё даже не открыл рот.\n' +
  'Сохраняй тот же лёгкий, неформальный голос и настрой, что был в крючке — приветствие и имя можно и нужно ' +
  'дать прямо и полноценно (см. выше), но не сваливайся в казённые канцелярские формулировки вроде "я ' +
  'представляю компанию ..." — это ощущается так, будто разговор начался заново и крючка не было.\n' +
  'Ничего не домысливай про реакцию собеседника на крючок: то, что он открыл чат, — просто клик, а не ' +
  'согласие на что-либо и не подтверждённый интерес к тому, что было в крючке. Не пиши так, будто он на ' +
  'что-то согласился ("договорились", "отлично, начнём" и т.п.) — он мог открыть чат из любопытства, толком ' +
  'не прочитав крючок.';

// "Обучение" mode: a menu-driven configurator rather than another LLM
// persona or a fixed sequence of questions — the owner picks what they want
// to do (or just starts typing, which defaults to "add to knowledge base"),
// and each action reuses the exact same tool the cabinet's own pages use.
const TRAINING_MENU_MESSAGE = 'Готов обучаться! Есть новая информация для меня, или хотите что-то исправить?';
const TRAINING_BTN_KB = 'Загрузить текст в базу знаний';
const TRAINING_BTN_ADVICE = 'Дать совет';
const TRAINING_BTN_SITE = 'Добавить сайт или страницу сайта';
const TRAINING_BTN_GOAL = 'Поставить цель боту';
const TRAINING_BTN_VARIANT = 'Добавить фразу для теста';
const TRAINING_BTN_TELEGRAM = 'Подключить Telegram';
const TRAINING_MENU_BUTTONS = [
  TRAINING_BTN_KB,
  TRAINING_BTN_ADVICE,
  TRAINING_BTN_SITE,
  TRAINING_BTN_GOAL,
  TRAINING_BTN_VARIANT,
  TRAINING_BTN_TELEGRAM,
];

// Anchored on purpose — only fires when the ENTIRE message is basically just
// "cancel"/"never mind", not when that word merely appears inside a real KB
// sentence the owner meant to add (e.g. "мы отменяем заказы за 24 часа").
const TRAINING_CANCEL_PATTERN =
  /^(отмен[аиьяю]+(\s*это)?|не\s*надо|забудь(\s*это)?|удали(\s*это)?|сотри(\s*это)?|убери(\s*это)?|стоп|отставить)[.!\s]*$/i;
// Shown alongside every "Пришлите..." prompt (see trainingAskFor) so
// backing out of a question the owner didn't mean to trigger doesn't require
// already knowing the right magic word to type — same underlying check
// (TRAINING_CANCEL_PATTERN matches this label too), just discoverable as a
// button instead of only a typed escape hatch.
const TRAINING_BTN_CANCEL = 'Отмена';

// Reverse lookup for the goal sub-menu: button label -> preset key.
const GOAL_LABEL_TO_PRESET: Record<string, string> = Object.fromEntries(
  Object.entries(GOAL_PRESETS).map(([key, p]) => [p.label, key]),
);
const GOAL_BUTTON_LABELS = Object.values(GOAL_PRESETS).map((p) => p.label);

// Thrown (never returned) when the visitor's own real message won the race
// against an auto-fired isInit/isReveal turn and made it moot — see
// sendMessage's catch below, which turns this into a quiet no-op rather than
// a logged error. It's not a failure; it's the cancellation working exactly
// as intended.
class SupersededTurnError extends Error {}

@Injectable()
export class WidgetService {
  private readonly logger = new Logger(WidgetService.name);
  private readonly dialogLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly bots: BotsService,
    private readonly dialogs: DialogsService,
    private readonly messages: MessagesService,
    private readonly leads: LeadsService,
    private readonly crmIntegration: CrmIntegrationService,
    private readonly yandexGpt: YandexGptService,
    private readonly botRateLimiter: BotRateLimiterService,
    private readonly provisioning: ProvisioningService,
    private readonly siteAnalysis: SiteAnalysisService,
    private readonly telegram: TelegramService,
    private readonly knowledge: KnowledgeService,
    private readonly cabinet: CabinetService,
    private readonly auth: AuthService,
    private readonly email: EmailService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Called from DislikesService's preview step — regenerates a candidate
   * reply for a flagged bad message using the owner's correction note,
   * WITHOUT touching the dialog or persisting anything, so the owner can
   * see whether it's actually better before it gets remembered as a
   * KnowledgeEntry (see DislikesService.resolve). Rebuilds history and
   * stage the same way a real turn would have, using UNIVERSAL_STAGE_GUIDANCE
   * so the preview reflects the exact same live rules the bot itself follows
   * — a preview built from stale rules would show the owner a fix that
   * looks right but doesn't match what the bot would actually say.
   */
  async previewCorrectedReply(companyId: string, messageId: string, note: string): Promise<{ candidateReply: string }> {
    const message = await this.messages.findDislikedMessage(companyId, messageId);
    if (!message) throw new NotFoundException('Disliked message not found');

    const dialog = message.dialog;
    const bot = dialog.bot;

    const allMessages = await this.messages.listByDialog(dialog.id);
    const priorMessages = allMessages.filter((m) => m.createdAt < message.createdAt);
    const MAX_HISTORY_MESSAGES = 20;
    const chatHistory: ChatTurn[] = priorMessages.slice(-MAX_HISTORY_MESSAGES).map((m) => ({
      role: m.role === MessageRole.visitor ? 'user' : m.role === MessageRole.assistant ? 'assistant' : 'system',
      content: m.content,
    }));

    const stages = this.bots.getFunnelStages(bot);
    const stage =
      (dialog.currentStageId ? this.bots.findStage(bot, dialog.currentStageId) : undefined) ??
      this.bots.getInitialStage(bot);

    const stageInstructions =
      (stage?.instructions ?? 'Greet the visitor and learn what they need.') +
      WidgetService.UNIVERSAL_STAGE_GUIDANCE +
      WidgetService.buildCorrectionNudge(message.content, note);

    const result = await this.yandexGpt.generateReply({
      systemPrompt: bot.systemPrompt,
      stageInstructions,
      currentStageId: stage?.stageId ?? 'greeting',
      stages,
      history: chatHistory,
    });

    // Seen live: a handoff-stage candidate came back with the literal
    // "{{REGISTRATION_LINK}}" token still in it — this preview path never
    // runs the real substitution (see processMessage below), which actually
    // provisions a client company and mints a real per-visitor link, a
    // side effect that has no business happening from a "just show me a
    // preview" click, let alone repeatedly on every "Попробовать ещё раз".
    // Worse, if the owner had confirmed it, that raw token (or any fixed
    // stand-in) would've been saved forever as a "correction" example — but
    // the real link is different for every visitor, so there's no fixed
    // text this situation could ever correctly remember. Refuse outright
    // rather than show something broken or bake in something wrong.
    if (result.reply.includes(REGISTRATION_LINK_PLACEHOLDER)) {
      throw new BadRequestException(
        'Это сообщение с персональной ссылкой на регистрацию — ссылка каждый раз своя для конкретного ' +
          'клиента, так что этот ответ нельзя "запомнить" как общий пример.',
      );
    }

    return { candidateReply: result.reply };
  }

  async sendMessage(dto: SendMessageDto, visitorIp?: string, sessionToken?: string, signal?: AbortSignal) {
    const bot = await this.bots.findActiveByWidgetToken(dto.botToken);
    if (!bot) throw new NotFoundException('Unknown or inactive bot token');

    // trainingMode hands out the same owner-level tools as /coach and
    // /knowledge (rewrite the KB, inject always-on instructions, reconnect
    // Telegram) — but /messages itself must stay public for real visitor
    // chat, so unlike those two routes this can't just be an @UseGuards on
    // the controller. A bot's widgetToken alone is not proof of ownership:
    // it's embedded in that bot's own public site for the visitor widget to
    // load at all, so anyone who views page source can read it. Found live —
    // a bot's Telegram notifications got reconnected to someone else's chat
    // this way.
    if (dto.trainingMode) {
      const payload = sessionToken ? this.auth.verifySession(sessionToken) : null;
      if (!payload || payload.companyId !== bot.companyId) {
        throw new UnauthorizedException('Training mode requires signing in as this bot\'s owner');
      }
    }

    // Own fields now (trial/subscription moved from Company to Bot — one
    // subscription per bot, see Bot's own schema comment), not bot.company.*.
    if (!bot.subscriptionActive && bot.trialEndsAt && bot.trialEndsAt < new Date()) {
      return {
        reply: 'Пробный период этого бота закончился. Свяжитесь с нами, чтобы продолжить пользоваться сервисом.',
        buttons: [],
        stage: 'trial_expired',
        dialogStatus: DialogStatus.closed,
        leadCaptured: false,
        botName: bot.name,
      };
    }

    if (!this.botRateLimiter.isAllowed(dto.botToken)) {
      throw new HttpException(
        'This bot is receiving too many messages right now, please try again shortly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Only on a real visitor's first load, never the owner's own cabinet
    // preview/training panes (those run inside chat.glavinstrument.com
    // itself, which would otherwise look like a "mismatched domain" on every
    // single use). Never awaited into the response — an abuse signal must
    // never slow down or fail a real visitor's first message.
    if (dto.isInit && !dto.isPreview && !dto.trainingMode && dto.pageHostname) {
      this.checkDomainIntegrity(bot, dto.pageHostname).catch((error) => {
        this.logger.error(`Domain integrity check failed for bot ${bot.id}: ${String(error)}`);
      });
    }

    const visitorText = dto.message?.trim() || dto.buttonPayload?.trim();
    const dialog = await this.dialogs.findOrCreate(bot.id, dto.sessionId, Boolean(dto.isPreview || dto.trainingMode));

    // The outside teaser bubble and the (lazily-loaded) chat iframe can both
    // race to call isInit/isReveal for the same brand-new dialog. A per-dialog
    // lock serializes everything below so the second call's "does this already
    // exist?" check always sees the first call's write — without it, both can
    // read "no message yet" concurrently and each generate their own opener.
    try {
      return await this.withDialogLock(dialog.id, () => this.processMessage(dto, bot, dialog, visitorText, visitorIp, signal));
    } catch (error) {
      // Client already disconnected (see chat.js's revealAbort) — nothing
      // reads this response either way. Swallowed here, not left to the
      // default exception filter, so a normal, expected cancellation never
      // shows up in the error log looking like a real failure.
      if (error instanceof SupersededTurnError || (error as { name?: string })?.name === 'AbortError') {
        return { reply: '', buttons: [], stage: dialog.currentStageId ?? 'greeting', dialogStatus: dialog.status, leadCaptured: false, botName: bot.name };
      }
      throw error;
    }
  }

  private async processMessage(
    dto: SendMessageDto,
    bot: NonNullable<Awaited<ReturnType<BotsService['findActiveByWidgetToken']>>>,
    dialog: Awaited<ReturnType<DialogsService['findOrCreate']>>,
    visitorText: string | undefined,
    visitorIp?: string,
    signal?: AbortSignal,
  ) {
    // Fetched once and threaded through isBlocked/chargeConfirmedLead/
    // chargeTokenUsage below — all three used to run this same bot+
    // tariffPlan query independently, 3 times over on any turn that captures
    // a lead (found by code review). tariffPlan.kind/rates don't change
    // mid-conversation, so this one snapshot is safe to reuse for all three.
    // Billing is per-bot now, not per-company (see Bot's own schema comment)
    // — "один бот – одна абонентская плата".
    const billingBot = await this.billing.getBotWithPlan(bot.id);
    // A 'token'-plan bot with a depleted balance, or an 'unlimited'-plan one
    // past its paid period — checked before touching the LLM at all (never
    // mid-generation: cutting a reply off partway would read as the bot
    // itself malfunctioning). No-op for anyone still just on the free trial
    // or with no tariffPlan chosen yet (see BillingService.isBlocked).
    if (await this.billing.isBlocked(bot.id, billingBot)) {
      const blockedReply = 'Сервис временно приостановлен — оплата не подтверждена или закончился баланс. Свяжитесь с администратором аккаунта.';
      const saved = await this.messages.append(dialog.id, MessageRole.assistant, blockedReply, []);
      return {
        reply: blockedReply,
        buttons: [],
        stage: dialog.currentStageId ?? 'greeting',
        dialogStatus: dialog.status,
        leadCaptured: false,
        botName: bot.name,
        messageId: saved.id,
      };
    }

    const existingMessages = await this.messages.listByDialog(dialog.id);

    if (dto.trainingMode) {
      return this.processTrainingMessage(dto, bot, dialog, visitorText, existingMessages);
    }

    if (dto.isInit) {
      // Idempotent: the proactive teaser bubble and the (lazily-loaded) chat
      // iframe can both race to call isInit for a brand-new session. Whichever
      // loses just gets back the opening turn that already exists, instead of
      // erroring or generating a second one.
      const firstAssistant = existingMessages.find((m) => m.role === MessageRole.assistant);
      if (firstAssistant) {
        return {
          reply: firstAssistant.content,
          buttons: (firstAssistant.buttons as string[] | null) ?? [],
          stage: dialog.currentStageId ?? 'greeting',
          dialogStatus: dialog.status,
          leadCaptured: false,
          botName: bot.name,
          messageId: firstAssistant.id,
        };
      }
    } else if (dto.isReveal) {
      // Idempotent, same reasoning as isInit: valid immediately after the
      // teaser hook (exactly one prior assistant message, no visitor reply
      // yet) OR as the very first message ever (cold open, see
      // COLD_OPEN_INSTRUCTIONS) — both shapes mark themselves done via
      // visitorMeta.revealDone once generated, since message *count* alone
      // can't tell the two shapes apart (each ends with a different count).
      // If the reveal already happened, or the visitor typed their own
      // message before the reveal had a chance to fire, just return whatever
      // the latest assistant turn already is instead of generating a new one.
      const visitorHasSpoken = existingMessages.some((m) => m.role === MessageRole.visitor);
      const alreadyRevealed = existingMessages.length >= 2 || Boolean((dialog.visitorMeta as Record<string, any> | null)?.revealDone);
      if (visitorHasSpoken || alreadyRevealed) {
        const lastAssistant = [...existingMessages].reverse().find((m) => m.role === MessageRole.assistant);
        if (lastAssistant) {
          return {
            reply: lastAssistant.content,
            buttons: (lastAssistant.buttons as string[] | null) ?? [],
            stage: dialog.currentStageId ?? 'greeting',
            dialogStatus: dialog.status,
            leadCaptured: false,
            botName: bot.name,
            messageId: lastAssistant.id,
          };
        }
      }
    } else if (!visitorText) {
      throw new BadRequestException('Either message or buttonPayload is required');
    }

    // A retry (see chat.js's `retry` flag + showSendFailure) resends the
    // exact same text rather than a bare "try again" — that's what makes it
    // safe regardless of WHERE the previous attempt actually failed. If that
    // request never even reached us (pure network failure between browser
    // and server), the dialog's last message is something older, and this
    // genuinely is the first arrival of this text — append normally, same
    // as any new message. If we DID receive and save it last time but the
    // REPLY generation itself failed afterwards, the dialog's last message
    // is already this exact visitor text with nothing after it — skip
    // appending a duplicate and just generate the missing reply for what's
    // already there. Content-matching means this needs no special handling
    // beyond the ordinary message path above; `dto.retry` itself is only a
    // hint for logs, not something branched on here.
    let skipAppend = false;
    if (!dto.isInit && !dto.isReveal) {
      const lastMessage = existingMessages[existingMessages.length - 1];
      skipAppend = Boolean(lastMessage && lastMessage.role === MessageRole.visitor && lastMessage.content === visitorText);
      if (!skipAppend) {
        await this.messages.append(dialog.id, MessageRole.visitor, visitorText!);
      }
    }

    const history = (dto.isInit || dto.isReveal || skipAppend) ? existingMessages : await this.messages.listByDialog(dialog.id);
    // Every turn resends this whole array as input tokens — uncapped, a long
    // conversation costs cumulatively more per turn, not just linearly more
    // overall. The "known facts" and "resolved knowledge" blocks injected
    // below already carry forward anything that matters from earlier in the
    // conversation, so trimming the raw transcript here is safe.
    const MAX_HISTORY_MESSAGES = 20;
    const chatHistory: ChatTurn[] = history.slice(-MAX_HISTORY_MESSAGES).map((m) => ({
      role: m.role === MessageRole.visitor ? 'user' : m.role === MessageRole.assistant ? 'assistant' : 'system',
      content: m.content,
    }));

    const stages = this.bots.getFunnelStages(bot);
    const stage =
      (dialog.currentStageId ? this.bots.findStage(bot, dialog.currentStageId) : undefined) ??
      this.bots.getInitialStage(bot);

    // Kept in sync in-memory with every setVisitorMeta call below, so later
    // reads in this same request (e.g. provisioning) never see stale data —
    // dialog.visitorMeta itself is only refreshed by re-fetching from the DB.
    let visitorMeta = (dialog.visitorMeta as Record<string, any>) ?? {};

    // Deterministic, code-verified consent — checked before the model even
    // runs, so a click this turn is already a known fact for this same
    // reply (no extra round-trip needed to actually hand over the link/lead).
    if (dto.buttonPayload === PD_CONSENT_BUTTON_LABEL && !visitorMeta.pdConsent) {
      visitorMeta = { ...visitorMeta, pdConsent: true };
      await this.dialogs.setVisitorMeta(dialog.id, visitorMeta);
    }

    // Used below (a) to nudge the model to back off gracefully instead of
    // re-asking in the very same breath, and (b) to skip the code-level
    // "ask again" replacement that would otherwise immediately contradict
    // that explicit decline — same reasoning as the explicit-refusal rule
    // above, just for this one specific button.
    const justDeclinedConsent = dto.buttonPayload === PD_DECLINE_BUTTON_LABEL;

    // A/B/C/D test: if this stage has variants, pin one per dialog (persisted on
    // first use) so the same dialog always sees the same variant, and later
    // conversion analysis can group dialogs by which one they got.
    //
    // Only substitutes on the dialog's very first-ever reply (existingMessages
    // empty) — a variant is a literal one-time opening LINE ("your first
    // reply must be exactly..."), not ongoing guidance. Without this guard,
    // once a dialog is stuck on a stage with variants past turn 1 (e.g. the
    // model never advances nextStage), every later turn re-sends that same
    // "your first reply must be exactly X" instruction instead of the stage's
    // real instructions — seen live: a model that follows instructions
    // literally (gpt-4o-mini) then has no signal telling it to ever leave
    // this stage, while one that reasons past a nonsensical literal
    // instruction (DeepSeek) happens to self-correct and move on anyway. The
    // stage's actual instructions (with its real exit condition) must be
    // what every turn past the first one sees.
    let stageInstructions = stage?.instructions ?? 'Greet the visitor and learn what they need.';
    if (stage?.variants && stage.variants.length > 0 && existingMessages.length === 0) {
      const experiments = visitorMeta.experiments ?? {};
      let variantIndex: number | undefined = experiments[stage.stageId];
      if (variantIndex === undefined || variantIndex >= stage.variants.length) {
        variantIndex = Math.floor(Math.random() * stage.variants.length);
        visitorMeta = { ...visitorMeta, experiments: { ...experiments, [stage.stageId]: variantIndex } };
        await this.dialogs.setVisitorMeta(dialog.id, visitorMeta);
      }
      stageInstructions = stage.variants[variantIndex];
    }
    if (dto.isReveal) {
      // Zero prior messages means the outside teaser never actually fired
      // (visitor opened the chat before its delay elapsed) — there's no hook
      // to react to, so this can't claim "you already saw my hook" the way
      // REVEAL_INSTRUCTIONS does.
      stageInstructions = existingMessages.length === 0 ? COLD_OPEN_INSTRUCTIONS : REVEAL_INSTRUCTIONS;
    } else if (!dto.isInit && existingMessages.length === 1 && existingMessages[0].role === MessageRole.assistant) {
      // The visitor's own real message arrived and won the race against the
      // auto-fired reveal turn, which got cancelled before it ever saved
      // anything (see chat.js's revealAbort and this file's SupersededTurnError)
      // — so as far as this dialog's history is concerned, only the hook
      // exists and the bot never actually introduced herself or asked
      // anything yet. Blend that missing self-intro into THIS reply instead
      // of silently skipping it: one merged, context-aware turn that both
      // greets properly AND responds to what they said, rather than two
      // disjointed ones (a stale reveal answering nothing, then a real reply
      // pretending the intro already happened).
      stageInstructions =
        REVEAL_INSTRUCTIONS +
        '\n\nВАЖНО: на этот раз собеседник уже успел кое-что написать сам, ДО того как ты обычно ' +
        'представляешься — вот это его сообщение, отвечай именно на него (а не только на крючок), и ' +
        'встрой представление по имени в этот же ответ естественно, а не как отдельную несвязанную ' +
        'вставку.';
    }

    // Injected live on every turn, for every bot (not baked into systemPrompt
    // at creation time like the equivalent persona-rules.ts rule) — so it
    // reaches bots that already existed before this rule was added, not just
    // newly-created ones. Seen live: the model characterized a business off
    // its site's name/domain alone, without ever having real page text —
    // reads as fabrication, not analysis.
    stageInstructions += WidgetService.UNIVERSAL_STAGE_GUIDANCE;

    // Company.name defaults to whatever the lead typed when asked what their
    // business does ("продажа бань" — see ProvisioningService.buildDefault-
    // SystemPrompt, which bakes that same raw description into the
    // systemPrompt as "Бизнес: продажа бань"), never an actual brand name —
    // nothing before this ever asked the owner for one. Left alone, the
    // model has no real name to give and paraphrases that description into
    // something like "компания по продаже бань" when introducing itself —
    // reads as a classified ad, not a real business. Injected live (same
    // reasoning as UNIVERSAL_STAGE_GUIDANCE above) so a company that sets a
    // real name via CabinetService.updateCompanyName sees it take effect on
    // the very next reply, no funnel regeneration or redeploy needed.
    stageInstructions +=
      `\n\nНазвание компании, от лица которой ты работаешь: «${bot.company.name}». Используй именно это ` +
      'название, когда представляешься или ссылаешься на компанию — никогда не описывай её оборотами вроде ' +
      '"компания по продаже X" или "бизнес, который занимается Y", даже если что-то похожее написано в ' +
      'твоей базовой инструкции.';

    if (justDeclinedConsent) {
      stageInstructions +=
        '\n\nСобеседник только что явно отказался от согласия на обработку данных ("Не сейчас") — не ' +
        'предлагай его снова в этой реплике и не пытайся дать ссылку. Тепло прими отказ, без давления и без ' +
        'уговоров, и просто продолжай разговор естественно — например, узнай, чем ещё можешь быть полезна, ' +
        'или ответь на то, что он говорил раньше.';
    }

    // The "closed" stage's own instructions are just a polite goodbye
    // script — nothing in them ever tells the model it's allowed to leave
    // that stage again. Seen live: a real visitor said no, then came back
    // (same session, next day even) with clear renewed interest and even a
    // literal "create my account" — and got the same canned goodbye every
    // single time, because the model had no instruction covering "the
    // conversation was closed, but THIS message changes that". Only
    // injected when actually on this stage — irrelevant noise everywhere
    // else.
    if (stage?.stageId === 'closed') {
      stageInstructions +=
        '\n\nЭтот разговор ранее был завершён как неактуальный — но это НЕ значит, что он обязан оставаться ' +
        'закрытым навсегда. Если последнее сообщение собеседника показывает новый интерес, содержит ' +
        'содержательный вопрос по делу, или прямо просит оформить/зарегистрировать/подключить бота — НЕ ' +
        'повторяй прощальную фразу. Ответь по существу, как будто разговор возобновился, и укажи подходящую ' +
        'следующую стадию (nextStage) вместо "closed" — например "onboarding_survey", если он явно готов ' +
        'попробовать, или более раннюю стадию, если он просто задаёт ещё вопросы. Оставайся на "closed" и ' +
        'просто вежливо попрощайся ТОЛЬКО если новое сообщение действительно не содержит ничего, кроме ' +
        'прощания или отсутствия интереса.';
    }

    // A bare "привет"/"добрый день" mid-conversation isn't a new dialog — it's
    // just a re-engagement nudge. Without this, the model has no signal that
    // it already introduced itself and already made its pitch, so it treats
    // the greeting exactly like a cold open: re-introducing itself and
    // re-running the last pitch (near-verbatim, see isRepeatOfPrevious below,
    // or just as pushy if the wording happens to differ enough to dodge that
    // check). Meant to only fire once the bot has actually said something
    // already — but checking only for a prior ASSISTANT message isn't
    // enough: the automatic teaser/cold-open greeting shown before the
    // visitor ever types anything already counts as one. Seen live on a
    // real prospect's very first-ever message: they opened the widget (bot
    // auto-greets), typed "Привет" as their first reply, and got "Рад Вас
    // СНОВА приветствовать. Продолжим?" — treated as a returning visitor
    // mid-conversation when nothing had actually happened yet, and
    // "продолжим?" reads as nonsense with nothing to continue. Requiring a
    // prior VISITOR message too is the actual "conversation already under
    // way" signal — an unprompted bot teaser alone isn't that.
    if (
      visitorText &&
      BARE_GREETING_PATTERN.test(visitorText.trim()) &&
      existingMessages.some((m) => m.role === MessageRole.assistant) &&
      existingMessages.some((m) => m.role === MessageRole.visitor)
    ) {
      stageInstructions +=
        `\n\nСобеседник просто поздоровался ("${visitorText.trim()}"), не сказав ничего по существу — но разговор ` +
        'уже идёт, ты уже представлялась и что-то уже предлагала раньше. В этой реплике ЗАПРЕЩЕНО представляться ' +
        'заново и ЗАПРЕЩЕНО повторять свою предыдущую реплику или предложение (даже другими словами). Ответь коротко ' +
        'и естественно на само приветствие, без нового предложения или питча, и мягко верни разговор туда, где вы ' +
        'остановились — например, спроси, продолжаем ли, или напомни, о чём шла речь.';
    }

    // Owner-configured goal (see cabinet's "Цель бота") — injected at runtime,
    // not baked into the generated funnel, so changing it later takes effect
    // immediately without regenerating anything. The full closing instruction
    // only fires at the terminal handoff stage (that's the "ask for it" turn);
    // every earlier stage gets a lighter reminder so the model steers pain
    // discovery/pitch toward the goal instead of only bolting it on at the end.
    if (bot.goalInstruction) {
      if (stage?.exitCondition === 'handoff') {
        stageInstructions += `\n\n${bot.goalInstruction}`;
      } else if (bot.goalLabel) {
        stageInstructions +=
          `\n\nГлобальная цель этого разговора: ${bot.goalLabel}. Держи её в уме на протяжении всего диалога — ` +
          'веди собеседника к ней естественно через текущий этап, не форсируя её раньше времени и не подменяя ' +
          'задачи текущего этапа.';
      }
    }

    // An explicit, standalone sentence — not folded into the gender line
    // below. That used to be the only place the name appeared ("Ты, ${bot.name},
    // — мужского пола..."), a mention easy to lose next to the shared
    // few-shot JSON example elsewhere in the prompt (OUTPUT_CONTRACT), which
    // used to show a concrete "Меня зовут Алина" greeting — a vivid literal
    // example beats one passing mention, so every bot regardless of its own
    // configured name would introduce itself as "Алина" in practice. Fixed
    // on both ends: that example no longer names anyone, and this is now its
    // own unambiguous instruction.
    stageInstructions += `\n\nТебя зовут ${bot.name}. Представляйся только этим именем, никаким другим.`;

    // Russian past-tense verbs and short adjectives are gendered ("сделал" vs
    // "сделала") — the model has no other way to know which form to use when
    // speaking about itself in the first person, so it's spelled out explicitly
    // on every turn rather than left to guess from the name alone.
    stageInstructions +=
      `\n\nТы, ${bot.name}, — ${bot.gender === 'male' ? 'мужского' : 'женского'} пола. Всегда используй ` +
      `правильный род, когда говоришь о себе в первом лице (например: «${bot.gender === 'male' ? 'сделал, готов, рад' : 'сделала, готова, рада'}»).`;

    // The visitor just handed over a website — actually check it instead of
    // letting the model guess the business type or chat situation from the
    // domain name alone (that's exactly how it invented "крупный строительный
    // гипермаркет" out of nowhere). Can happen in any stage — pain_discovery's
    // own instructions ask about an existing chat/bot before onboarding_survey
    // even starts, so a visitor may volunteer their site much earlier than
    // that stage. Only runs once per distinct URL per dialog.
    if (visitorText) {
      const urlMatch = visitorText.match(URL_IN_TEXT_PATTERN);
      const candidate = urlMatch?.[1];
      if (candidate && candidate !== visitorMeta.siteChecked) {
        const siteResult = await this.siteAnalysis.analyzeSite(candidate);
        // Record this as a known fact immediately (code-level, not dependent on
        // the model remembering to echo it into leadData) — once given, the
        // site must stay in context for the rest of the session, not just the
        // current stage, so later stages never ask for it again.
        const existingLead = (visitorMeta.leadData as Record<string, string>) ?? {};
        visitorMeta = {
          ...visitorMeta,
          siteChecked: candidate,
          leadData: { ...existingLead, website: candidate },
          siteFindings: { fetched: Boolean(siteResult.text), hasChatWidget: siteResult.hasChatWidget },
        };
        await this.dialogs.setVisitorMeta(dialog.id, visitorMeta);

        stageInstructions += siteResult.text
          ? `\n\nТы только что реально открыла сайт ${candidate}. Вот что там реально написано (обрезано): ` +
            `"${siteResult.text.slice(0, 600)}". Обнаружение чат-виджета на странице: ${siteResult.hasChatWidget ? 'да, найден чат-виджет на сайте' : 'явных признаков чат-виджета на сайте не найдено'}. ` +
            'Начни реплику с короткой фразы вроде "Секунду, смотрю ваш сайт" — а дальше сообщи только то, что ' +
            'реально нашла: про чат — строго по факту обнаружения выше (да/нет), ни в коем случае не выдумывая. ' +
            'Про сферу деятельности можешь упомянуть, ТОЛЬКО если это явно следует из текста сайта выше — никогда ' +
            'не угадывай и не придумывай отрасль, тип бизнеса или любые другие детали, которых в этом тексте нет.'
          : `\n\nВАЖНО: ты попыталась открыть сайт ${candidate}, но загрузить его технически не удалось (сайт не ` +
            'ответил). Это ОБЯЗАТЕЛЬНОЕ условие для этой реплики: буквально скажи, что не получилось открыть ' +
            'сайт (например: "Секунду... хм, не получилось открыть ваш сайт, покажете позже?"), и прямо спроси, ' +
            'есть ли у него уже чат на сайте. ЗАПРЕЩЕНО делать вид, что сайт открылся, и ЗАПРЕЩЕНО придумывать ' +
            'что-либо о бизнесе, товарах или чате на этом сайте — у тебя нет об этом никаких данных.';
      }
    }

    // Surface everything already known about this visitor as an explicit,
    // structured fact block — rather than trusting the model to scan the full
    // chat history and notice on its own that, say, the site was already given
    // and checked two stages ago. This is what actually stops later stages
    // (onboarding_survey) from re-asking something pain_discovery already
    // covered: the fact is in front of the model every single turn, not just
    // implicitly buried in transcript it may skim past.
    const knownLead = (visitorMeta.leadData as Record<string, string>) ?? {};
    const knownFactParts: string[] = [];
    if (knownLead.website) knownFactParts.push(`сайт: ${knownLead.website}`);
    // "website" itself has nowhere to put a negative answer — this is the
    // only record of "already asked, visitor said no site yet" (see
    // leadData.hasWebsite's own instruction in yandex-gpt.service.ts for
    // why it exists). Seen live: without it, a later stage's own generic
    // "do you have a site?" opener re-asked something already answered
    // several turns earlier in a completely different part of the funnel.
    if ((visitorMeta.leadData as Record<string, unknown> | undefined)?.hasWebsite === false) {
      knownFactParts.push('сайта нет (уже выяснено, не спрашивай снова)');
    }
    if (visitorMeta.siteFindings) {
      knownFactParts.push(
        visitorMeta.siteFindings.fetched
          ? `по сайту уже проверено: чат-виджет ${visitorMeta.siteFindings.hasChatWidget ? 'найден' : 'не найден'}`
          : 'сайт уже пытались открыть, не получилось',
      );
    }
    if (knownLead.businessDescription) knownFactParts.push(`бизнес/товар: ${knownLead.businessDescription}`);
    if (knownLead.name) knownFactParts.push(`имя: ${knownLead.name}`);
    if (knownLead.phone) knownFactParts.push(`телефон: ${knownLead.phone}`);
    if (knownLead.email) knownFactParts.push(`email: ${knownLead.email}`);
    if (knownLead.preferredChannel) knownFactParts.push(`предпочитаемый канал: ${knownLead.preferredChannel}`);
    if (knownLead.interest) knownFactParts.push(`интерес/что хочет: ${knownLead.interest}`);
    if (visitorMeta.pdConsent) knownFactParts.push('согласие на обработку персональных данных: уже получено');
    if (knownFactParts.length > 0) {
      stageInstructions +=
        `\n\nУже известно о собеседнике из более раннего сообщения в этом же разговоре (НЕ спрашивай это ` +
        `повторно, используй как данность): ${knownFactParts.join('; ')}.`;
    }

    // The actual "learning loop": verified Telegram answers, manual entries
    // and test-chat notes all land in the same per-bot knowledge base (see
    // KnowledgeService) and show up here on the very next message, no
    // redeploy needed.
    const knowledgeEntries = await this.knowledge.getForPrompt(bot.id, bot.companyId, visitorText ?? '');
    // Split out file-backed entries (a photo/contract, see fileUrl) from
    // plain text facts — a file entry's own description belongs together
    // with its exact attachmentUrl in ONE block (see below), not duplicated
    // into this text-facts block too. Two separate listings that only share
    // a filename/title as their link would force the model to cross-
    // reference them itself — real risk of matching the right DESCRIPTION
    // to the wrong PHOTO once there are several similar entries (e.g. the
    // same bathhouse model in different colors).
    const textOnlyEntries = knowledgeEntries.filter((k) => !k.fileUrl);
    if (textOnlyEntries.length > 0) {
      stageInstructions +=
        '\n\nБаза знаний (факты и проверенные ответы, которые ты точно знаешь о бизнесе):\n' +
        textOnlyEntries.map((k) => (k.question ? `- Вопрос: ${k.question}\n  Ответ: ${k.answer}` : `- ${k.answer}`)).join('\n');
    }
    // Lets the model actually attach a real file (contract, product photo,
    // spec sheet) instead of claiming it can't share files at all — see
    // StructuredReply.attachmentUrl and OUTPUT_CONTRACT's own instructions
    // for it. Only entries relevant to THIS message (same retrieval as
    // above) are ever offered, and only ones that actually have a file.
    // Title + description + url are kept together per file so the model can
    // naturally weave the description into its reply text (e.g. "эта баня
    // была установлена у клиента в Подмосковье") while attaching the exact
    // matching photo — never separately-listed facts it has to correlate.
    const knowledgeFiles = knowledgeEntries.filter((k) => k.fileUrl);
    if (knowledgeFiles.length > 0) {
      stageInstructions +=
        '\n\nФайлы из базы знаний (можешь отправить любой из них через attachmentUrl, если это ' +
        'уместно ответу — скопируй ссылку ТОЧНО как есть, не изменяя ни символа; используй описание, ' +
        'чтобы естественно рассказать про этот конкретный файл в самом ответе, а не только прислать его):\n' +
        knowledgeFiles
          .map((k) => `- ${k.question ?? k.fileName ?? 'файл'}: ${k.answer}\n  Ссылка (attachmentUrl): ${k.fileUrl}`)
          .join('\n');
    }

    // Unlike the facts above (retrieved only when relevant to THIS message),
    // instructions apply on every single turn regardless of what was just
    // said — see KnowledgeService.getInstructionsForPrompt for why this
    // can't just reuse getForPrompt's similarity-based retrieval.
    const instructions = await this.knowledge.getInstructionsForPrompt(bot.id);
    if (instructions.length > 0) {
      stageInstructions +=
        '\n\nИнструкции от владельца бизнеса (обязательно следуй им во всех репликах):\n' +
        instructions.map((i) => `- ${i}`).join('\n');
    }

    // A bare "да" or "я передумал" means something different depending on
    // what it's answering — matching corrections on the visitor's message
    // ALONE (ignoring what the bot had just said) let a correction recorded
    // for one specific exchange fire on every unrelated future exchange that
    // happened to share the same short reply. Combined with the bot's own
    // preceding turn instead, the same shape KnowledgeService.createCorrection
    // now stores the situation in (see dislikes.service.ts/chat.js).
    const lastAssistantMessage = [...existingMessages].reverse().find((m) => m.role === MessageRole.assistant);
    const correctionQueryText = lastAssistantMessage
      ? `${lastAssistantMessage.content}\n${visitorText ?? ''}`
      : visitorText ?? '';

    // Retrieved by similarity to the current situation, same as the facts
    // above — only surfaces when today's situation actually resembles one
    // the owner previously flagged as answered badly, see
    // KnowledgeService.getCorrectionsForPrompt.
    const corrections = await this.knowledge.getCorrectionsForPrompt(bot.id, bot.companyId, correctionQueryText);
    if (corrections.length > 0) {
      stageInstructions +=
        '\n\nВНИМАНИЕ: в похожей ситуации ты раньше уже ответил(а) неудачно — владелец бизнеса это отметил:\n' +
        corrections
          .map((c, i) => {
            const situation = c.question ? `Ситуация: ${c.question}\n  ` : '';
            const bad = c.badExample ? `Так отвечать НЕЛЬЗЯ: "${c.badExample}"\n  ` : '';
            return `${i + 1}. ${situation}${bad}Правильный ориентир: "${c.answer}"`;
          })
          .join('\n');
    }

    const structuredReply = await this.yandexGpt.generateReply({
      systemPrompt: bot.systemPrompt,
      stageInstructions,
      currentStageId: stage?.stageId ?? 'greeting',
      stages,
      history: chatHistory,
      signal,
    });

    // The visitor's own real message won the race and superseded this
    // automatic isInit/isReveal turn (see chat.js's revealAbort) — its own
    // completion call already threw before reaching here in that case (see
    // YandexGptService.generateReply's abort check), so this is a defensive
    // backstop for the rarer window where the abort lands between the
    // completion finishing and this line running. Either way, nothing below
    // should persist or return a reply nobody asked for anymore.
    if (signal?.aborted) {
      throw new SupersededTurnError();
    }

    // Each of the checks below used to build its retry nudge on top of the
    // frozen `stageInstructions` from before ANY of them ran — so if the
    // repeat-check fixed a repeated reply, and the reply THEN also tripped
    // the invitation-check, that second retry regenerated from scratch with
    // no memory of "don't repeat yourself", and could land right back on the
    // same repeated text it had just been fixed away from. Seen live: a
    // dialog got "Detected repeat reply, retrying" immediately followed by
    // "reply ends with an invitation... retrying" two seconds later, and the
    // text the visitor actually saw was the ORIGINAL repeat, unchanged.
    // `liveInstructions` accumulates every nudge that successfully fires
    // this turn, so each later check's retry inherits everything already
    // asked for, instead of resetting to a blank slate each time.
    let liveInstructions = stageInstructions;

    // Even the full model occasionally echoes its previous turn — either verbatim
    // or by tacking a new sentence onto the same text (seen in testing: the whole
    // previous reply reappeared as a prefix of the new one). Never show the
    // visitor an obvious repeat — retry once with an explicit nudge instead.
    // (lastAssistantMessage itself is computed earlier now, for the
    // corrections-retrieval query above — reused here as-is.)
    // Last TWO assistant turns, not just one — see the invitation check
    // below for why. Checking the repeat against BOTH matters here too, not
    // just for invitations: seen live (a troll-testing run) where two
    // near-identical stock deflections ("Это я оставлю за кадром...")
    // landed with ONE genuinely different reply sandwiched between them —
    // comparing only against the immediately preceding turn never flagged
    // it, since neither individual pair was adjacent.
    const recentAssistantMessages = [...existingMessages]
      .reverse()
      .filter((m) => m.role === MessageRole.assistant)
      .slice(0, 2);
    const repeatedRecentMessage = recentAssistantMessages.find((m) => this.isRepeatOfPrevious(structuredReply.reply, m.content));
    if (repeatedRecentMessage) {
      this.logger.warn(`Detected repeat reply in dialog ${dialog.id}, retrying with a nudge`);
      // The FIRST draft already succeeded (generateReply only throws after
      // exhausting its own internal retries) — if this improve-it nudge call
      // fails, the repetitive-but-real original reply is still far better
      // than turning a working turn into a hard failure, so a nudge failure
      // here is swallowed, not propagated.
      const repeatNudge =
        '\n\nВАЖНО: черновик твоего ответа случайно повторил (дословно или почти дословно) твою предыдущую ' +
        'реплику. Дай другой, содержательно новый ответ, учитывая последнее сообщение собеседника, ни в коем ' +
        'случае не повторяя и не переиспользуя предыдущий текст.';
      try {
        const retry = await this.yandexGpt.generateReply({
          systemPrompt: bot.systemPrompt,
          stageInstructions: liveInstructions + repeatNudge,
          currentStageId: stage?.stageId ?? 'greeting',
          stages,
          history: chatHistory,
        });
        structuredReply.reply = retry.reply;
        structuredReply.buttons = retry.buttons;
        structuredReply.nextStage = retry.nextStage;
        structuredReply.leadCaptured = retry.leadCaptured;
        structuredReply.leadData = retry.leadData;
        structuredReply.pdConsentGiven = retry.pdConsentGiven;
        structuredReply.deletionRequested = retry.deletionRequested;
        structuredReply.unansweredQuestion = retry.unansweredQuestion;
        structuredReply.dissatisfactionSignal = retry.dissatisfactionSignal;
        structuredReply.tokensUsed = (structuredReply.tokensUsed ?? 0) + (retry.tokensUsed ?? 0);
        structuredReply.tokensUsedPrompt = (structuredReply.tokensUsedPrompt ?? 0) + (retry.tokensUsedPrompt ?? 0);
        structuredReply.tokensUsedCompletion = (structuredReply.tokensUsedCompletion ?? 0) + (retry.tokensUsedCompletion ?? 0);
        liveInstructions += repeatNudge;
      } catch (error) {
        this.logger.warn(`Repeat-reply nudge failed in dialog ${dialog.id}, keeping the original (repetitive) reply: ${String(error)}`);
      }
    }

    // Persona-rules.ts asks the model to skip the invitation when it JUST
    // asked one — proven unreliable in practice: a real dialog kept ending
    // every single reply with some form of "Хотите...?" for 15+ consecutive
    // turns even with that instruction live (each one worded differently
    // enough that isRepeatOfPrevious above never caught it as a text
    // repeat). Enforced here the same way as the repeat/filler checks: don't
    // trust the model's own judgment on "did I just do this", check the
    // actual previous turn.
    //
    // Checked against the last TWO assistant turns, not just the immediately
    // preceding one — comparing only against the last turn just produces a
    // clean alternating pattern (invitation, none, invitation, none...),
    // since stripping turn N's invitation means turn N+1's own invitation no
    // longer looks like a back-to-back repeat. Seen live: still felt pushy
    // to a real reviewer even after that fix, because "every other reply"
    // is still frequent. Looking back two turns instead of one means an
    // invitation has to let at least two invitation-free replies go by
    // before another is allowed through.
    const recentHadInvitation = recentAssistantMessages.some((m) => this.endsWithInvitation(m.content));
    if (recentHadInvitation && this.endsWithInvitation(structuredReply.reply)) {
      this.logger.warn(`Dialog ${dialog.id}: reply ends with an invitation too soon after a recent one, retrying`);
      const invitationNudge =
        '\n\nВАЖНО: черновик твоего ответа заканчивается вопросом-приглашением ("Хотите...", "Давайте..." и ' +
        'т.п.), а одна из твоих последних реплик тоже заканчивалась похожим приглашением. Приглашения нужно ' +
        'разносить — не через реплику, а хотя бы через 2-3. В этой реплике дай содержательный ответ по ' +
        'существу вопроса собеседника и НЕ добавляй в конце новое приглашение или вопрос о следующем шаге — ' +
        'просто закончи мысль.';
      try {
        const retry = await this.yandexGpt.generateReply({
          systemPrompt: bot.systemPrompt,
          stageInstructions: liveInstructions + invitationNudge,
          currentStageId: stage?.stageId ?? 'greeting',
          stages,
          history: chatHistory,
        });
        structuredReply.reply = retry.reply;
        structuredReply.buttons = retry.buttons;
        structuredReply.nextStage = retry.nextStage;
        structuredReply.leadCaptured = retry.leadCaptured;
        structuredReply.leadData = retry.leadData;
        structuredReply.pdConsentGiven = retry.pdConsentGiven;
        structuredReply.deletionRequested = retry.deletionRequested;
        structuredReply.unansweredQuestion = retry.unansweredQuestion;
        structuredReply.dissatisfactionSignal = retry.dissatisfactionSignal;
        structuredReply.tokensUsed = (structuredReply.tokensUsed ?? 0) + (retry.tokensUsed ?? 0);
        structuredReply.tokensUsedPrompt = (structuredReply.tokensUsedPrompt ?? 0) + (retry.tokensUsedPrompt ?? 0);
        structuredReply.tokensUsedCompletion = (structuredReply.tokensUsedCompletion ?? 0) + (retry.tokensUsedCompletion ?? 0);
        liveInstructions += invitationNudge;
      } catch (error) {
        this.logger.warn(`Repeated-invitation nudge failed in dialog ${dialog.id}, keeping the original reply: ${String(error)}`);
      }

      // The nudge doesn't always take — seen live, the retry itself can
      // still end up with its own invitation (same underlying pull toward
      // "always end on a question" that caused the first draft). Rather
      // than gamble on a third generation, deterministically drop the
      // trailing sentence(s) this time: the substance of the answer stands
      // on its own, and losing the invitation is a far smaller cost than a
      // visitor seeing "Хотите...?" three turns running. Looped, not a
      // single strip — a reply like "Хотите X? Или Y?" has TWO consecutive
      // invitational sentences, and one pass would still leave the second
      // one at the very end.
      let strippedReply = structuredReply.reply;
      while (this.endsWithInvitation(strippedReply)) {
        const next = this.stripTrailingSentence(strippedReply);
        if (next === strippedReply) break; // single-sentence reply — nothing left to strip
        strippedReply = next;
      }
      structuredReply.reply = strippedReply;
    }

    // REVEAL_INSTRUCTIONS asks for a brief self-intro by name — proven
    // unreliable in practice (temperature 0.4, competing against several
    // other constraints in the same instruction): seen live landing anywhere
    // from "always includes it" to "skips it more often than not" across
    // otherwise identical calls. Same retry pattern as the checks above, but
    // a real deterministic fallback is needed here (not just stripping),
    // since there's nothing wrong to remove — the reply is just missing
    // something it should have. Only the true reveal turn needs this check —
    // the cold-open branch already self-contains its own intro by design
    // (see COLD_OPEN_INSTRUCTIONS).
    if (dto.isReveal && existingMessages.length > 0 && !structuredReply.reply.toLowerCase().includes(bot.name.toLowerCase())) {
      this.logger.warn(`Dialog ${dialog.id}: reveal reply is missing the self-introduction, retrying`);
      const introNudge =
        '\n\nВАЖНО: черновик твоего ответа не назвал тебя по имени вообще — это обязательный элемент этой ' +
        `реплики (см. выше). Дай тот же по смыслу ответ, но добавь короткое, естественное упоминание своего ` +
        `имени (${bot.name}) — не отдельным протокольным приветствием, а как деталь между делом.`;
      try {
        const retry = await this.yandexGpt.generateReply({
          systemPrompt: bot.systemPrompt,
          stageInstructions: liveInstructions + introNudge,
          currentStageId: stage?.stageId ?? 'greeting',
          stages,
          history: chatHistory,
        });
        structuredReply.reply = retry.reply;
        structuredReply.buttons = retry.buttons;
        structuredReply.nextStage = retry.nextStage;
        structuredReply.leadCaptured = retry.leadCaptured;
        structuredReply.leadData = retry.leadData;
        structuredReply.pdConsentGiven = retry.pdConsentGiven;
        structuredReply.deletionRequested = retry.deletionRequested;
        structuredReply.unansweredQuestion = retry.unansweredQuestion;
        structuredReply.dissatisfactionSignal = retry.dissatisfactionSignal;
        structuredReply.tokensUsed = (structuredReply.tokensUsed ?? 0) + (retry.tokensUsed ?? 0);
        structuredReply.tokensUsedPrompt = (structuredReply.tokensUsedPrompt ?? 0) + (retry.tokensUsedPrompt ?? 0);
        structuredReply.tokensUsedCompletion = (structuredReply.tokensUsedCompletion ?? 0) + (retry.tokensUsedCompletion ?? 0);
        liveInstructions += introNudge;
      } catch (error) {
        this.logger.warn(`Reveal self-intro nudge failed in dialog ${dialog.id}, keeping the original reply: ${String(error)}`);
      }

      // Still missing after the nudge — rather than gamble on a third
      // generation, deterministically prepend a short mention. Gender-neutral
      // phrasing ("я <имя>") works regardless of bot.gender, unlike a verb-
      // based sentence that would need agreement.
      if (!structuredReply.reply.toLowerCase().includes(bot.name.toLowerCase())) {
        this.logger.warn(`Dialog ${dialog.id}: reveal reply STILL missing the self-introduction after retry — prepending it deterministically`);
        structuredReply.reply = `Кстати, я ${bot.name}. ${structuredReply.reply}`;
      }
    }

    // "Теперь понятно?"/"Ясно?" after explaining something reads as
    // questioning the visitor's intelligence, not as helpfulness — seen live.
    // Unlike the invitation check above, this doesn't need "twice in a row"
    // to be a problem; a single occurrence is already condescending, so it
    // fires every time regardless of the previous turn.
    if (this.endsWithCondescendingCheck(structuredReply.reply)) {
      this.logger.warn(`Dialog ${dialog.id}: reply ends with a condescending comprehension check, retrying`);
      const condescendingNudge =
        '\n\nВАЖНО: черновик твоего ответа заканчивается вопросом вроде "Теперь понятно?" или "Ясно?" — это ' +
        'звучит так, будто ты сомневаешься в понятливости собеседника, а не помогаешь. Дай тот же ответ по ' +
        'смыслу, но БЕЗ проверки понимания в конце — просто закончи объяснение. Если хочешь узнать, остались ' +
        'ли вопросы, спроси иначе, не ставя под сомнение то, что он понял.';
      try {
        const retry = await this.yandexGpt.generateReply({
          systemPrompt: bot.systemPrompt,
          stageInstructions: liveInstructions + condescendingNudge,
          currentStageId: stage?.stageId ?? 'greeting',
          stages,
          history: chatHistory,
        });
        structuredReply.reply = retry.reply;
        structuredReply.buttons = retry.buttons;
        structuredReply.nextStage = retry.nextStage;
        structuredReply.leadCaptured = retry.leadCaptured;
        structuredReply.leadData = retry.leadData;
        structuredReply.pdConsentGiven = retry.pdConsentGiven;
        structuredReply.deletionRequested = retry.deletionRequested;
        structuredReply.unansweredQuestion = retry.unansweredQuestion;
        structuredReply.dissatisfactionSignal = retry.dissatisfactionSignal;
        structuredReply.tokensUsed = (structuredReply.tokensUsed ?? 0) + (retry.tokensUsed ?? 0);
        structuredReply.tokensUsedPrompt = (structuredReply.tokensUsedPrompt ?? 0) + (retry.tokensUsedPrompt ?? 0);
        structuredReply.tokensUsedCompletion = (structuredReply.tokensUsedCompletion ?? 0) + (retry.tokensUsedCompletion ?? 0);
        liveInstructions += condescendingNudge;
      } catch (error) {
        this.logger.warn(`Condescending-check nudge failed in dialog ${dialog.id}, keeping the original reply: ${String(error)}`);
      }

      if (this.endsWithCondescendingCheck(structuredReply.reply)) {
        structuredReply.reply = this.stripTrailingSentence(structuredReply.reply);
      }
    }

    // "Never use as reflexive filler" in persona-rules.ts is a judgment call
    // the model keeps getting wrong in practice (seen live, repeatedly) — so
    // this isn't left to the model's own compliance any more than the
    // consent-question or repeat-reply checks above are. Same retry pattern.
    const bannedFillerOpener = this.startsWithBannedFiller(structuredReply.reply);
    if (bannedFillerOpener) {
      this.logger.warn(`Dialog ${dialog.id}: reply opened with banned filler "${bannedFillerOpener}", retrying`);
      const fillerNudge =
        `\n\nВАЖНО: черновик твоего ответа начинался со слова "${bannedFillerOpener}" — это запрещённое ` +
        'пустое слово-заполнитель. Дай тот же по смыслу ответ, но без него — сразу по существу или с другим, ' +
        'по-настоящему содержательным началом.';
      try {
        const retry = await this.yandexGpt.generateReply({
          systemPrompt: bot.systemPrompt,
          stageInstructions: liveInstructions + fillerNudge,
          currentStageId: stage?.stageId ?? 'greeting',
          stages,
          history: chatHistory,
        });
        structuredReply.reply = retry.reply;
        structuredReply.buttons = retry.buttons;
        structuredReply.nextStage = retry.nextStage;
        structuredReply.leadCaptured = retry.leadCaptured;
        structuredReply.leadData = retry.leadData;
        structuredReply.pdConsentGiven = retry.pdConsentGiven;
        structuredReply.deletionRequested = retry.deletionRequested;
        structuredReply.unansweredQuestion = retry.unansweredQuestion;
        structuredReply.dissatisfactionSignal = retry.dissatisfactionSignal;
        structuredReply.tokensUsed = (structuredReply.tokensUsed ?? 0) + (retry.tokensUsed ?? 0);
        structuredReply.tokensUsedPrompt = (structuredReply.tokensUsedPrompt ?? 0) + (retry.tokensUsedPrompt ?? 0);
        structuredReply.tokensUsedCompletion = (structuredReply.tokensUsedCompletion ?? 0) + (retry.tokensUsedCompletion ?? 0);
        liveInstructions += fillerNudge;
      } catch (error) {
        this.logger.warn(`Banned-filler nudge failed in dialog ${dialog.id}, keeping the original reply: ${String(error)}`);
      }
    }

    // Seen live: the visitor just said "да"/"давайте" — a clear signal to
    // keep going — and the bot's whole reply was "Отлично!" and nothing
    // else. A genuine dead end: the visitor agreed to move forward and now
    // has no idea what to do next. This is the failure mode the "not every
    // reply needs a question" guidance above can create if followed too
    // literally right after an affirmative — that rule already carves this
    // case out in the prompt, but a real conversion-blocking dead end is
    // worth a deterministic backstop too, same as the other checks here.
    if (this.isDeadEndAfterAffirmative(visitorText, structuredReply.reply)) {
      this.logger.warn(`Dialog ${dialog.id}: reply is a dead end right after the visitor agreed to continue, retrying`);
      const deadEndNudge =
        `\n\nВАЖНО: собеседник только что согласился/подтвердил готовность продолжать ("${visitorText}"), а ` +
        `черновик твоего ответа — это только короткое подтверждение вроде "${structuredReply.reply}" без ` +
        'продолжения. Это тупик: собеседник не знает, что делать дальше. В этой реплике обязательно либо ' +
        'задай следующий содержательный вопрос по сценарию текущей стадии, либо сразу сделай реальный ' +
        'следующий шаг (например, дай ссылку на регистрацию, если по сценарию стадии пора).';
      try {
        const retry = await this.yandexGpt.generateReply({
          systemPrompt: bot.systemPrompt,
          stageInstructions: liveInstructions + deadEndNudge,
          currentStageId: stage?.stageId ?? 'greeting',
          stages,
          history: chatHistory,
        });
        structuredReply.reply = retry.reply;
        structuredReply.buttons = retry.buttons;
        structuredReply.nextStage = retry.nextStage;
        structuredReply.leadCaptured = retry.leadCaptured;
        structuredReply.leadData = retry.leadData;
        structuredReply.pdConsentGiven = retry.pdConsentGiven;
        structuredReply.deletionRequested = retry.deletionRequested;
        structuredReply.unansweredQuestion = retry.unansweredQuestion;
        structuredReply.dissatisfactionSignal = retry.dissatisfactionSignal;
        structuredReply.tokensUsed = (structuredReply.tokensUsed ?? 0) + (retry.tokensUsed ?? 0);
        structuredReply.tokensUsedPrompt = (structuredReply.tokensUsedPrompt ?? 0) + (retry.tokensUsedPrompt ?? 0);
        structuredReply.tokensUsedCompletion = (structuredReply.tokensUsedCompletion ?? 0) + (retry.tokensUsedCompletion ?? 0);
        liveInstructions += deadEndNudge;
      } catch (error) {
        this.logger.warn(`Dead-end-after-affirmative nudge failed in dialog ${dialog.id}, keeping the original reply: ${String(error)}`);
      }
    }

    if (this.hasWrongGenderSelfReference(structuredReply.reply, bot.gender)) {
      this.logger.warn(`Dialog ${dialog.id}: reply used the wrong grammatical gender for a ${bot.gender} bot, retrying`);
      const genderNudge =
        `\n\nВАЖНО: черновик твоего ответа ("${structuredReply.reply}") использует неправильный грамматический ` +
        `род — ты, ${bot.name}, ${bot.gender === 'male' ? 'мужского' : 'женского'} пола, а в черновике род ` +
        `перепутан (например: "${bot.gender === 'male' ? 'рада, готова, уверена' : 'рад, готов, уверен'}" — так ` +
        'нельзя). Дай тот же по смыслу ответ, но с исправленным родом во всех словах, где он относится к тебе ' +
        'самой/самому.';
      try {
        const retry = await this.yandexGpt.generateReply({
          systemPrompt: bot.systemPrompt,
          stageInstructions: liveInstructions + genderNudge,
          currentStageId: stage?.stageId ?? 'greeting',
          stages,
          history: chatHistory,
        });
        structuredReply.reply = retry.reply;
        structuredReply.buttons = retry.buttons;
        structuredReply.nextStage = retry.nextStage;
        structuredReply.leadCaptured = retry.leadCaptured;
        structuredReply.leadData = retry.leadData;
        structuredReply.pdConsentGiven = retry.pdConsentGiven;
        structuredReply.deletionRequested = retry.deletionRequested;
        structuredReply.unansweredQuestion = retry.unansweredQuestion;
        structuredReply.dissatisfactionSignal = retry.dissatisfactionSignal;
        structuredReply.tokensUsed = (structuredReply.tokensUsed ?? 0) + (retry.tokensUsed ?? 0);
        structuredReply.tokensUsedPrompt = (structuredReply.tokensUsedPrompt ?? 0) + (retry.tokensUsedPrompt ?? 0);
        structuredReply.tokensUsedCompletion = (structuredReply.tokensUsedCompletion ?? 0) + (retry.tokensUsedCompletion ?? 0);
        liveInstructions += genderNudge;
      } catch (error) {
        this.logger.warn(`Gender-agreement nudge failed in dialog ${dialog.id}, keeping the original reply: ${String(error)}`);
      }
    }

    // The model occasionally treats a clarifying question ("что это значит?")
    // as if it were the consent itself — high-stakes to get wrong (152-FZ), so
    // free-text "consent" is never trusted on the model's word alone. A
    // question can never legitimately BE consent, regardless of what the
    // model claims; the deterministic button click above is the only fully
    // trusted path. Retry so the visible reply also stops thanking the
    // visitor for consent they never gave, not just the internal flag.
    const visitorAskedRatherThanConsented = /\?\s*$/.test((visitorText ?? '').trim());
    if (structuredReply.pdConsentGiven && !visitorMeta.pdConsent && visitorAskedRatherThanConsented) {
      this.logger.warn(
        `Dialog ${dialog.id}: model claimed pdConsentGiven on what reads as a question ("${visitorText}") — retrying`,
      );
      const consentNudge =
        '\n\nВАЖНО: собеседник НЕ давал согласия на обработку данных — его последнее сообщение является ' +
        `вопросом ("${visitorText}"), а не согласием. Не благодари за согласие, оно не получено. Ответь на ` +
        'вопрос по существу, и ставь pdConsentGiven=true только когда получишь явное согласие в одном из ' +
        'следующих ответов.';
      try {
        const retry = await this.yandexGpt.generateReply({
          systemPrompt: bot.systemPrompt,
          stageInstructions: liveInstructions + consentNudge,
          currentStageId: stage?.stageId ?? 'greeting',
          stages,
          history: chatHistory,
        });
        structuredReply.reply = retry.reply;
        structuredReply.buttons = retry.buttons;
        structuredReply.nextStage = retry.nextStage;
        structuredReply.leadCaptured = retry.leadCaptured;
        structuredReply.leadData = retry.leadData;
        structuredReply.deletionRequested = retry.deletionRequested;
        structuredReply.unansweredQuestion = retry.unansweredQuestion;
        structuredReply.dissatisfactionSignal = retry.dissatisfactionSignal;
        structuredReply.tokensUsed = (structuredReply.tokensUsed ?? 0) + (retry.tokensUsed ?? 0);
        structuredReply.tokensUsedPrompt = (structuredReply.tokensUsedPrompt ?? 0) + (retry.tokensUsedPrompt ?? 0);
        structuredReply.tokensUsedCompletion = (structuredReply.tokensUsedCompletion ?? 0) + (retry.tokensUsedCompletion ?? 0);
        liveInstructions += consentNudge;
      } catch (error) {
        this.logger.warn(`Consent-question nudge failed in dialog ${dialog.id}, keeping the original reply: ${String(error)}`);
      } finally {
        // Never trust the model's claim here regardless of whether the nudge
        // retry itself succeeded — the visitor's last message reads as a
        // question, not consent, full stop (152-FZ, see comment above).
        structuredReply.pdConsentGiven = false;
      }
    }

    // Code-level gate, not the model's word alone — same reasoning as
    // siteChecked/leadData above. Once given, consent is a fact for the rest
    // of the dialog (surfaced in the known-facts block below so later stages
    // never ask again); leads.upsertAndCheckNew at the bottom of this method refuses to
    // persist any PII unless this is true, regardless of leadCaptured.
    if (structuredReply.pdConsentGiven && !visitorMeta.pdConsent) {
      visitorMeta = { ...visitorMeta, pdConsent: true };
      await this.dialogs.setVisitorMeta(dialog.id, visitorMeta);
    }

    // Safety net for the accumulating-nudges fix above: even with every retry
    // inheriting all prior nudges, a stubborn model can still land back on a
    // repeat after all of them. Seen live: the repeat-check fired, its retry
    // ran, and the retry STILL shared the exact same closing sentence as the
    // previous turn ("...Расскажите, чтобы я поняла, где вам действительно
    // пригожусь.", glued onto two different opening questions in a row) — a
    // soft "don't repeat yourself" instruction lost against whatever made the
    // model treat that sentence as the default way to close this kind of
    // question. Every OTHER check in this file that can end up in this
    // situation (invitation, condescending) already has a deterministic
    // strip as its own fallback — this one only had a log. Give it the same
    // treatment: never ship the visible duplicate just because the model
    // wouldn't cooperate. Loop, not a single strip, and never down to zero
    // sentences — same reasoning as the invitation-check's own loop.
    // Checked against the last TWO assistant turns, same reasoning as the
    // retry-trigger check above — a repeat that skips one turn (a genuinely
    // different reply sandwiched in between two near-identical ones) is
    // just as visible to the visitor as a back-to-back one.
    const stillRepeatedMessage = recentAssistantMessages.find((m) => this.isRepeatOfPrevious(structuredReply.reply, m.content));
    if (stillRepeatedMessage) {
      this.logger.warn(
        `Dialog ${dialog.id}: reply is still a repeat after retry nudges — stripping the shared trailing ` +
          'sentence(s) as a deterministic fallback instead of shipping the duplicate.',
      );
      let dedupedReply = structuredReply.reply;
      // The duplicate isn't always at the END — seen live in the very same
      // session this fallback was built for: the model repeated its ENTIRE
      // previous question verbatim as a PREFIX, then tacked genuinely new
      // content on afterward ("Вы пользуетесь только Авито...каналы?" +
      // "Рада слышать... Хотите узнать...?"). Stripping trailing sentences
      // can't touch a leading duplicate — check for that shape first and cut
      // the front instead when it applies.
      const previousTrimmed = stillRepeatedMessage.content.trim();
      const currentTrimmed = dedupedReply.trim();
      if (previousTrimmed.length > 20 && currentTrimmed.toLowerCase().startsWith(previousTrimmed.toLowerCase())) {
        const afterPrefix = currentTrimmed.slice(previousTrimmed.length).trim();
        if (afterPrefix) dedupedReply = afterPrefix;
      }
      // Narrower, more common version of the same shape: only the FIRST
      // SENTENCE is shared verbatim (a stock deflection like "Это я оставлю
      // за кадром, а вот с задачей помогу." glued in front of otherwise-new
      // content each time), not the whole previous message — the check
      // above never matches this, since the two full messages differ.
      // Seen live: this landed the trailing-strip loop below in a dead end
      // — it only strips from the END, and the duplicate here sits at the
      // very front, so the loop just deleted the new content and left the
      // stock opener standing, still flagged, all the way down to one
      // sentence. Mirrors isRepeatOfPrevious's own firstSentence check.
      const firstSentenceOf = (text: string) => text.match(/^[^.!?]*[.!?]+/)?.[0]?.trim() ?? '';
      const dedupedFirstSentence = firstSentenceOf(dedupedReply);
      const referenceFirstSentence = firstSentenceOf(previousTrimmed);
      if (
        dedupedFirstSentence.length >= 10 &&
        dedupedFirstSentence.toLowerCase() === referenceFirstSentence.toLowerCase()
      ) {
        const afterFirstSentence = dedupedReply.trim().slice(dedupedFirstSentence.length).trim();
        if (afterFirstSentence) dedupedReply = afterFirstSentence;
      }
      while (this.isRepeatOfPrevious(dedupedReply, stillRepeatedMessage.content)) {
        const next = this.stripTrailingSentence(dedupedReply);
        if (next === dedupedReply) break; // single-sentence reply — nothing left to strip
        dedupedReply = next;
      }
      if (this.isRepeatOfPrevious(dedupedReply, stillRepeatedMessage.content)) {
        // Stripped all the way down to one sentence and it's STILL flagged —
        // the whole reply is the repeat, not just a tacked-on tail. Nothing
        // left to safely remove without leaving the visitor with no reply at
        // all; ship the original untouched and log it as a hard failure for
        // follow-up rather than pretend the strip fixed it.
        this.logger.error(
          `Dialog ${dialog.id}: reply is still an exact repeat even stripped to one sentence — shipping the ` +
            'original as-is (better than an empty reply), but this needs investigating.',
        );
      } else {
        structuredReply.reply = dedupedReply;
      }
    }

    // The prompt asks the model to avoid "Однако" (see UNIVERSAL_STAGE_GUIDANCE)
    // but doesn't follow it reliably — seen live, still slips through some of
    // the time. A straight swap for "Но" is safe in every position this word
    // actually appears in (sentence-initial "however" or mid-sentence "but"),
    // so a deterministic replace is worth it here unlike judgment-heavy checks.
    structuredReply.reply = structuredReply.reply.replace(/Однако/g, 'Но').replace(/однако/g, 'но');

    // Right to erasure (152-FZ) — a real action, not just an acknowledgement:
    // redact whatever Lead row exists for this dialog immediately, and stop
    // the funnel rather than continuing to collect more data right after
    // being asked to delete what's already there.
    if (structuredReply.deletionRequested) {
      await this.leads.redact(dialog.id);
      await this.messages.append(dialog.id, MessageRole.assistant, structuredReply.reply, structuredReply.buttons);
      await this.dialogs.updateProgress(dialog.id, stage?.stageId ?? 'greeting', DialogStatus.closed);
      return {
        reply: structuredReply.reply,
        buttons: [],
        stage: stage?.stageId ?? 'greeting',
        dialogStatus: DialogStatus.closed,
        leadCaptured: false,
        botName: bot.name,
      };
    }

    // Accumulate any lead fields the model has revealed so far. In a long
    // conversation the model can easily forget to re-summarize business info
    // it already extracted several turns ago — provisioning must not silently
    // fail just because the handoff turn's leadData came back thin. Moved
    // ahead of the escalation block below (was after it) so an
    // 'unanswered' escalation can carry contact info already known this
    // very turn, instead of only ever picking it up on a later one.
    if (structuredReply.leadData) {
      const incoming = structuredReply.leadData as Record<string, unknown>;
      // Booleans (e.g. leadData.hasWebsite — see its own comment above) used
      // to get silently dropped here: this only ever checked/merged string
      // values, so a model turn that came back with ONLY `{ hasWebsite:
      // false }` and no string fields looked like it had "no value" at all
      // and never got persisted — the exact fact this field exists to
      // remember would vanish the instant it was set.
      const hasAnyValue = Object.values(incoming).some((v) => (typeof v === 'string' && v.trim()) || typeof v === 'boolean');
      if (hasAnyValue) {
        const mergedLead: Record<string, unknown> = { ...(visitorMeta.leadData ?? {}) };
        for (const [key, value] of Object.entries(incoming)) {
          if (typeof value === 'string' && value.trim()) mergedLead[key] = value.trim();
          else if (typeof value === 'boolean') mergedLead[key] = value;
        }
        visitorMeta = { ...visitorMeta, leadData: mergedLead };
        await this.dialogs.setVisitorMeta(dialog.id, visitorMeta);
      }
    }
    const effectiveLeadData: Record<string, string> = {
      ...(visitorMeta.leadData ?? {}),
      ...(structuredReply.leadData ?? {}),
    };

    const hasRealLeadData = Boolean(effectiveLeadData.name || effectiveLeadData.phone || effectiveLeadData.email);

    // Push straight to the team's Telegram — never left sitting in a
    // dashboard nobody opens. Fire-and-forget from the visitor's point of
    // view: escalating must never fail or slow down their reply.
    // Never for the owner's own preview/test session, though — that's the
    // owner deliberately trying to break the bot, not a real customer stuck.
    // Corrections there go through coachBot instead, which they trigger on
    // purpose.
    if (structuredReply.unansweredQuestion && !dto.isPreview) {
      // Only ever hand over contact once consent is code-verified — same
      // gate as leads.upsertAndCheckNew below, not just the model's say-so.
      const escalationConsentGiven = visitorMeta.pdConsent === true;
      this.telegram
        .escalate({
          botId: bot.id,
          companyId: bot.companyId,
          botName: bot.name,
          dialogId: dialog.id,
          reason: 'unanswered',
          question: structuredReply.unansweredQuestion,
          contactPhone: escalationConsentGiven ? effectiveLeadData.phone : undefined,
          contactEmail: escalationConsentGiven ? effectiveLeadData.email : undefined,
        })
        .catch((error) => this.logger.error(`escalate(unanswered) failed: ${String(error)}`));
    }
    // Independent of whether THIS turn also raised a brand new unanswered
    // question — a visitor very often only leaves contact a turn or two
    // AFTER the question that actually needed it. Cheap no-op once nothing
    // is left pending (escalate() above already marks a fresh escalation as
    // contacted if it had contact from the start, so this never double-sends).
    if (!dto.isPreview && visitorMeta.pdConsent === true && (effectiveLeadData.phone || effectiveLeadData.email)) {
      this.telegram
        .attachContactToEscalation(dialog.id, { phone: effectiveLeadData.phone, email: effectiveLeadData.email })
        .catch((error) => this.logger.error(`attachContactToEscalation failed: ${String(error)}`));
    }
    if (structuredReply.dissatisfactionSignal && !dto.isPreview) {
      // dissatisfactionSignal is the model's own one-sentence summary of what
      // went wrong ("что не устроило"), NOT the visitor's actual question —
      // without this, whoever answers in Telegram sees only that summary plus
      // the bot's reply, with no way to tell what was actually asked. Walk
      // existingMessages backward from lastAssistantMessage to the nearest
      // preceding visitor message — the one that reply was actually answering.
      const lastAssistantIndex = lastAssistantMessage ? existingMessages.indexOf(lastAssistantMessage) : -1;
      const precedingVisitorMessage =
        lastAssistantIndex > 0
          ? [...existingMessages.slice(0, lastAssistantIndex)].reverse().find((m) => m.role === MessageRole.visitor)
          : undefined;

      this.telegram
        .escalate({
          botId: bot.id,
          companyId: bot.companyId,
          botName: bot.name,
          dialogId: dialog.id,
          reason: 'dissatisfaction',
          question: structuredReply.dissatisfactionSignal,
          botReply: lastAssistantMessage?.content,
          visitorQuestion: precedingVisitorMessage?.content,
        })
        .catch((error) => this.logger.error(`escalate(dissatisfaction) failed: ${String(error)}`));
    }

    // yandexGpt.generateReply already validates nextStage against known stage ids,
    // falling back to the current stage id if the model invents an unknown one.
    // The isInit turn only delivers the outside teaser hook — it must never
    // silently skip ahead in the funnel on its own, regardless of what the
    // model suggests, since the visitor hasn't actually engaged yet. The
    // "reveal" turn (right after they open the chat) is what's allowed to move
    // the funnel forward.
    const nextStageId = dto.isInit
      ? stage?.stageId ?? 'greeting'
      : structuredReply.nextStage ?? stage?.stageId ?? 'greeting';
    const nextStage = this.bots.findStage(bot, nextStageId) ?? stage;
    const status = nextStage?.exitCondition ? EXIT_CONDITION_TO_STATUS[nextStage.exitCondition] ?? DialogStatus.active : DialogStatus.active;

    // Bots flagged enablesProvisioning (i.e. Алина) auto-create a client company +
    // default bot the moment the model reaches the closing message (signalled
    // by the literal placeholder — never trust the LLM to fabricate a URL
    // itself). Always straight to the cabinet registration link — there used to
    // be a fork here ("try it now" vs "go to the cabinet"), but testing showed
    // it was just an extra step that could strand the visitor on a bare token
    // if anything went wrong resolving it; the cabinet's own "Обучение бота"
    // panes already give a better first-look than a throwaway test link would.
    //
    // PII consent for THIS path lives on the registration form itself (a real
    // checkbox, enforced server-side in CabinetService.register) — giving out
    // a link isn't "using" personal data, so no in-chat gate applies here
    // anymore. The generic handoff branch below (client bots collecting a
    // phone/email for a human, no registration form involved) is the one
    // that still needs code-verified consent in chat.
    const hasPlaceholder = structuredReply.reply.includes(REGISTRATION_LINK_PLACEHOLDER);
    const consentGiven = visitorMeta.pdConsent === true;

    if (bot.enablesProvisioning && hasPlaceholder) {
      const provisioned = await this.provisioning.getOrProvision(
        { id: dialog.id, visitorMeta },
        effectiveLeadData,
        visitorIp,
      );
      structuredReply.reply = structuredReply.reply.replace(
        REGISTRATION_LINK_PLACEHOLDER,
        this.provisionResultToText(provisioned),
      );
    } else if (bot.enablesProvisioning && status === DialogStatus.handoff) {
      // Safety net: the model reached a handoff exit condition but forgot the
      // literal placeholder (happens occasionally despite instructions) — make
      // sure the visitor still gets a real link instead of an empty promise.
      const provisioned = await this.provisioning.getOrProvision(
        { id: dialog.id, visitorMeta },
        effectiveLeadData,
        visitorIp,
      );
      structuredReply.reply += `\n\n${this.provisionResultToText(provisioned)}`;
    } else if (!bot.enablesProvisioning && status === DialogStatus.handoff && !consentGiven && !justDeclinedConsent) {
      // Generic lead-capture handoff — every OTHER client bot's handoff stage
      // collects a phone/email for the business owner, with no registration
      // form to defer consent to, so this one still gates in chat. The model
      // sometimes reaches this exit condition with reply text that already
      // claims contact info was captured (often the exact "готово, свяжемся!"
      // wording) without code-verified consent — never let that false
      // confirmation reach the visitor, and leads.upsertAndCheckNew below already
      // refuses to persist without this same check, so nothing would actually
      // be saved regardless of what the reply says.
      this.logger.warn(`Dialog ${dialog.id}: reached handoff without code-verified consent, requesting consent instead`);
      structuredReply.reply = PD_CONSENT_REQUEST_TEXT;
      structuredReply.buttons = [PD_CONSENT_BUTTON_LABEL, PD_DECLINE_BUTTON_LABEL];
    }
    // justDeclinedConsent + handoff-without-consent (no branch above): the
    // model's own nudged reply is left as-is — nothing to override, the
    // point was to get out of its way, not force different text.

    // Only ever trust an attachmentUrl that's an EXACT match to a file this
    // very turn's own retrieval actually offered (see the "Файлы из базы
    // знаний" block built above) — never send the visitor a broken/invented
    // link just because the model returned something url-shaped.
    const validatedAttachment = structuredReply.attachmentUrl
      ? knowledgeFiles.find((k) => k.fileUrl === structuredReply.attachmentUrl)
      : undefined;
    if (structuredReply.attachmentUrl && !validatedAttachment) {
      this.logger.warn(
        `Dialog ${dialog.id}: model returned attachmentUrl not in the offered file list — discarding: ${structuredReply.attachmentUrl}`,
      );
    }
    const attachmentToSave = validatedAttachment
      ? { url: validatedAttachment.fileUrl!, name: validatedAttachment.fileName, mimeType: validatedAttachment.fileMimeType }
      : undefined;

    const savedAssistantMessage = await this.messages.append(
      dialog.id,
      MessageRole.assistant,
      structuredReply.reply,
      structuredReply.buttons,
      attachmentToSave,
    );

    if (dto.isReveal) {
      // Marks this dialog as revealed regardless of which shape produced it
      // (hook-then-reveal, or cold-open) — see the isReveal idempotency check
      // above, which can't tell the two shapes apart by message count alone.
      visitorMeta = { ...visitorMeta, revealDone: true };
      await this.dialogs.setVisitorMeta(dialog.id, visitorMeta);
    }

    await this.dialogs.updateProgress(dialog.id, nextStageId, status);

    // Never persist a name/phone/email without code-verified consent (raised
    // above from structuredReply.pdConsentGiven, or already true from an
    // earlier turn) — leadCaptured alone is the model's opinion, not a legal
    // basis to store PII (152-FZ, and rule 17 of the sales-onboarding spec:
    // "не сохранять данные без необходимого согласия"). Preview dialogs DO
    // still go through this (long-standing, pre-dates this branch — main
    // never gated leads.upsert on isPreview either) so the owner sees their
    // own test lead in "Заявки" while testing in "Обучение бота".
    if (structuredReply.leadCaptured && hasRealLeadData && visitorMeta.pdConsent === true) {
      // isNew comes back from the SAME atomic upsert (see leads.service.ts's
      // own comment) so a 'lead'-plan company is charged exactly once per
      // real lead — not again on every later turn that just fills in more
      // fields on the same Lead row, and not twice for one lead if two turns
      // land close together.
      const savedLead = await this.leads.upsertAndCheckNew(dialog.id, effectiveLeadData);
      // Real billing only for a real visitor — !dto.isPreview, same as the
      // escalation blocks above. chargeConfirmedLead is new on this branch;
      // without this gate, testing the bot in "Обучение бота" would actually
      // debit real RUB from a 'lead'-plan company's balance for a fake test
      // lead (found by code review, never observed live).
      if (savedLead.isNew && !dto.isPreview) {
        this.billing.chargeConfirmedLead(bot.id, billingBot).catch((error) => {
          this.logger.error(`Confirmed-lead charge failed for bot ${bot.id}: ${String(error)}`);
        });
      }
      // Fire-and-forget, same reasoning as the domain-integrity check above —
      // a slow or misconfigured CRM must never delay the visitor's own reply.
      // The lead already exists in this bot's own "Заявки" list regardless of
      // whether either push below succeeds right now — and even if it
      // doesn't, CrmIntegrationService's own background sweep keeps retrying
      // it (Lead.bitrix24SyncedAt/amocrmSyncedAt stay null until a push
      // actually lands), so a CRM outage at this exact moment delays
      // delivery rather than losing the lead.
      this.crmIntegration.pushLead(savedLead.id, bot, effectiveLeadData).catch((error) => {
        this.logger.error(`CRM lead push failed for bot ${bot.id}: ${String(error)}`);
      });
      // Mirrors this same lead into the mini-CRM board — independent of the
      // push above, which only reaches a THIRD-party CRM. See
      // CrmIntegrationService.ensureDealForLead for why this never itself
      // pushes to Bitrix24/amoCRM (that's stage-mapping-driven, not automatic
      // on creation).
      this.crmIntegration.ensureDealForLead(savedLead.id, bot.id, bot.companyId, dialog.id, effectiveLeadData).catch((error) => {
        this.logger.error(`CRM board deal creation failed for bot ${bot.id}: ${String(error)}`);
      });
      // Owner-facing notification (Telegram/email), independent of both CRM
      // pushes above — each channel checks its own opt-in and silently
      // no-ops if unset, same fire-and-forget reasoning.
      const leadSummary = [
        effectiveLeadData.name && `Имя: ${effectiveLeadData.name}`,
        effectiveLeadData.phone && `Телефон: ${effectiveLeadData.phone}`,
        effectiveLeadData.email && `Email: ${effectiveLeadData.email}`,
        effectiveLeadData.interest && `Интерес: ${effectiveLeadData.interest}`,
      ].filter(Boolean).join('\n');
      this.telegram.notifyNewLead(bot.companyId, leadSummary).catch((error) => {
        this.logger.error(`Telegram lead notification failed for company ${bot.companyId}: ${String(error)}`);
      });
      this.cabinet.getNotificationEmailConfig(bot.companyId).then((result) => {
        if (result) this.email.sendLeadNotificationEmail(result.email, result.companyName, leadSummary);
      }).catch((error) => {
        this.logger.error(`Email lead notification lookup failed for company ${bot.companyId}: ${String(error)}`);
      });
    }

    // Every turn, not just a lead-capturing one — a no-op for an 'unlimited'-
    // plan or no-plan-yet bot (see BillingService.chargeTokenUsage), real
    // debit for a 'token'-plan one. Fire-and-forget like the notifications
    // above: never worth delaying or failing the visitor's actual reply over
    // a billing-ledger write.
    this.billing
      .chargeTokenUsage(bot.id, structuredReply.tokensUsedPrompt ?? 0, structuredReply.tokensUsedCompletion ?? 0, billingBot)
      .catch((error) => {
        this.logger.error(`Token usage charge failed for bot ${bot.id}: ${String(error)}`);
      });

    return {
      reply: structuredReply.reply,
      buttons: structuredReply.buttons,
      stage: nextStageId,
      dialogStatus: status,
      leadCaptured: structuredReply.leadCaptured,
      botName: bot.name,
      // The stored Message row's own id — one per TURN, not per visual
      // "bubble" (splitIntoBubbles is a client-side-only display split, see
      // chat.js). Lets the public 👎 on test-chat.html flag the actual DB
      // row (see WidgetService.dislikeMessage) rather than something that
      // only exists in the rendered page.
      messageId: savedAssistantMessage.id,
      attachmentUrl: attachmentToSave?.url,
      attachmentName: attachmentToSave?.name,
      attachmentMimeType: attachmentToSave?.mimeType,
    };
  }

  async getHistory(botToken: string, sessionId: string) {
    const bot = await this.bots.findActiveByWidgetToken(botToken);
    if (!bot) throw new NotFoundException('Unknown or inactive bot token');

    const dialog = await this.dialogs.findBySession(bot.id, sessionId);
    if (!dialog) {
      return { messages: [], stage: null, dialogStatus: null, botName: bot.name };
    }

    const messages = await this.messages.listByDialog(dialog.id);
    return {
      messages: messages
        .filter((m) => m.role !== MessageRole.system)
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          buttons: m.buttons ?? [],
          attachmentUrl: m.attachmentUrl,
          attachmentName: m.attachmentName,
          attachmentMimeType: m.attachmentMimeType,
          createdAt: m.createdAt,
        })),
      stage: dialog.currentStageId,
      dialogStatus: dialog.status,
      botName: bot.name,
    };
  }

  /**
   * Backs chat.js's lightweight poll (a plain setInterval, no WebSocket/SSE
   * infra exists here) — the ONLY way a message written OUTSIDE the normal
   * request/response turn (a team member's confirmed Telegram/dislike-resolve
   * answer — see TelegramService.handleReplyAnswer, DislikesService.resolve)
   * ever reaches a visitor's already-open tab. `after` is the ISO timestamp
   * of the last message that tab already rendered (from ANY source — see
   * chat.js's renderMessage), so this only ever returns genuinely new rows.
   */
  async getNewMessages(botToken: string, sessionId: string, after: string) {
    const bot = await this.bots.findActiveByWidgetToken(botToken);
    if (!bot) throw new NotFoundException('Unknown or inactive bot token');

    const afterDate = new Date(after);
    if (isNaN(afterDate.getTime())) throw new BadRequestException('Invalid "after" timestamp');

    const dialog = await this.dialogs.findBySession(bot.id, sessionId);
    if (!dialog) return { messages: [] };

    const messages = await this.messages.listNewerThan(dialog.id, afterDate);
    return {
      messages: messages
        .filter((m) => m.role !== MessageRole.system)
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          buttons: m.buttons ?? [],
          attachmentUrl: m.attachmentUrl,
          attachmentName: m.attachmentName,
          attachmentMimeType: m.attachmentMimeType,
          createdAt: m.createdAt,
        })),
    };
  }

  /**
   * Public 👎 on test-chat.html (the demo link given to testers with no
   * cabinet access) — only ever flags the message for the owner to review
   * later in "Обучение бота", never writes anything to the bot itself.
   * Deliberately public (no AuthGuard): the whole point is letting an
   * un-authenticated tester report something without granting them any
   * actual influence — see MessagesService.markDisliked for the ownership
   * check that keeps this from flagging an arbitrary message.
   */
  async dislikeMessage(botToken: string, sessionId: string, messageId: string): Promise<{ ok: boolean }> {
    const bot = await this.bots.findActiveByWidgetToken(botToken);
    if (!bot) return { ok: false };
    return this.messages.markDisliked(bot.id, sessionId, messageId);
  }

  // "Удалить" choice next to the failed-send retry pill — see
  // MessagesService.discardLastUnanswered for the actual safety checks.
  async discardLastMessage(botToken: string, sessionId: string): Promise<{ ok: boolean }> {
    const bot = await this.bots.findActiveByWidgetToken(botToken);
    if (!bot) return { ok: false };
    return this.messages.discardLastUnanswered(bot.id, sessionId);
  }

  /**
   * "Обучение" mode: bypasses the bot's own sales funnel entirely. A menu
   * ("Загрузить текст в базу знаний" / "Дать совет" / "Добавить сайт или
   * страницу") lets the owner pick what to do; each option reuses the exact
   * tool the cabinet's own pages use (bulk KB structuring, coaching advice,
   * site fetch). Typing free text without picking a button defaults to "add
   * to knowledge base" — the most common case shouldn't require a click.
   */
  private async processTrainingMessage(
    dto: SendMessageDto,
    bot: NonNullable<Awaited<ReturnType<BotsService['findActiveByWidgetToken']>>>,
    dialog: Awaited<ReturnType<DialogsService['findOrCreate']>>,
    visitorText: string | undefined,
    existingMessages: Awaited<ReturnType<MessagesService['listByDialog']>>,
  ) {
    if (dto.isInit || dto.isReveal) {
      const firstAssistant = existingMessages.find((m) => m.role === MessageRole.assistant);
      if (firstAssistant) {
        return this.trainingReply(firstAssistant.content, (firstAssistant.buttons as string[] | null) ?? [], bot, dialog);
      }
      // Site-derived knowledge no longer forces a synchronous yes/no here —
      // it lands straight in the moderation queue (see ProvisioningService)
      // and gets reviewed at the owner's own pace in "База знаний" instead.
      const saved = await this.messages.append(dialog.id, MessageRole.assistant, TRAINING_MENU_MESSAGE, TRAINING_MENU_BUTTONS);
      return this.trainingReply(saved.content, TRAINING_MENU_BUTTONS, bot, dialog);
    }

    if (!visitorText) throw new BadRequestException('Either message or buttonPayload is required');
    await this.messages.append(dialog.id, MessageRole.visitor, visitorText);

    if (dto.buttonPayload === TRAINING_BTN_KB) {
      return this.trainingAskFor(dialog, bot, 'kb', 'Пришлите текст — я разберу его на записи для базы знаний.');
    }
    if (dto.buttonPayload === TRAINING_BTN_ADVICE) {
      return this.trainingAskFor(dialog, bot, 'advice', 'Какой совет? Опишите, что поправить в моих ответах.');
    }
    if (dto.buttonPayload === TRAINING_BTN_SITE) {
      return this.trainingAskFor(dialog, bot, 'site', 'Пришлите ссылку на сайт или страницу сайта.');
    }
    if (dto.buttonPayload === TRAINING_BTN_VARIANT) {
      return this.trainingAskFor(
        dialog,
        bot,
        'variant',
        'Пришлите фразу-крючок — я добавлю её в A/B/C/D тест приветствия.',
      );
    }
    if (dto.buttonPayload === TRAINING_BTN_GOAL) {
      return this.trainingAskFor(
        dialog,
        bot,
        'goal_pick',
        'Какая цель у бота? Выберите вариант или опишите свою.',
        GOAL_BUTTON_LABELS,
      );
    }
    if (dto.buttonPayload === TRAINING_BTN_TELEGRAM) {
      const info = await this.telegram.getConnectionInfo(bot.companyId);
      const reply = info.connected
        ? `Telegram уже подключён — сообщения приходят туда же, куда уже настроено: ${info.link}`
        : `Откройте эту ссылку и нажмите Start в Telegram — я начну присылать туда вопросы, на которые не смог ответить: ${info.link}`;
      const saved = await this.messages.append(dialog.id, MessageRole.assistant, `${reply} ${TRAINING_MENU_MESSAGE}`, TRAINING_MENU_BUTTONS);
      return this.trainingReply(saved.content, TRAINING_MENU_BUTTONS, bot, dialog);
    }
    const pickedGoalPreset = dto.buttonPayload ? GOAL_LABEL_TO_PRESET[dto.buttonPayload] : undefined;
    if (pickedGoalPreset) {
      await this.cabinet.setGoal(bot.companyId, pickedGoalPreset, undefined, bot.id);
      const followup = GOAL_FOLLOWUP_QUESTIONS[pickedGoalPreset] ?? 'Отлично! Есть что-то ещё важное, что стоит уточнить?';
      return this.trainingAskFor(dialog, bot, 'kb', followup);
    }

    const visitorMeta = (dialog.visitorMeta as Record<string, any>) ?? {};
    const pendingAction: 'kb' | 'advice' | 'site' | 'goal_pick' | 'variant' | undefined =
      visitorMeta.trainingPendingAction;
    // What the *last* training action actually did, tracked so a follow-up
    // "отмени"/"не надо" reverts the right thing: real KB rows (bulk text,
    // site) can be deleted outright; advice/variant/goal aren't separate rows
    // the same way, so those are remembered as "not revertible" rather than
    // silently falling through to an older, unrelated KB entry.
    const lastAction: { type: 'kb'; ids: string[] } | { type: 'advice' | 'variant' | 'goal' } | undefined =
      visitorMeta.trainingLastAction;

    let confirmation: string;
    let nextLastAction: typeof lastAction | null = lastAction ?? null;

    // Checked before anything else — a short "отмени"/"не надо" reply must
    // never be interpreted as new content to add (that's exactly what used
    // to happen: the cancel word itself got structured into the knowledge
    // base as if it were a real fact).
    if (TRAINING_CANCEL_PATTERN.test(visitorText.trim())) {
      if (pendingAction) {
        // A question was actively pending (e.g. "Пришлите ссылку на сайт") —
        // cancelling here means "never mind THAT", not "undo whatever I did
        // earlier". Must not fall through to the lastAction-undo branches
        // below: lastAction refers to a DIFFERENT, already-completed action
        // from a previous turn, and reverting it here would surprise-delete
        // something the owner never asked to touch.
        confirmation = 'Хорошо, не в этот раз.';
        nextLastAction = lastAction ?? null;
      } else if (lastAction?.type === 'kb' && lastAction.ids.length > 0) {
        for (const id of lastAction.ids) {
          await this.knowledge.delete(bot.companyId, id).catch(() => undefined);
        }
        const n = lastAction.ids.length;
        confirmation = `Убрал(а) то, что добавил(а) последним — ${n} ${n === 1 ? 'запись' : 'записи'} из базы знаний.`;
        nextLastAction = null;
      } else if (lastAction) {
        confirmation = 'Это отменить автоматически не получится — уберите вручную в кабинете.';
        nextLastAction = null;
      } else {
        confirmation = 'Хорошо, ничего не меняю.';
        nextLastAction = null;
      }
    } else {
      try {
        if (pendingAction === 'advice') {
          const result = await this.bots.addCoachingAdvice(bot.id, visitorText);
          confirmation = result.ok
            ? 'Записал(а) совет — учту его в разговорах.'
            : 'У этого бота уже максимум советов — уберите старые в кабинете, прежде чем добавлять новые.';
          nextLastAction = result.ok ? { type: 'advice' } : lastAction ?? null;
        } else if (pendingAction === 'site') {
          const result = await this.knowledge.addFromSite(bot.companyId, visitorText, bot.id);
          confirmation =
            result.skippedDuplicates > 0
              ? `Изучил(а) страницу, добавил(а) записей: ${result.count} (уже знал(а) ${result.skippedDuplicates} — пропустил(а)).`
              : `Изучил(а) страницу, добавил(а) записей: ${result.count}.`;
          nextLastAction = { type: 'kb', ids: result.ids };
        } else if (pendingAction === 'variant') {
          await this.cabinet.addGreetingVariant(bot.companyId, visitorText, bot.id);
          confirmation = 'Добавил(а) в A/B/C/D тест приветствия!';
          nextLastAction = { type: 'variant' };
        } else if (pendingAction === 'goal_pick') {
          // Free-text goal, typed instead of picking one of the preset buttons.
          const result = await this.cabinet.setGoal(bot.companyId, 'custom', visitorText, bot.id);
          confirmation = `Цель настроена: «${result.goalLabel}».`;
          nextLastAction = { type: 'goal' };
        } else {
          // No button picked, no pendingAction queued — ambiguous free text.
          // Classify before blindly structuring it into the KB as a fact:
          // it might instead be a question directed at this assistant, or an
          // instruction about how the bot should behave — neither belongs in
          // the knowledge base (see classifyTrainingInput's own comment).
          const classification = await this.yandexGpt.classifyTrainingInput(visitorText);
          if (classification.type === 'question') {
            confirmation = classification.reply || 'Хороший вопрос — уточню и вернусь с ответом.';
            nextLastAction = lastAction ?? null;
          } else if (classification.type === 'command') {
            const result = await this.bots.addCoachingAdvice(bot.id, visitorText);
            confirmation = result.ok
              ? 'Приняла как инструкцию — учту в разговорах с посетителями.'
              : 'У этого бота уже максимум советов — уберите старые в кабинете, прежде чем добавлять новые.';
            nextLastAction = result.ok ? { type: 'advice' } : lastAction ?? null;
          } else {
            const result = await this.knowledge.createFromBulkText(bot.companyId, visitorText, undefined, bot.id);
            confirmation =
              result.skippedDuplicates > 0
                ? `Записал(а), спасибо! Добавлено записей: ${result.count} (уже знал(а) ${result.skippedDuplicates} — пропустил(а)).`
                : `Записал(а), спасибо! Добавлено записей: ${result.count}.`;
            nextLastAction = { type: 'kb', ids: result.ids };
          }
        }
      } catch (error) {
        this.logger.warn(`Training-mode action failed (pendingAction=${pendingAction}): ${String(error)}`);
        confirmation = 'Не получилось это обработать — попробуйте ещё раз или другой вариант.';
        // Nothing actually changed — nextLastAction (initialized above to the
        // prior value) is left as-is.
      }
    }

    await this.dialogs.setVisitorMeta(dialog.id, {
      ...visitorMeta,
      trainingPendingAction: null,
      trainingLastAction: nextLastAction,
    });

    const reply = `${confirmation} ${TRAINING_MENU_MESSAGE}`;
    const saved = await this.messages.append(dialog.id, MessageRole.assistant, reply, TRAINING_MENU_BUTTONS);
    return this.trainingReply(saved.content, TRAINING_MENU_BUTTONS, bot, dialog);
  }

  private async trainingAskFor(
    dialog: Awaited<ReturnType<DialogsService['findOrCreate']>>,
    bot: { name: string },
    action: 'kb' | 'advice' | 'site' | 'goal_pick' | 'variant',
    prompt: string,
    buttons: string[] = [],
  ) {
    const visitorMeta = (dialog.visitorMeta as Record<string, any>) ?? {};
    await this.dialogs.setVisitorMeta(dialog.id, { ...visitorMeta, trainingPendingAction: action });
    const buttonsWithCancel = [...buttons, TRAINING_BTN_CANCEL];
    const saved = await this.messages.append(dialog.id, MessageRole.assistant, prompt, buttonsWithCancel);
    return this.trainingReply(saved.content, buttonsWithCancel, bot, dialog);
  }

  private trainingReply(
    content: string,
    buttons: string[],
    bot: { name: string },
    dialog: { status: DialogStatus },
  ) {
    return { reply: content, buttons, stage: 'training', dialogStatus: dialog.status, leadCaptured: false, botName: bot.name };
  }

  /**
   * Ground truth beats a self-reported string: widget.js knows the real
   * hostname it's actually running on, so the first genuine page load is the
   * natural moment to either capture the real site (if none was ever given)
   * or notice it disagrees with one that was. Two distinct signals, each
   * platform-admin-alerted at most once per bot — never blocks or slows the
   * actual conversation this ran alongside.
   */
  private async checkDomainIntegrity(
    bot: NonNullable<Awaited<ReturnType<BotsService['findActiveByWidgetToken']>>>,
    pageHostname: string,
  ): Promise<void> {
    const normalized = this.provisioning.normalizeWebsite(pageHostname);
    if (!normalized) return;

    if (!bot.sourceWebsite) {
      const isDuplicate = await this.provisioning.isDuplicateSite(pageHostname);
      await this.bots.setSourceWebsite(bot.id, normalized);
      if (isDuplicate) {
        // Same policy as the registration-time duplicate check in
        // getOrProvision — a domain only gets one free trial, whichever way
        // the duplicate is discovered. subscriptionActive stays false, so
        // sendMessage's existing trial-expired gate applies from the very
        // next message.
        await this.provisioning.markTrialForfeited(bot.id);
        await this.telegram.alertPlatformAdmin(
          `Домен «${normalized}» (бот «${bot.name}») уже используется другим ботом — похоже на повторную ` +
            'регистрацию под тот же бизнес ради ещё одного бесплатного триала. Аккаунт переведён в платный ' +
            '(без пробного периода). Проверьте вручную, если это ошибка.',
        );
      }
      return;
    }

    const existingNormalized = this.provisioning.normalizeWebsite(bot.sourceWebsite);
    if (existingNormalized && existingNormalized !== normalized && !bot.domainMismatchAlertedAt) {
      await this.bots.markDomainMismatchAlerted(bot.id);
      await this.telegram.alertPlatformAdmin(
        `Бот «${bot.name}» указал сайт «${bot.sourceWebsite}», но код вставки реально загрузился на ` +
          `«${normalized}» — расхождение доменов. Проверьте вручную.`,
      );
    }
  }

  /** What to actually say to the visitor for each outcome of getOrProvision. */
  private provisionResultToText(result: ProvisionResult): string {
    if (result.ok) return result.registrationUrl;
    return 'ссылку пришлёт менеджер лично';
  }

  async coachBot(botToken: string, advice: string, companyId: string) {
    const bot = await this.bots.findActiveByWidgetToken(botToken);
    // Same message for "no such bot" and "not yours" — don't confirm to a
    // caller which widget tokens exist for companies other than their own.
    if (!bot || bot.companyId !== companyId) throw new NotFoundException('Unknown or inactive bot token');

    // Never a "too many" rejection — see KnowledgeService.createInstruction:
    // hitting the cap now consolidates instead of ever refusing this.
    await this.bots.addCoachingAdvice(bot.id, advice);
    return { ok: true };
  }

  async addKnowledge(botToken: string, text: string, companyId: string) {
    const bot = await this.bots.findActiveByWidgetToken(botToken);
    if (!bot || bot.companyId !== companyId) throw new NotFoundException('Unknown or inactive bot token');

    await this.knowledge.createForBot(bot.id, companyId, null, text, 'test_chat');
    return { ok: true };
  }

  async addCorrection(botToken: string, situationContext: string, badReply: string, goodReply: string, companyId: string) {
    const bot = await this.bots.findActiveByWidgetToken(botToken);
    if (!bot || bot.companyId !== companyId) throw new NotFoundException('Unknown or inactive bot token');

    await this.knowledge.createCorrection(companyId, situationContext, badReply, goodReply, bot.id);
    return { ok: true };
  }

  /**
   * Preview counterpart to addCorrection, used by the owner's own test-chat
   * correction control (attachCorrectionControl in chat.js) — regenerates a
   * candidate reply from the owner's note instead of saving it verbatim, so
   * they can see it (and refine the note, calling this again) before
   * anything is actually remembered. No real dialog/session is available at
   * this call site (the control only ever has situationContext/badReply as
   * plain text, same as addCorrection itself), so history is limited to that
   * one preceding visitor message and stage defaults to the bot's first
   * stage — an approximation, but the same level of fidelity addCorrection
   * already works with.
   */
  async previewCorrection(
    botToken: string,
    situationContext: string,
    badReply: string,
    note: string,
    companyId: string,
  ): Promise<{ candidateReply: string }> {
    const bot = await this.bots.findActiveByWidgetToken(botToken);
    if (!bot || bot.companyId !== companyId) throw new NotFoundException('Unknown or inactive bot token');

    const stages = this.bots.getFunnelStages(bot);
    const stage = this.bots.getInitialStage(bot);
    const chatHistory: ChatTurn[] = situationContext.trim() ? [{ role: 'user', content: situationContext.trim() }] : [];

    const stageInstructions =
      (stage?.instructions ?? 'Greet the visitor and learn what they need.') +
      WidgetService.UNIVERSAL_STAGE_GUIDANCE +
      WidgetService.buildCorrectionNudge(badReply, note);

    const result = await this.yandexGpt.generateReply({
      systemPrompt: bot.systemPrompt,
      stageInstructions,
      currentStageId: stage?.stageId ?? 'greeting',
      stages,
      history: chatHistory,
    });

    // See the identical guard in previewCorrectedReply above — the real
    // substitution provisions a per-visitor company/link as a side effect
    // that has no place in a preview, and the raw token (or any fixed
    // stand-in) would be wrong to save as a fixed "correction" forever.
    if (result.reply.includes(REGISTRATION_LINK_PLACEHOLDER)) {
      throw new BadRequestException(
        'Это сообщение с персональной ссылкой на регистрацию — ссылка каждый раз своя для конкретного ' +
          'клиента, так что этот ответ нельзя "запомнить" как общий пример.',
      );
    }

    return { candidateReply: result.reply };
  }

  // Simple promise-chained mutex, keyed per dialog: queues callers for the same
  // dialogId so the second one's DB reads only ever happen after the first
  // one's writes have committed. Single-process only (fine — this app runs as
  // one PM2 fork, not a cluster), and self-cleans from the map once the queue
  // for a given key drains.
  private async withDialogLock<T>(dialogId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.dialogLocks.get(dialogId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => next);
    this.dialogLocks.set(dialogId, chained);
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.dialogLocks.get(dialogId) === chained) {
        this.dialogLocks.delete(dialogId);
      }
    }
  }

  // persona-rules.ts asks for judgment ("only when you genuinely latched onto
  // something specific") on these — the model doesn't reliably apply that
  // nuance in practice, so the ones seen live shipping as empty reflexive
  // openers are enforced here as a flat ban instead, same as "Понимаю"
  // already was in the prompt.
  private static readonly BANNED_FILLER_OPENERS = ['Понимаю', 'Ясно', 'Понятно', 'Бывает'];

  // Extracted so DislikesService.previewCorrectedReply can reuse the exact
  // same always-on guidance when regenerating a candidate fix for a flagged
  // reply — a preview built from different (drifted-over-time) rules than
  // the live bot would show the owner a misleading picture of what the bot
  // will actually say next time.
  static readonly UNIVERSAL_STAGE_GUIDANCE =
    '\n\nТы сама — чат-виджет именно НА САЙТЕ компании, и ничего больше: ты ловишь и ведёшь посетителей, ' +
    'которые уже находятся на сайте. Если собеседник упоминает другие каналы обращений (Авито, WhatsApp, ' +
    'звонки, соцсети, маркетплейсы и т.п.) — это нормальный контекст его текущей ситуации, используй его, ' +
    'но НИКОГДА не утверждай и не намекай, что ты (или продукт, который ты предлагаешь) умеет обрабатывать, ' +
    'подключаться к или как-то ещё работать С ЭТИМИ ДРУГИМИ каналами — если только тебе явно не передали ' +
    'такую возможность в системном промпте или базе знаний. Это реальная функция, которой пока нет, а не ' +
    'то, что можно с уверенностью пообещать. Вместо этого разговор всегда веди к пользе именно чата на ' +
    'сайте — например, что он ловит и обрабатывает обращения тех, кто уже зашёл на сайт, 24/7, пока другие ' +
    'каналы остаются как есть.\n\n' +
    'Твоя самая первая реплика в этом диалоге (крючок в самом начале истории) сама по себе — одноразовая, ' +
    'для того самого первого момента: её ТЕКСТ нигде и никогда не повторяй и не перефразируй дословно или ' +
    'близко к тексту, даже когда кажется, что он снова подходит. Но её СМЫСЛ (то, о чём она спрашивала или ' +
    'предлагала) остаётся активным и значимым до тех пор, пока собеседник явно на него не ответил — не ' +
    'выкидывай его из внимания только потому, что позже прозвучал ещё один, другой вопрос. Если короткий или ' +
    'неоднозначный ответ собеседника (например, «покажи», «да», «давай», «ок») по смыслу отвечает именно ' +
    'на предложение или вопрос ИЗ КРЮЧКА, а не на самый последний заданный вопрос — распознай это, коротко ' +
    'подтверди его согласие своими словами и естественно веди разговор дальше оттуда (например, к тому, что ' +
    'нужно узнать, чтобы это предложение выполнить), а НЕ трактуй такой ответ как что-то не по теме или как ' +
    'просьбу о чём-то совсем другом. Если же собеседник ответил чем-то, что не относится ни к крючку, ни к ' +
    'последнему вопросу (просто поздоровался, написал что-то нейтральное) — коротко и тепло отреагируй на ' +
    'то, что он написал, и мягко верни разговор к вопросу, который уже был задан и остался без ответа, но ' +
    'НОВЫМИ словами, а не тем, что уже звучало.\n\n' +
    'Если собеседник упомянул сайт, домен или название своего бизнеса, но реальный текст с его сайта тебе ' +
    'НЕ передавали в инструкциях этой реплики — НЕ угадывай и не описывай нишу, ассортимент, качество или ' +
    'что-либо ещё про этот бизнес по одному только названию/домену. Это выглядит как подлог. Либо опирайся ' +
    'строго на реально переданные тебе данные, либо честно скажи, что ещё не смотрела, и спроси напрямую.\n\n' +
    'Проверь свою предыдущую реплику в истории разговора: если она начиналась с фразы-перехода вроде ' +
    '"Отлично, давайте начнём!" — в этой реплике НЕ используй ту же самую фразу снова, даже если сейчас ' +
    'задаёшь совсем новый вопрос. Это звучит как повтор, даже когда содержание разное. Либо новая ' +
    'формулировка перехода, либо вообще без неё, сразу по существу.\n\n' +
    'Если собеседник ПРЯМО говорит, что не хочет отвечать на вопросы или проходить опрос, и просит сразу ' +
    'перейти к делу (продукту, ссылке, пробному доступу) — это не уклонение, а явное требование сменить ' +
    'формат ПРЯМО СЕЙЧАС. ЗАПРЕЩЕНО в этой ситуации настаивать на продолжении вопросов хоть одной фразой ' +
    '("давайте всё же поговорим", "но сначала уточню" и т.п.) — это звучит так, будто ты проигнорировала ' +
    'прямой протест. Вместо этого сразу предлагай практический следующий шаг, опираясь на то немногое, что ' +
    'уже известно, пропуская промежуточные стадии выявления потребности и питча.\n\n' +
    'Выявляй ситуацию собеседника НЕ через провалы и проблемы ("что теряется", "кто не успевает", "что ' +
    'происходит, когда не ответили") — это звучит как критика того, что человек уже сам построил, и ' +
    'включает защитную реакцию, а не любопытство. Сначала искренне отметь то, что уже сделано хорошо (даже ' +
    'деталь из его же слов), и предлагай усилить это, а не исправить: "Круто, что у вас уже [то, что есть] ' +
    '— хотите, покажу, как сделать это ещё сильнее?" продаёт лучше, чем "а что если у вас не отвечают ' +
    'вовремя". Ищи решение исходя из того, что собеседник сам назвал важным, а не навязывай типовой список ' +
    'проблем.\n\n' +
    'Если собеседник только что задал простой уточняющий или информационный вопрос (например, про ' +
    'техническую деталь, как что-то устроено, факт о продукте) — а это НЕ согласие, НЕ явный отказ и НЕ ' +
    'сигнал готовности двигаться дальше — ответь на него по существу и на этом закончи реплику. ЗАПРЕЩЕНО ' +
    'приписывать в конце новый вопрос-приглашение или призыв узнать больше/попробовать/оформить, если ты уже ' +
    'задавала подобный вопрос-приглашение в одной из своих 1-2 предыдущих реплик — даже если сейчас другими ' +
    'словами. Новый призыв уместен только тогда, когда САМ собеседник только что показал сигнал интереса или ' +
    'готовности, а не просто продолжает задавать уточняющие вопросы. Призыв в каждой подряд идущей реплике ' +
    'ощущается как давление продавца, который не слушает, а гнёт свою линию, а не как живой разговор.\n\n' +
    'Это правило — именно про ЧУЖИЕ кейсы/отзывы/цифры, а не про демонстрацию на бизнесе самого собеседника: ' +
    'если он коротко соглашается на твоё же собственное более раннее предложение показать, как это работает ' +
    'НА ЕГО бизнесе (например, ты спрашивала "показать на вашем примере?", а он отвечает "покажи", "да", ' +
    '"давай") — это НЕ просьба показать чужие кейсы, следующее правило сюда не применяется, продолжай обычным ' +
    'образом, опираясь на то, что он согласился.\n\n' +
    'Просьба показать примеры успешных кейсов, отзывы других клиентов, ссылки на них, портфолио или ' +
    'конкретные цифры результатов — никогда не обещай прислать ссылки и не выдумывай кейсы или цифры, ' +
    'которых нет в переданных тебе данных. Объясни своими словами (не зачитывай дословно), что не можешь ' +
    'показывать кейсы других клиентов, т.к. тестовые диалоги сильно влияют на их показатели конверсии, а ' +
    'вместо этого предложи бесплатный пробный период с тестовым чатом, где собеседник сам может попробовать ' +
    'диалоги, не публикуя бота на сайте, пока не будет доволен результатом.\n\n' +
    'Если собеседник в шутку или всерьёз просит что-то, вообще не относящееся к делу (рецепт, факт про ' +
    'здания, погоду и т.п.) — НИКОГДА не ставь это условием ("отвечу, после того как вы оформите бота/' +
    'зарегистрируетесь"): это звучит как шантаж или ультиматум, а не как помощь, и подрывает доверие, даже ' +
    'если сказано вежливо. Вместо этого один раз коротко и по-человечески откажи или отшутись (например: ' +
    '"Это, к сожалению, не по моей части — а вот с ботом помогу") и мягко верни разговор к делу. Если ' +
    'собеседник настаивает — не повторяй тот же отказ слово в слово: либо ответь на его вопрос коротко, раз ' +
    'он явно не отпускает тему, либо признай, что зашли в сторону, другими словами, и предложи вернуться к ' +
    'делу.\n\n' +
    'Твоей базовой инструкции могло быть сказано всегда заканчивать реплику вопросом или приглашением к ' +
    'следующему шагу — это правило неточное, не следуй ему буквально. Нормально закончить реплику без ' +
    'вопроса, ЕСЛИ собеседник просто задал уточняющий вопрос или сообщил факт, не показывая сигнала двигаться ' +
    'дальше — тогда ответь по существу и на этом остановись. Если вопрос всё же нужен, он не обязан быть ' +
    'приглашением к следующему шагу воронки: иногда искренне любопытный вопрос о ситуации собеседника звучит ' +
    'живее, чем "хотите попробовать?".\n\n' +
    'НО это правило НЕ применяется, когда собеседник САМ только что дал согласие, подтверждение или сигнал ' +
    'готовности двигаться дальше ("да", "давайте", "хочу попробовать", "я передумал — давайте", согласие на ' +
    'предыдущее предложение и т.п.). В этом случае короткая реакция вроде "Отлично!" БЕЗ ПРОДОЛЖЕНИЯ — это ' +
    'тупик для собеседника: он согласился, но не знает, что делать дальше, и разговор просто зависает. Если ' +
    'собеседник только что согласился или дал сигнал готовности — ОБЯЗАТЕЛЬНО в этой же реплике либо задай ' +
    'следующий содержательный вопрос по сценарию текущей стадии, либо сразу сделай реальный следующий шаг ' +
    '(например, дай ссылку на регистрацию, если по сценарию стадии пора). Короткое "Отлично!" или "Супер!" ' +
    'само по себе — это в лучшем случае начало реплики, никогда не вся реплика целиком.\n\n' +
    'Слово "Однако" в значении "но" звучит казённо и по-письменному — избегай его, используй просто "Но".\n\n' +
    'Если собеседник только что сам назвал конкретный факт, требование или готовый вариант, который прямо ' +
    'отвечает на то, о чём ты собиралась спросить дальше по сценарию (например, ты хотела спросить про цель ' +
    'или подход, а он уже сформулировал его сам) — используй именно это, не задавай тот же вопрос другими ' +
    'словами и не переходи к следующему пункту сценария так, будто он ничего не сказал. Сначала явно подтверди, ' +
    'что услышала и приняла именно то, что он предложил ("да, именно так и сделаем" — своими словами, не ' +
    'вопросом), и только потом, если реально не хватает ещё одной детали, спроси её — но не вместо признания ' +
    'его ответа, а вдобавок к нему. Ответ по шаблону, который не опирается на то, что собеседник только что ' +
    'сказал, читается как то, что его никто не слушал.\n\n' +
    'Ты представилась собеседнику по имени — естественно узнать в ответ, как зовут его самого, чтобы дальше ' +
    'обращаться к нему лично, а не безлично. Сделай это одним лёгким вопросом в удобный момент (не обязательно ' +
    'сразу после своего представления — по ситуации, но и не откладывай надолго), например "А как ' +
    'я могу к вам обращаться?" — без анкетного тона. Если имя уже известно из истории разговора (см. "Уже ' +
    'известно о собеседнике" ниже, если этот блок есть) — не спрашивай снова, а естественно используй его ' +
    'время от времени в своих репликах дальше, не в каждой подряд (это быстро начинает звучать навязчиво и ' +
    'по-скриптовому) — раз-два за разговор, в подходящий момент, этого достаточно, чтобы разговор ощущался ' +
    'персональным. Спроси имя только один раз за весь разговор. Если собеседник не ответил на этот вопрос ' +
    '(проигнорировал и заговорил о другом) или прямо дал понять, что не хочет называть имя, — прими это ' +
    'спокойно, без давления: не переспрашивай ещё раз ни в этой, ни в следующих репликах, и не показывай, что ' +
    'заметила отказ. Просто продолжай разговор дальше как обычно, обращаясь безлично.';

  // Seen live: with the old wording (bad reply presented first and fully
  // quoted, note as an afterthought), the model kept anchoring on the
  // REJECTED reply's own phrasing almost verbatim, even when the specialist
  // had typed out a complete replacement answer — the note was there, but
  // clearly wasn't what the model actually used. This version puts the
  // specialist's note first, states outright that it may already BE the
  // finished answer (not just feedback), and explicitly forbids drifting
  // back to the rejected wording below except to confirm the same facts.
  private static buildCorrectionNudge(rejectedReply: string, note: string): string {
    return (
      `\n\nСпециалист компании отметил один из твоих прошлых ответов как неудачный и написал, как надо было ` +
      `ответить: "${note}".\n\n` +
      'Если это замечание уже само по себе читается как готовый ответ (или почти готовый) — твоя задача ' +
      'ТОЛЬКО адаптировать именно ЕГО стилистически под живой тон разговора (без канцелярита, естественно) и ' +
      'при необходимости мягко достроить в полноценную реплику. Содержание и смысл должны остаться ровно ' +
      'теми, что написал специалист — не заменяй их своей версией и не сокращай суть. Если же это лишь ' +
      'короткая пометка о том, что было не так (а не готовый ответ) — тогда самостоятельно сформулируй полный ' +
      'ответ, устраняющий именно эту проблему.\n\n' +
      `Для контекста, вот тот самый прошлый ответ, который был отклонён: "${rejectedReply}". ЗАПРЕЩЕНО ` +
      'повторять его формулировки или структуру — специалист отклонил его, а не одобрил; используй его только ' +
      'чтобы понять, на какой вопрос собеседника отвечаешь, ничего больше.'
    );
  }

  private startsWithBannedFiller(reply: string): string | null {
    const trimmed = reply.trim();
    for (const word of WidgetService.BANNED_FILLER_OPENERS) {
      const pattern = new RegExp(`^${word}[.,!]*(\\s|$)`, 'i');
      if (pattern.test(trimmed)) return word;
    }
    return null;
  }

  // Deliberately keyword-based rather than "any trailing question" — a real
  // clarifying question the visitor still needs answered ("сколько это
  // стоит?" answered with "смотря что вам нужно?") is fine to end on. This
  // only flags the specific shape seen live: a next-step/CTA-style
  // invitation ("Хотите...", "Готовы...", "Давайте...") glued onto the end
  // of literally every reply regardless of what was asked — seen live 15+
  // turns in a row on one real dialog, each with genuinely different
  // wording, so text-similarity checks (isRepeatOfPrevious) never catch it;
  // this checks whether the shape repeats, not the exact words.
  private static readonly INVITATION_OPENERS =
    /^(хотите|хотел[аи]?\s+бы|готовы|давайте|интересно|удобнее|устроит|нужно\s+ли|желаете)/i;

  private endsWithInvitation(text: string): boolean {
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
    // Checks the last TWO sentences, not just the very last one — the
    // next_step_offer script itself phrases the invitation as "Хотите X?
    // Или Y?", and a short "Или..." continuation tacked onto a real
    // invitation would otherwise slip past a last-sentence-only check
    // (seen live: exactly this shape went undetected).
    return sentences.slice(-2).some((s) => {
      const trimmed = s.trim();
      return /\?\s*$/.test(trimmed) && WidgetService.INVITATION_OPENERS.test(trimmed);
    });
  }

  // "Понятно?"/"Ясно?" alone, optionally preceded by "теперь"/"вам"/"всё"/
  // "это" — anchored so it doesn't fire on a genuine content question that
  // merely contains one of these words followed by more text (e.g. "Вам это
  // ясно из документации, или уточнить?" keeps its normal reply).
  private static readonly CONDESCENDING_CHECK_PATTERN =
    /^(?:теперь\s+|вам\s+|всё\s+|все\s+|это\s+)*(?:понятно|понятнее|ясно|ясней)\s*\?\s*$/i;

  private endsWithCondescendingCheck(text: string): boolean {
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
    const last = sentences[sentences.length - 1]?.trim() ?? '';
    return WidgetService.CONDESCENDING_CHECK_PATTERN.test(last);
  }

  // Deterministic fallback for when the retry nudge above doesn't take.
  // Never used on a single-sentence reply — a whole turn is occasionally
  // JUST the invitation by design (e.g. value_pitch's own scripted close),
  // and stripping it there would leave nothing to show the visitor at all,
  // which is worse than one more repeated invitation.
  private stripTrailingSentence(text: string): string {
    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
    if (sentences.length <= 1) return text.trim();
    return sentences.slice(0, -1).join('').trim();
  }

  // Seen live: visitor sends a bare "да"/"давайте" and the reply is a short
  // acknowledgement with no continuation ("Отлично!") — a dead end, since the
  // visitor just agreed to move forward and now has nothing to act on. Only
  // fires when the visitor's message was ITSELF just the affirmative (not a
  // longer message that happens to start with "да") and the reply is both
  // short and has no question or link to carry the conversation forward.
  private isDeadEndAfterAffirmative(visitorText: string | undefined, reply: string): boolean {
    if (!visitorText || !AFFIRMATIVE_PATTERN.test(visitorText.trim())) return false;
    const trimmed = reply.trim();
    if (trimmed.length > 60) return false;
    if (/\?\s*$/.test(trimmed)) return false;
    if (URL_IN_TEXT_PATTERN.test(trimmed)) return false;
    return true;
  }

  // Seen live: a bot explicitly set to female ("Алина") opened a reply with
  // "Рад Вас снова приветствовать" — masculine self-reference from a bot
  // whose whole persona is female, visible to a real prospect on their very
  // first exchange. The prompt already tells the model its own grammatical
  // gender (see the "Ты, {name}, — женского/мужского пола" instruction
  // above), but that's advisory, same as every other rule in this file that
  // also gets a deterministic backstop.
  private hasWrongGenderSelfReference(reply: string, gender: string): boolean {
    const wrongPattern = gender === 'male' ? FEMININE_SELF_ADJECTIVE_PATTERN : MASCULINE_SELF_ADJECTIVE_PATTERN;
    return wrongPattern.test(reply);
  }

  // Catches an exact-verbatim repeat, the softer case where the model just
  // tacks an extra sentence onto the same text it already said last turn (one
  // text fully containing the other), and the case where it reuses the same
  // opening chunk of text before diverging (e.g. restating its previous hook
  // word-for-word as the lead-in to an otherwise new reply).
  private isRepeatOfPrevious(newReply: string, previousReply: string): boolean {
    const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
    const a = normalize(newReply);
    const b = normalize(previousReply);
    if (!a || !b) return false;
    if (a === b) return true;
    if (b.length > 20 && a.includes(b)) return true;
    if (a.length > 20 && b.includes(a)) return true;

    let sharedPrefix = 0;
    const shorter = Math.min(a.length, b.length);
    while (sharedPrefix < shorter && a[sharedPrefix] === b[sharedPrefix]) sharedPrefix++;
    if (sharedPrefix >= 30 && sharedPrefix >= shorter * 0.5) return true;

    // Narrower case the ratio check above misses: two DIFFERENT, substantive
    // replies that both open with the same stock transition/enthusiasm
    // phrase (seen live: "Отлично, давайте начнём!" verbatim twice in a row,
    // each followed by an unrelated new question). The shared text there is
    // a short fixed opener glued to a long new question, so it's never a
    // large fraction of the whole message — the ratio check can't catch it,
    // but comparing just the first sentence can.
    const firstSentence = (text: string) => text.match(/^[^.!?]*[.!?]+/)?.[0] ?? '';
    const sentenceA = firstSentence(a);
    const sentenceB = firstSentence(b);
    if (sentenceA.length >= 10 && sentenceA === sentenceB) return true;

    // Seen live: a new greeting sentence tacked onto the FRONT and one
    // sentence dropped from the tail, with the entire multi-sentence pitch in
    // between reused verbatim — neither containment (nothing fully contains
    // the other any more) nor the prefix/first-sentence checks above (they
    // diverge from character 1, since the new opener replaces the old one)
    // can catch that shape. This instead looks at the actual sentence-level
    // overlap wherever it falls in the message: if a large enough share of
    // one reply's substance is sentences that appear verbatim in the other,
    // it's the same pitch wearing a different wrapper, not a fresh answer.
    const splitSentences = (text: string) =>
      (text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []).map((s) => s.trim()).filter(Boolean);
    const sentencesA = splitSentences(a);
    const sentencesB = new Set(splitSentences(b));
    const reusedLength = sentencesA
      .filter((s) => s.length >= 20 && sentencesB.has(s))
      .reduce((sum, s) => sum + s.length, 0);
    if (shorter > 0 && reusedLength / shorter >= 0.5) return true;

    // Narrowest (and most common in practice) case still missed: the same
    // CORE CLAUSE carried over verbatim, but wrapped in a different opener
    // and closer on each turn ("Ясно. Давайте начнём с того, что вы
    // продаёте через Авито — это будет отправной точкой... Хотите
    // попробовать?" then next turn "Отлично! Теперь я знаю, что вы продаёте
    // через Авито — это будет отправной точкой... Давайте продолжим.") —
    // every check above operates on whole sentences or fixed-position
    // prefixes/suffixes, so a shared clause sitting in the MIDDLE of two
    // differently-shaped sentences slips through all of them. This instead
    // looks for the longest run of consecutive identical WORDS anywhere in
    // either text, regardless of sentence boundaries or position. Threshold
    // picked from real examples: both live failures that prompted this hit
    // 8+ and 12+ words; a coincidental shared turn of phrase between two
    // genuinely different questions (tested against "у вас уже есть...")
    // topped out at 5 — 8 sits with margin above that noise floor.
    const words = (text: string) => text.replace(/[.,!?—-]/g, '').split(/\s+/).filter(Boolean);
    const wordsA = words(a);
    const wordsB = words(b);
    let longestRun = 0;
    for (let i = 0; i < wordsA.length && longestRun < 8; i++) {
      for (let j = 0; j < wordsB.length; j++) {
        let k = 0;
        while (i + k < wordsA.length && j + k < wordsB.length && wordsA[i + k] === wordsB[j + k]) k++;
        if (k > longestRun) longestRun = k;
      }
    }
    if (longestRun >= 8) return true;

    return false;
  }
}
