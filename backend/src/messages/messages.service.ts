import { Injectable } from '@nestjs/common';
import { MessageRole } from '@prisma/client';
import { PrismaService } from '../prisma.service';

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  listByDialog(dialogId: string) {
    return this.prisma.message.findMany({
      where: { dialogId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Backs the widget's out-of-band poll (see WidgetService.getNewMessages) — messages inserted since the visitor's own tab last rendered anything. */
  listNewerThan(dialogId: string, after: Date) {
    return this.prisma.message.findMany({
      where: { dialogId, createdAt: { gt: after } },
      orderBy: { createdAt: 'asc' },
    });
  }

  append(
    dialogId: string,
    role: MessageRole,
    content: string,
    buttons?: string[],
    attachment?: { url: string; name: string | null; mimeType: string | null },
  ) {
    return this.prisma.message.create({
      data: {
        dialogId,
        role,
        content,
        buttons: buttons && buttons.length > 0 ? buttons : undefined,
        attachmentUrl: attachment?.url,
        attachmentName: attachment?.name ?? undefined,
        attachmentMimeType: attachment?.mimeType ?? undefined,
      },
    });
  }

  /**
   * Public 👎 on test-chat.html (a link the owner can hand to anyone, e.g. a
   * friend testing without cabinet access) — flags the message AND creates
   * an Escalation (reason: 'disliked') so it surfaces in "Требует внимания"
   * instead of sitting invisible until the owner happens to check a separate
   * queue. A tester like this only ever flags, never writes a correction —
   * the owner does that later from the escalation's own dialog view (see
   * DislikesService.resolve). Scoped to (botId, sessionId) rather than
   * trusting a bare messageId: without that check, anyone could flag an
   * arbitrary message from a dialog that isn't even theirs. Silently no-ops
   * if the message doesn't belong to this bot+session dialog, or isn't an
   * assistant message — same "fail closed, don't leak which ids exist"
   * reasoning as the rest of the public widget API.
   */
  async markDisliked(botId: string, sessionId: string, messageId: string): Promise<{ ok: boolean }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { dialog: { include: { bot: true } } },
    });
    if (!message || message.role !== 'assistant' || message.dialog.botId !== botId || message.dialog.sessionId !== sessionId) {
      return { ok: false };
    }
    if (!message.dislikedAt) {
      await this.prisma.message.update({ where: { id: messageId }, data: { dislikedAt: new Date() } });

      const precedingVisitor = await this.prisma.message.findFirst({
        where: { dialogId: message.dialogId, role: 'visitor', createdAt: { lt: message.createdAt } },
        orderBy: { createdAt: 'desc' },
      });
      await this.prisma.escalation.create({
        data: {
          botId,
          companyId: message.dialog.bot.companyId,
          dialogId: message.dialogId,
          reason: 'disliked',
          question: precedingVisitor?.content ?? 'Тестировщик отметил ответ бота как неудачный',
          visitorQuestion: precedingVisitor?.content ?? null,
          botReply: message.content,
          dislikedMessageId: message.id,
        },
      });
    }
    return { ok: true };
  }

  /**
   * For "Обучение бота"'s review queue. Includes the one visitor message
   * right before each disliked reply (the "situation") — pulled per-row
   * rather than via a single bulk query since dislikes are rare (low
   * volume), and it keeps the query trivial to reason about. Unresolved
   * first, newest first within each group, so the owner sees what still
   * needs attention before older, already-handled history.
   */
  async listDislikedForBot(botId: string) {
    const rows = await this.prisma.message.findMany({
      where: { dialog: { botId }, dislikedAt: { not: null } },
      orderBy: [{ dislikeResolvedAt: 'asc' }, { dislikedAt: 'desc' }],
      include: { dialog: { select: { id: true } } },
    });

    const withContext = [];
    for (const row of rows) {
      const precedingVisitor = await this.prisma.message.findFirst({
        where: { dialogId: row.dialogId, role: 'visitor', createdAt: { lt: row.createdAt } },
        orderBy: { createdAt: 'desc' },
      });
      withContext.push({
        id: row.id,
        dialogId: row.dialogId,
        content: row.content,
        situationContext: precedingVisitor?.content ?? null,
        dislikedAt: row.dislikedAt,
        dislikeNote: row.dislikeNote,
        dislikeResolution: row.dislikeResolution,
        dislikeResolvedAt: row.dislikeResolvedAt,
      });
    }
    return withContext;
  }

  /**
   * Lets a visitor discard their own message after a failed send (the
   * "Удалить" choice next to the retry pill in chat.js). No messageId from
   * the client — a network-level failure means the frontend never gets a
   * response to read one from in the first place, so this works the same
   * way `retry` does: find THE DIALOG'S OWN last message, and only act if
   * it's a visitor message with nothing after it (i.e. genuinely the one
   * that just failed to get a reply). Never touches an answered message or
   * an assistant message.
   */
  async discardLastUnanswered(botId: string, sessionId: string): Promise<{ ok: boolean }> {
    const dialog = await this.prisma.dialog.findFirst({ where: { botId, sessionId } });
    if (!dialog) return { ok: false };
    const lastMessage = await this.prisma.message.findFirst({
      where: { dialogId: dialog.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!lastMessage || lastMessage.role !== 'visitor') return { ok: false };

    await this.prisma.message.delete({ where: { id: lastMessage.id } });
    return { ok: true };
  }

  /**
   * Cabinet-authenticated counterpart to markDisliked (which is scoped to an
   * anonymous public widget session) — lets the owner flag a bad reply from
   * anywhere they can see one in the cabinet (e.g. the "Требует внимания"
   * dialog viewer), not just the test-chat widget. Scoped by companyId via
   * the message's own dialog/bot instead of botId+sessionId.
   */
  async markDislikedByOwner(companyId: string, messageId: string): Promise<{ ok: boolean }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { dialog: { include: { bot: true } } },
    });
    if (!message || message.role !== 'assistant' || message.dialog.bot.companyId !== companyId) {
      return { ok: false };
    }
    if (!message.dislikedAt) {
      await this.prisma.message.update({ where: { id: messageId }, data: { dislikedAt: new Date() } });
    }
    return { ok: true };
  }

  async findDislikedMessage(companyId: string, messageId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { dialog: { include: { bot: true } } },
    });
    if (!message || !message.dislikedAt || message.dialog.bot.companyId !== companyId) return null;
    return message;
  }

  async resolveDislike(messageId: string, note: string, resolution: string): Promise<void> {
    await this.prisma.message.update({
      where: { id: messageId },
      data: { dislikeNote: note, dislikeResolution: resolution, dislikeResolvedAt: new Date() },
    });
  }
}
