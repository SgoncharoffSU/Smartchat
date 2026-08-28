import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { MessagesService } from '../messages/messages.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { YandexGptService } from '../yandex-gpt/yandex-gpt.service';
import { WidgetService } from '../widget/widget.service';

@Injectable()
export class DislikesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessagesService,
    private readonly knowledge: KnowledgeService,
    private readonly yandexGpt: YandexGptService,
    private readonly widget: WidgetService,
  ) {}

  /**
   * Lets the owner flag a bad reply from anywhere it's shown in the cabinet
   * (e.g. the "Требует внимания" dialog viewer), not just the test-chat
   * widget's own 👎 button.
   */
  async markDisliked(companyId: string, messageId: string) {
    return this.messages.markDislikedByOwner(companyId, messageId);
  }

  /**
   * Regenerates a candidate reply using the owner's note WITHOUT persisting
   * anything — lets them see (and, via repeated calls with a refined note,
   * keep refining) whether the fix actually reads better before it's
   * permanently remembered as a KnowledgeEntry via resolve() below. Stateless
   * by design: each call is independent, driven only by whatever note text
   * is currently in the box, so "try again" is just calling this again.
   */
  async preview(companyId: string, messageId: string, note: string) {
    const trimmedNote = note.trim();
    if (!trimmedNote) throw new BadRequestException('Note cannot be empty');
    return this.widget.previewCorrectedReply(companyId, messageId, trimmedNote);
  }

  /** Same "explicit botId, else this company's oldest bot" convention as KnowledgeService.findOwnedBot. */
  private async findOwnedBot(companyId: string, botId?: string) {
    const bot = botId
      ? await this.prisma.bot.findFirst({ where: { id: botId, companyId } })
      : await this.prisma.bot.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    if (!bot) throw new NotFoundException('No bot found for this company');
    return bot;
  }

  async list(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    return this.messages.listDislikedForBot(bot.id);
  }

  /**
   * The owner's note on a flagged reply always has the exact situation
   * already pinned down (unlike free text typed cold into "Обучение и
   * настройка"), so classifyDislikeNote decides where it actually belongs —
   * the owner never has to know the difference between "инструкция" and
   * "коррекция" to use this, and never sees a "limit reached" message
   * either (see KnowledgeService.createInstruction) — this always succeeds.
   */
  async resolve(companyId: string, messageId: string, note: string) {
    const trimmedNote = note.trim();
    if (!trimmedNote) throw new BadRequestException('Note cannot be empty');

    const message = await this.messages.findDislikedMessage(companyId, messageId);
    if (!message) throw new NotFoundException('Disliked message not found');

    const situationContext = await this.prisma.message.findFirst({
      where: { dialogId: message.dialogId, role: 'visitor', createdAt: { lt: message.createdAt } },
      orderBy: { createdAt: 'desc' },
    });

    // A bare "Да" or "Я передумал" only means something once you know what
    // it's answering — pull in the bot's own message right before that
    // visitor reply too, so a correction is keyed on the full exchange, not
    // one word that recurs in a million unrelated situations. Only affects
    // the correction path below (see KnowledgeService.getCorrectionsForPrompt,
    // which matches on this same combined shape at retrieval time) —
    // classifyDislikeNote gets the richer context too since more context
    // can only help it classify correctly, but the 'fact' branch below keeps
    // the bare visitor text: a fact is meant to be recognized again
    // regardless of what led to it, unlike a one-off correction.
    const precedingBotMessage = situationContext
      ? await this.prisma.message.findFirst({
          where: { dialogId: message.dialogId, role: 'assistant', createdAt: { lt: situationContext.createdAt } },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const situationForCorrection = [precedingBotMessage?.content, situationContext?.content].filter(Boolean).join('\n');

    const classification = await this.yandexGpt.classifyDislikeNote(
      situationForCorrection || situationContext?.content || '',
      message.content,
      trimmedNote,
    );

    const botId = message.dialog.botId;

    if (classification.type === 'fact') {
      await this.knowledge.createForBot(botId, companyId, situationContext?.content ?? null, trimmedNote, 'test_chat', {
        moderationStatus: 'approved',
      });
    } else if (classification.type === 'instruction') {
      await this.knowledge.createInstruction(companyId, trimmedNote, botId);
    } else {
      await this.knowledge.createCorrection(companyId, situationForCorrection, message.content, trimmedNote, botId);
    }

    await this.messages.resolveDislike(messageId, trimmedNote, classification.type);

    // If this dislike also has a linked Escalation (see
    // MessagesService.markDisliked — only the public test-chat 👎 creates
    // one), close it out too so it drops off "Требует внимания". Goes
    // straight to verified rather than through the pending-Telegram-answer
    // step: the owner already saw a live preview of this exact text before
    // confirming, same bar CabinetService.verifyEscalation exists to enforce
    // for a bare Telegram reply. Deliberately NOT calling verifyEscalation
    // itself — that mirrors the answer into KnowledgeEntry a second time,
    // and the correction/fact/instruction above already did that.
    // Fetched before the update so we still know each one's dialogId —
    // updateMany itself doesn't return rows. Same live-delivery treatment as
    // TelegramService.handleReplyAnswer's confirm branch: the owner already
    // saw a preview of this exact text, so it's just as safe to drop
    // straight into the visitor's own chat (if that session is still on
    // record) as it is to mirror into the knowledge base above.
    const linkedEscalations = await this.prisma.escalation.findMany({ where: { dislikedMessageId: messageId } });
    await this.prisma.escalation.updateMany({
      where: { dislikedMessageId: messageId },
      data: { answer: trimmedNote, answeredAt: new Date(), verifiedAt: new Date() },
    });
    for (const esc of linkedEscalations) {
      if (esc.dialogId) await this.messages.append(esc.dialogId, MessageRole.assistant, trimmedNote);
    }

    return { ok: true, resolution: classification.type };
  }
}
