import { Injectable, Logger } from '@nestjs/common';
import { EscalationReason, MessageRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
import { YandexGptService } from '../yandex-gpt/yandex-gpt.service';
import { MessagesService } from '../messages/messages.service';

// Loose match for a short confirm — deliberately permissive so replying with
// any of these (any case, with or without punctuation/emoji around it)
// finalizes the pending draft instead of being treated as a new draft.
const CONFIRM_PATTERN = /^[👍✅]*\s*(да|ок|окей|верно|подтверждаю|все верно|всё верно|отправляй|можно)\s*[!.]*$/i;

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// The platform's own company row, seeded once and never re-created (see
// prisma/seed.ts) — this is where "Умный Чат" itself, as the operator, gets
// its own real production Telegram notifications. Platform-level abuse
// alerts (see alertPlatformAdmin) go here specifically, never to whichever
// client company happened to trigger the check.
const PLATFORM_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string };
    text?: string;
    reply_to_message?: { message_id?: number | string };
  };
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  private cachedUsername: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly yandexGpt: YandexGptService,
    private readonly messages: MessagesService,
  ) {}

  private get apiUrl(): string {
    return `${TELEGRAM_API_BASE}/bot${this.token}`;
  }

  private async getBotUsername(): Promise<string> {
    if (this.cachedUsername) return this.cachedUsername;
    const res = await fetch(`${this.apiUrl}/getMe`);
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram getMe failed: ${JSON.stringify(data)}`);
    this.cachedUsername = data.result.username as string;
    return this.cachedUsername;
  }

  /**
   * Returns the deep link to show in the cabinet. Same call whether it's
   * Алина's own company or a client's — no separate "admin" path.
   */
  async getConnectionInfo(companyId: string): Promise<{ link: string; connected: boolean }> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new Error('Company not found');

    const username = await this.getBotUsername();

    if (company.telegramChatId) {
      return { link: `https://t.me/${username}`, connected: true };
    }

    const token = company.telegramConnectToken ?? randomUUID();
    if (!company.telegramConnectToken) {
      await this.prisma.company.update({ where: { id: companyId }, data: { telegramConnectToken: token } });
    }
    return { link: `https://t.me/${username}?start=${token}`, connected: false };
  }

  private async sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<string | null> {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      // Threads a follow-up (e.g. a contact arriving after the fact — see
      // attachContactToEscalation) visually under the original escalation
      // message instead of as an unrelated new one.
      if (replyToMessageId) body.reply_to_message_id = Number(replyToMessageId);
      const res = await fetch(`${this.apiUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        this.logger.error(`sendMessage failed: ${JSON.stringify(data)}`);
        return null;
      }
      return String(data.result.message_id);
    } catch (error) {
      this.logger.error(`sendMessage crashed: ${String(error)}`);
      return null;
    }
  }

  /**
   * Records the escalation regardless of Telegram connection state — a
   * question is never lost just because the company hasn't connected
   * Telegram yet, it simply doesn't push anywhere until they do.
   */
  async escalate(params: {
    botId: string;
    companyId: string;
    botName: string;
    dialogId?: string;
    reason: EscalationReason;
    question: string;
    botReply?: string;
    // Only meaningful for reason: 'dissatisfaction' — the real preceding
    // visitor message that params.question (the model's own "what went
    // wrong" summary) doesn't itself contain. See widget.service.ts.
    visitorQuestion?: string;
    // Only meaningful for reason: 'unanswered'. Usually still unknown at
    // this point (the visitor typically leaves contact a turn or two AFTER
    // the question that needed it — see attachContactToEscalation), but
    // when it's already on file this turn, no reason to wait.
    contactPhone?: string;
    contactEmail?: string;
  }): Promise<void> {
    const company = await this.prisma.company.findUnique({ where: { id: params.companyId } });

    const hasContact = Boolean(params.contactPhone || params.contactEmail);
    const escalation = await this.prisma.escalation.create({
      data: {
        botId: params.botId,
        companyId: params.companyId,
        dialogId: params.dialogId,
        reason: params.reason,
        question: params.question,
        botReply: params.botReply,
        visitorQuestion: params.visitorQuestion,
        contactPhone: params.contactPhone,
        contactEmail: params.contactEmail,
        contactSentAt: hasContact ? new Date() : null,
      },
    });

    if (!company?.telegramChatId) return;

    const reasonLabel = params.reason === 'dissatisfaction' ? 'Клиент недоволен ответом' : 'Бот не смог ответить';
    const lines = [`🔔 ${reasonLabel} — бот «${params.botName}»`, ''];
    if (params.reason === 'dissatisfaction') {
      // Three distinct, clearly labeled facts instead of one ambiguous
      // "Вопрос:" line — otherwise there's no way to tell what the customer
      // actually asked before deciding how to fix the answer.
      lines.push(`Вопрос клиента: ${params.visitorQuestion ?? 'не удалось определить'}`);
      lines.push('', `Ответ бота: ${params.botReply ?? '—'}`);
      lines.push('', `Что не устроило: ${params.question}`);
    } else {
      lines.push(`Вопрос: ${params.question}`);
      if (params.botReply) {
        lines.push('', `Ответ бота: ${params.botReply}`);
      }
    }
    const contactLine = [params.contactPhone, params.contactEmail].filter(Boolean).join(', ');
    if (contactLine) {
      lines.push('', `Контакт клиента: ${contactLine}`, 'Свяжитесь с ним напрямую, чтобы ответить именно ему.');
    }
    // A confirmed Reply now does both: delivered straight into this same
    // visitor's chat if their session is still on record (see
    // handleReplyAnswer's confirm branch — MessagesService.append), AND
    // mirrored into the knowledge base for future similar questions (see
    // CabinetService.verifyEscalation). If the visitor's tab is closed by
    // the time this lands, the contact captured above (if any) is still the
    // only way to reach them proactively — the chat delivery only helps
    // while their own session is still open or they come back to it.
    lines.push('', 'Ответьте на это сообщение (Reply) — я отправлю ваш ответ клиенту в чат и учту его на будущее.');

    const messageId = await this.sendMessage(company.telegramChatId, lines.join('\n'));
    if (messageId) {
      await this.prisma.escalation.update({ where: { id: escalation.id }, data: { telegramMessageId: messageId } });
    }
  }

  /**
   * A visitor whose question the bot couldn't answer usually only leaves a
   * phone/email a turn or two AFTER the escalation already went out (see the
   * persona-rule change asking for contact right in the "I don't know"
   * reply) — this enriches that already-sent Telegram message with a
   * threaded reply once it shows up, so the owner can reach the customer
   * directly instead of the contact sitting in the Lead row with no visible
   * link back to the specific question it was meant to unblock.
   */
  async attachContactToEscalation(dialogId: string, contact: { phone?: string; email?: string }): Promise<void> {
    const phone = contact.phone?.trim();
    const email = contact.email?.trim();
    if (!phone && !email) return;

    const pending = await this.prisma.escalation.findMany({
      where: { dialogId, reason: 'unanswered', contactSentAt: null },
    });
    if (pending.length === 0) return;

    const contactLine = [phone, email].filter(Boolean).join(', ');

    for (const escalation of pending) {
      await this.prisma.escalation.update({
        where: { id: escalation.id },
        data: { contactPhone: phone, contactEmail: email, contactSentAt: new Date() },
      });

      if (!escalation.telegramMessageId) continue;
      const company = await this.prisma.company.findUnique({ where: { id: escalation.companyId } });
      if (!company?.telegramChatId) continue;

      await this.sendMessage(
        company.telegramChatId,
        `📇 Клиент оставил контакт по вопросу выше: ${contactLine}. Свяжитесь с ним напрямую и ответьте — а мне (Reply на исходное сообщение) сообщите ответ, чтобы я знал(а) его на будущее.`,
        escalation.telegramMessageId,
      );
    }
  }

  /**
   * Platform-level abuse/integrity signal (domain mismatch, domain already
   * claimed by another bot, and whatever else gets hooked up here later) —
   * never sent to the client company that triggered it, always to the
   * platform's own Telegram (same connection Sergey already uses for
   * "Умный Чат" itself). A silent no-op if that's not connected yet, same as
   * every other Telegram send in this service — never blocks the actual
   * visitor-facing flow that triggered the check.
   */
  async alertPlatformAdmin(text: string): Promise<void> {
    const company = await this.prisma.company.findUnique({ where: { id: PLATFORM_COMPANY_ID } });
    if (!company?.telegramChatId) return;
    await this.sendMessage(company.telegramChatId, `⚠️ ${text}`);
  }

  // Separate opt-in from escalations — same connected chat (Company only
  // ever has one), but an owner may want escalations without a lead-per-
  // message firehose, or vice versa. Silently no-ops when either the toggle
  // is off or Telegram was never connected, same convention as CRM push.
  async notifyNewLead(companyId: string, summary: string): Promise<void> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company?.telegramChatId || !company.notifyLeadsViaTelegram) return;
    await this.sendMessage(company.telegramChatId, `🆕 Новая заявка\n${summary}`);
  }

  /** Entry point for the webhook controller. */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update?.message;
    if (!message) return;

    const chatId = message.chat?.id !== undefined ? String(message.chat.id) : '';
    const text = message.text ?? '';
    if (!chatId) return;

    if (text.startsWith('/start')) {
      await this.handleStart(chatId, text);
      return;
    }

    const replyToId =
      message.reply_to_message?.message_id !== undefined ? String(message.reply_to_message.message_id) : null;
    if (!replyToId || !text) return;
    await this.handleReplyAnswer(chatId, replyToId, text);
  }

  private async handleStart(chatId: string, text: string): Promise<void> {
    const token = text.split(' ')[1]?.trim();
    if (!token) {
      await this.sendMessage(chatId, 'Чтобы подключить уведомления, перейдите по ссылке из личного кабинета.');
      return;
    }
    const company = await this.prisma.company.findUnique({ where: { telegramConnectToken: token } });
    if (!company) {
      await this.sendMessage(chatId, 'Ссылка недействительна. Возьмите новую в личном кабинете.');
      return;
    }
    await this.prisma.company.update({ where: { id: company.id }, data: { telegramChatId: chatId } });
    await this.sendMessage(
      chatId,
      `Подключено! Сюда будут приходить вопросы, на которые бот компании «${company.name}» не смог ` +
        'ответить, а также случаи, когда клиент явно недоволен ответом. Ответьте (Reply) на такое ' +
        'сообщение своим ответом — после подтверждения я отправлю его клиенту в чат (если сессия ещё ' +
        'открыта) и учту для похожих вопросов в будущем. Если бот успел взять ' +
        'контакт клиента, он придёт следом отдельным сообщением — так можно связаться с клиентом напрямую.',
    );
  }

  /**
   * Never forwards a human's raw Telegram reply straight into the bot's
   * knowledge as-is. First reply to an escalation (or to the confirmation
   * message below) becomes a DRAFT: AI-polished for grammar/style (facts
   * untouched) and sent back for the human to confirm — same place they
   * proposed it. Only a short confirm ("да"/"ок"/…) actually finalizes it as
   * `answer`. Any other reply while a draft is pending is treated as a
   * correction and re-polished, so the loop self-corrects instead of ever
   * silently shipping a typo-ridden or wrong-toned first draft.
   */
  private async handleReplyAnswer(chatId: string, replyToId: string, text: string): Promise<void> {
    const escalation = await this.prisma.escalation.findFirst({
      where: { OR: [{ telegramMessageId: replyToId }, { draftMessageId: replyToId }] },
    });
    if (!escalation) {
      await this.sendMessage(
        chatId,
        'Не нашёл, на какой вопрос это ответ — используйте Reply на сообщение с вопросом.',
      );
      return;
    }
    if (escalation.answeredAt) {
      await this.sendMessage(chatId, 'На этот вопрос уже отвечали, спасибо.');
      return;
    }

    if (escalation.draftAnswer && CONFIRM_PATTERN.test(text.trim())) {
      // answeredAt: null in the WHERE, not a separate read-then-write (the
      // findFirst + escalation.answeredAt check above is just an early exit
      // for the common case) — this is what actually makes the check-and-set
      // atomic. Without it, this write and CabinetService.confirmEscalationAnswer's
      // own atomic updateMany race the SAME row from two different code paths
      // (owner confirms in Telegram and in the cabinet UI at nearly the same
      // moment) and could both pass their own "not yet answered" check before
      // either commits — WHERE answeredAt IS NULL on both sides is what makes
      // Postgres itself serialize them, whichever writer loses this just no-ops.
      const { count } = await this.prisma.escalation.updateMany({
        where: { id: escalation.id, answeredAt: null },
        data: { answer: escalation.draftAnswer, answeredAt: new Date(), draftAnswer: null, draftMessageId: null },
      });
      if (count === 0) {
        await this.sendMessage(chatId, 'На этот вопрос уже ответили (например, из личного кабинета) — спасибо.');
        return;
      }
      // Delivered into the SAME chat session the visitor asked in (if it's
      // still on record — see Escalation.dialogId) on top of the existing
      // knowledge-base mirror (CabinetService.verifyEscalation) that only
      // helps FUTURE visitors. A visitor whose tab is still open picks it up
      // via the widget's poll (see WidgetService.getNewMessages); one who's
      // gone finds it waiting if they return on the same session (localStorage-
      // persisted, see widget.js), same as any other chat history.
      var deliveredToChat = false;
      if (escalation.dialogId) {
        await this.messages.append(escalation.dialogId, MessageRole.assistant, escalation.draftAnswer);
        deliveredToChat = true;
      }
      await this.sendMessage(
        chatId,
        deliveredToChat
          ? '✅ Принято — отправил ответ клиенту в чат и учту его для похожих вопросов в будущем.'
          : '✅ Принято — эта переписка уже закрыта, но бот учтёт ответ для похожих вопросов в будущем.',
      );
      return;
    }

    const { text: polished, tokens } = await this.yandexGpt.polishAnswer(text);
    if (tokens > 0) {
      await this.prisma.aiUsageEvent.create({
        data: {
          botId: escalation.botId,
          companyId: escalation.companyId,
          kind: 'generation',
          tokens,
          estimatedCostRub: this.yandexGpt.estimateCompletionCostRub(tokens),
        },
      });
    }

    const draftMessageId = await this.sendMessage(
      chatId,
      `Вот исправленный вариант:\n\n${polished}\n\nВсё верно — отправить? Ответьте «да». Если что-то не так, ` +
        'пришлите исправленный текст ещё раз.',
    );
    await this.prisma.escalation.update({
      where: { id: escalation.id },
      data: { draftAnswer: polished, draftMessageId: draftMessageId ?? escalation.draftMessageId },
    });
  }
}
