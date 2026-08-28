import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AiUsageKind, KnowledgeModerationStatus, KnowledgeSource } from '@prisma/client';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma.service';
import { SiteAnalysisService } from '../site-analysis/site-analysis.service';
import { EmbeddingsService, EmbeddingResult } from '../yandex-gpt/embeddings.service';
import { YandexGptService } from '../yandex-gpt/yandex-gpt.service';
import { UPLOADS_DIR } from '../uploads-path';

const SEARCH_TOP_K = 5;
// Below this cosine similarity, a match is treated as noise rather than
// relevant — falls back to recency instead of forcing in a poor match.
const SEARCH_MIN_SIMILARITY = 0.3;
// Calibrated live against real siberiaa.ru re-scan data: an exact repeat
// scores 1.0, reworded/reordered duplicates score 0.85-0.99, genuinely
// different facts score ~0.55-0.60 — 0.8 sits with comfortable margin on
// both sides of that gap. Used only for the create-time dedup below: being
// wrong here just means skipping an entry that would've been redundant
// anyway — a cheap mistake either direction.
const DUPLICATE_FACT_SIMILARITY = 0.8;
// setModerationStatus's auto-reject needs a much stricter bar than the
// constant above: it silently rejects an EXISTING, not-yet-reviewed entry as
// a side effect of approving a different one — wrong here means real
// information quietly disappears from the moderation queue, never shown to
// the owner at all. Tested live: "доставка по городу бесплатно" vs "доставка
// в область — 500 ₽" (genuinely different facts, same topic) scored 0.94 —
// close enough to true reworded duplicates (0.98-1.0) that 0.8 would have
// silently rejected a real, different fact. 0.97 leaves safe margin below
// that while still catching near-identical rewordings, without requiring
// every single word to match.
const MODERATION_AUTO_REJECT_SIMILARITY = 0.97;
// A hard ceiling so one enthusiastic training session can't unboundedly
// bloat every future prompt with instructions (every one of these gets
// injected into EVERY reply, unlike facts — see getInstructionsForPrompt).
// Raised from the original 15 once it became clear that's tight for an
// actively-tested bot; still bounded, but hitting even this is now handled
// by consolidateInstructions rather than ever surfacing a "limit reached"
// message to the owner — see createInstruction.
const MAX_INSTRUCTION_COUNT = 25;
// Deliberately small — a correction is a targeted nudge for one recurring
// situation, not a knowledge dump; showing too many at once would bury the
// one that's actually relevant among near-misses.
const CORRECTIONS_TOP_K = 2;
// Higher than SEARCH_MIN_SIMILARITY above — measured live on the self-sell
// demo bot (a narrow, self-referential "let's build you a bot" topic, so
// almost every message shares vocabulary with almost every correction):
// even with the situation combining the bot's preceding message + the
// visitor's reply (not just the reply alone, see getCorrectionsForPrompt),
// a correction from a GENUINELY different exchange still scored 0.32-0.42
// against unrelated queries, while the real match scored 0.41-0.49 — real
// overlap, no clean cutoff exists. A wrong correction actively pushes the
// model toward repeating a bad reply rather than just being unhelpful
// filler (see getCorrectionsForPrompt's own comment on why there's no
// recency fallback here), so this leans toward under-matching over
// over-matching. Not a full guarantee on its own — see createCorrection's
// pending-by-default moderation status, the actual backstop for the cases
// this threshold still lets through.
const CORRECTIONS_MIN_SIMILARITY = 0.4;

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAnalysis: SiteAnalysisService,
    private readonly embeddings: EmbeddingsService,
    private readonly yandexGpt: YandexGptService,
  ) {}

  /**
   * Every bot-scoped method below takes an optional botId: explicit once the
   * cabinet's bot switcher picked one, falling back to "this company's
   * oldest bot" when omitted — every call site written before multi-bot
   * existed never sends one, and every company had exactly one bot until
   * now, so this keeps them working unchanged.
   */
  private async findOwnedBot(companyId: string, botId?: string) {
    const bot = botId
      ? await this.prisma.bot.findFirst({ where: { id: botId, companyId } })
      : await this.prisma.bot.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    if (!bot) throw new NotFoundException('No bot found for this company');
    return bot;
  }

  async list(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    return this.prisma.knowledgeEntry.findMany({ where: { botId: bot.id }, orderBy: { createdAt: 'desc' } });
  }

  // Flat, owner-defined groups for the "База знаний" article view, scoped per
  // bot — each bot has its own knowledge base (different products/skills
  // even within the same company), so one bot's categories never bleed into
  // another's. Entries with no category render under the built-in
  // "Вопрос/Ответ" bucket instead (categoryId: null).
  async listCategories(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    return this.prisma.knowledgeCategory.findMany({ where: { botId: bot.id }, orderBy: { order: 'asc' } });
  }

  async createCategory(companyId: string, name: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('Category name is required');
    const last = await this.prisma.knowledgeCategory.findFirst({ where: { botId: bot.id }, orderBy: { order: 'desc' } });
    return this.prisma.knowledgeCategory.create({
      data: { companyId, botId: bot.id, name: trimmed, order: (last?.order ?? -1) + 1 },
    });
  }

  async deleteCategory(companyId: string, id: string) {
    const category = await this.prisma.knowledgeCategory.findUnique({ where: { id } });
    if (!category || category.companyId !== companyId) throw new NotFoundException('Category not found');
    // Entries fall back to the "Вопрос/Ответ" bucket (categoryId: null via
    // onDelete: SetNull) rather than being deleted along with their category.
    await this.prisma.knowledgeCategory.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Used from server-side flows (Telegram verify, test-chat coach, bulk-text
   * structuring) that already know the bot. moderationStatus, unless given
   * explicitly, defaults by source: site-scraped text starts "pending"
   * (sites go stale — never trusted straight into the live bot without a
   * human glancing at it first); everything else is the owner's own direct
   * input in the moment, so it starts "approved".
   */
  async createForBot(
    botId: string,
    companyId: string,
    question: string | null,
    answer: string,
    source: KnowledgeSource,
    options?: {
      categoryId?: string | null;
      moderationStatus?: KnowledgeModerationStatus;
      // Pass an already-computed embedding to skip re-embedding (the
      // site-rescan dedup path below needs the vector BEFORE deciding
      // whether to create the row at all) — undefined means "compute it
      // here as usual", null means "already tried and it failed, don't retry".
      embedding?: EmbeddingResult | null;
      // Only meaningful for source: 'correction' — the bad reply this entry
      // corrects, see createCorrection.
      badExample?: string | null;
      // A file already saved to disk (see KnowledgeService.createFileEntry)
      // — fileUrl is the full public URL the model is allowed to hand back
      // verbatim as StructuredReply.attachmentUrl (see widget.service.ts).
      fileUrl?: string;
      fileName?: string;
      fileMimeType?: string;
    },
  ) {
    const moderationStatus = options?.moderationStatus ?? (source === 'site' ? 'pending' : 'approved');
    const entry = await this.prisma.knowledgeEntry.create({
      data: {
        botId,
        companyId,
        question: question?.trim() || null,
        answer: answer.trim(),
        badExample: options?.badExample?.trim() || null,
        source,
        moderationStatus,
        categoryId: options?.categoryId ?? null,
        fileUrl: options?.fileUrl ?? null,
        fileName: options?.fileName ?? null,
        fileMimeType: options?.fileMimeType ?? null,
      },
    });

    // Fire-and-forget-ish but awaited: KB writes are low-frequency (owner
    // actions, verified escalations), so the extra latency is fine, and
    // awaiting means the entry is immediately searchable rather than only
    // after some later backfill pass.
    let result = options?.embedding;
    if (result === undefined) {
      const embedText = entry.question ? `${entry.question}\n${entry.answer}` : entry.answer;
      result = await this.embeddings.embedDocument(embedText);
    }
    if (result) {
      await this.prisma.knowledgeEntry.update({ where: { id: entry.id }, data: { embedding: result.vector as any } });
      await this.logUsage(botId, companyId, 'embedding', result.tokens);
    } else {
      this.logger.warn(`Embedding failed for KnowledgeEntry ${entry.id} — will fall back to recency until backfilled`);
    }

    return entry;
  }

  /**
   * A file (contract, product photo, spec sheet) the owner attaches to the
   * knowledge base — `description` is what actually gets embedded/matched
   * against a visitor's question (the file itself obviously isn't), so it
   * needs to say what the file IS and when it's relevant, not just repeat
   * the filename. See widget.service.ts's "Файлы из базы знаний" prompt
   * block and StructuredReply.attachmentUrl for how this reaches the model.
   */
  async createFileEntry(
    companyId: string,
    title: string,
    description: string,
    fileUrl: string,
    fileName: string,
    fileMimeType: string,
    categoryId?: string | null,
    botId?: string,
  ) {
    const bot = await this.findOwnedBot(companyId, botId);
    if (!title.trim()) throw new BadRequestException('Title is required');
    return this.createForBot(bot.id, companyId, title, description.trim() || title, 'manual', {
      categoryId,
      moderationStatus: 'approved',
      fileUrl,
      fileName,
      fileMimeType,
    });
  }

  /** A single owner-authored article (title + body) — no AI text-splitting, unlike createFromBulkText. */
  async createArticle(companyId: string, title: string, body: string, categoryId?: string | null, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    if (!title.trim() || !body.trim()) throw new BadRequestException('Title and body are both required');
    return this.createForBot(bot.id, companyId, title, body, 'manual', { categoryId, moderationStatus: 'approved' });
  }

  /**
   * A behavioral instruction ("Дать совет" button, or classifyTrainingInput
   * deciding free text is a command rather than a fact) — used to live only
   * as raw text appended to Bot.systemPrompt (see the old
   * BotsService.addCoachingAdvice), invisible anywhere in the cabinet and
   * only removable by re-parsing that string. Now a real KnowledgeEntry row:
   * listable, editable, individually deletable, same as any KB article —
   * just consumed differently (see getInstructionsForPrompt: ALWAYS
   * injected, never similarity-retrieved like a fact would be).
   * Approved immediately — same reasoning as createArticle: the owner's own
   * direct input in the moment, not something scraped that could be stale.
   * Deduped against existing instructions for this bot so repeating (or
   * near-repeating) the same guidance doesn't pile up duplicate directives.
   */
  async createInstruction(
    companyId: string,
    text: string,
    botId?: string,
  ): Promise<{ ok: boolean; reason?: string; count?: number }> {
    const bot = await this.findOwnedBot(companyId, botId);
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: 'empty' };

    const existing = await this.prisma.knowledgeEntry.findMany({
      where: { botId: bot.id, source: 'instruction' },
      select: { id: true, answer: true, embedding: true },
    });

    const embedResult = await this.embeddings.embedDocument(trimmed);
    if (embedResult) {
      const isDuplicate = existing
        .filter((e) => Array.isArray(e.embedding))
        .some((e) => this.embeddings.cosineSimilarity(embedResult.vector, e.embedding as unknown as number[]) >= DUPLICATE_FACT_SIMILARITY);
      if (isDuplicate) return { ok: true, count: existing.length };
    }

    // No "limit reached" ever reaches the owner — see consolidateInstructions
    // for why this asks the model to merge/deduplicate rather than either
    // rejecting outright or silently downgrading into a differently-scoped
    // mechanism that might not actually enforce the same thing.
    if (existing.length >= MAX_INSTRUCTION_COUNT) {
      const merged = await this.yandexGpt.consolidateInstructions(
        existing.map((e) => e.answer),
        trimmed,
        MAX_INSTRUCTION_COUNT,
      );
      await this.prisma.knowledgeEntry.deleteMany({ where: { id: { in: existing.map((e) => e.id) } } });
      for (const instructionText of merged) {
        const vector = await this.embeddings.embedDocument(instructionText);
        await this.createForBot(bot.id, companyId, null, instructionText, 'instruction', {
          moderationStatus: 'approved',
          embedding: vector ?? null,
        });
      }
      return { ok: true, count: merged.length };
    }

    await this.createForBot(bot.id, companyId, null, trimmed, 'instruction', {
      moderationStatus: 'approved',
      embedding: embedResult ?? null,
    });
    return { ok: true, count: existing.length + 1 };
  }

  /**
   * Unlike getForPrompt (top-K by similarity to the visitor's CURRENT
   * message), instructions apply to every single turn regardless of what
   * was just said — "never mention competitors" doesn't stop being in
   * effect just because this message wasn't semantically about competitors.
   */
  async getInstructionsForPrompt(botId: string): Promise<string[]> {
    const rows = await this.prisma.knowledgeEntry.findMany({
      where: { botId, source: 'instruction', moderationStatus: 'approved' },
      orderBy: { createdAt: 'asc' },
      select: { answer: true },
    });
    return rows.map((r) => r.answer);
  }

  /**
   * Owner flags a specific bad reply (in the "Тестирование" pane) and
   * supplies what should have been said instead — stored as a (situation,
   * bad, good) triple rather than an abstract instruction. A worked example
   * is what the model actually follows reliably; an instruction just
   * competes for one of only MAX_INSTRUCTION_COUNT always-on slots
   * regardless of whether this specific turn is even related. Embedded on
   * the situation text (what the visitor said right before the bad reply),
   * so it's retrieved only when a similar situation comes up again — see
   * getCorrectionsForPrompt. Deduped the same way instructions are, so
   * flagging the same bad pattern twice doesn't pile up duplicate examples.
   */
  async createCorrection(
    companyId: string,
    situationContext: string,
    badReply: string,
    goodReply: string,
    botId?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const bot = await this.findOwnedBot(companyId, botId);
    const trimmedGood = goodReply.trim();
    if (!trimmedGood) return { ok: false, reason: 'empty' };
    const trimmedContext = situationContext.trim();
    const trimmedBad = badReply.trim();

    const embedResult = await this.embeddings.embedDocument(trimmedContext || trimmedBad || trimmedGood);
    if (embedResult) {
      const existing = await this.prisma.knowledgeEntry.findMany({
        where: { botId: bot.id, source: 'correction' },
        select: { embedding: true },
      });
      const isDuplicate = existing
        .filter((e) => Array.isArray(e.embedding))
        .some((e) => this.embeddings.cosineSimilarity(embedResult.vector, e.embedding as unknown as number[]) >= DUPLICATE_FACT_SIMILARITY);
      if (isDuplicate) return { ok: true };
    }

    // Starts on moderation, not live immediately — unlike a fact, a wrong or
    // too-generic correction actively pushes the model toward a bad reply
    // (rather than just being unhelpful filler), and the caller's
    // situationContext quality varies a lot (a bare "да" is a valid but
    // dangerous value here — see callers). Same bar as site-scraped facts:
    // one human glance before it goes live.
    await this.createForBot(bot.id, companyId, trimmedContext || null, trimmedGood, 'correction', {
      moderationStatus: 'pending',
      embedding: embedResult ?? null,
      badExample: trimmedBad || null,
    });
    return { ok: true };
  }

  /**
   * Same embedding-similarity retrieval as getForPrompt, but no recency
   * fallback when nothing scores as relevant — an unrelated correction
   * ("don't say X, say Y") injected into a totally different conversation
   * reads as confusing noise, not helpful filler the way an unrelated fact
   * might be. Capped at 2: this is a worked-example nudge for a specific
   * recurring situation, not a knowledge dump.
   */
  async getCorrectionsForPrompt(
    botId: string,
    companyId: string,
    queryText: string,
  ): Promise<Array<{ question: string | null; answer: string; badExample: string | null }>> {
    if (!queryText.trim()) return [];

    const rows = await this.prisma.knowledgeEntry.findMany({
      where: { botId, source: 'correction', moderationStatus: 'approved' },
      take: 200,
    });
    const withEmbedding = rows.filter((r) => Array.isArray(r.embedding));
    if (withEmbedding.length === 0) return [];

    const queryResult = await this.embeddings.embedQuery(queryText);
    if (!queryResult) return [];
    await this.logUsage(botId, companyId, 'embedding', queryResult.tokens);

    return withEmbedding
      .map((r) => ({ row: r, score: this.embeddings.cosineSimilarity(queryResult.vector, r.embedding as unknown as number[]) }))
      .filter((r) => r.score >= CORRECTIONS_MIN_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, CORRECTIONS_TOP_K)
      .map((r) => ({ question: r.row.question, answer: r.row.answer, badExample: r.row.badExample }));
  }

  async updateEntry(
    companyId: string,
    id: string,
    updates: { question?: string | null; answer?: string; categoryId?: string | null },
  ) {
    const entry = await this.prisma.knowledgeEntry.findUnique({ where: { id } });
    if (!entry || entry.companyId !== companyId) throw new NotFoundException('Knowledge entry not found');

    const data: { question?: string | null; answer?: string; categoryId?: string | null } = {};
    if (updates.question !== undefined) data.question = updates.question?.trim() || null;
    if (updates.answer !== undefined) {
      if (!updates.answer.trim()) throw new BadRequestException('Answer cannot be empty');
      data.answer = updates.answer.trim();
    }
    if (updates.categoryId !== undefined) data.categoryId = updates.categoryId;

    const updated = await this.prisma.knowledgeEntry.update({ where: { id }, data });

    // Re-embed if the searchable text actually changed — an edit that only
    // moves an entry between categories doesn't need a fresh embedding.
    if (updates.question !== undefined || updates.answer !== undefined) {
      const embedText = updated.question ? `${updated.question}\n${updated.answer}` : updated.answer;
      const result = await this.embeddings.embedDocument(embedText);
      if (result) {
        await this.prisma.knowledgeEntry.update({ where: { id }, data: { embedding: result.vector as any } });
        await this.logUsage(entry.botId, companyId, 'embedding', result.tokens);
      }
    }
    return updated;
  }

  /**
   * Approving an article is the owner's explicit "this is the correct
   * version" — treated as authoritative, not just one opinion among several.
   * So approving one also auto-rejects any OTHER still-pending entries for
   * this bot that say the same thing: otherwise a re-scanned or re-pasted
   * near-duplicate the owner never got to sits in the queue right next to
   * the one they already confirmed, as if it were still an open question.
   * Rejected (not deleted) — reversible from the moderation view if this
   * ever guesses wrong. Only ever acts on PENDING matches; two entries the
   * owner separately approved at different times are both left alone —
   * that was their call each time, not this code's to revisit. Deliberately
   * uses the stricter MODERATION_AUTO_REJECT_SIMILARITY, not the create-time
   * threshold — see that constant's comment for why.
   */
  async setModerationStatus(companyId: string, id: string, status: KnowledgeModerationStatus) {
    const entry = await this.prisma.knowledgeEntry.findUnique({ where: { id } });
    if (!entry || entry.companyId !== companyId) throw new NotFoundException('Knowledge entry not found');
    const updated = await this.prisma.knowledgeEntry.update({ where: { id }, data: { moderationStatus: status } });

    if (status === 'approved' && Array.isArray(updated.embedding)) {
      const vector = updated.embedding as unknown as number[];
      const candidates = await this.prisma.knowledgeEntry.findMany({
        where: { botId: updated.botId, moderationStatus: 'pending', id: { not: updated.id } },
        select: { id: true, embedding: true },
      });
      const duplicateIds = candidates
        .filter((c) => Array.isArray(c.embedding))
        .filter((c) => this.embeddings.cosineSimilarity(vector, c.embedding as unknown as number[]) >= MODERATION_AUTO_REJECT_SIMILARITY)
        .map((c) => c.id);
      if (duplicateIds.length > 0) {
        await this.prisma.knowledgeEntry.updateMany({
          where: { id: { in: duplicateIds } },
          data: { moderationStatus: 'rejected' },
        });
      }
    }

    return updated;
  }

  /**
   * Shared by createFromBulkText and addFromSite: hands raw text to the AI
   * to split into independent question/answer records instead of ever
   * storing one raw wall of text as a single "entry" — a scraped product
   * catalog page or a pasted price list reads as noise to a human moderator
   * otherwise, and the live bot can only ever match a whole blob, not the
   * one fact inside it that actually answers a visitor's question.
   *
   * `dedupeAgainstExisting` (site re-scans only — see addFromSite) compares
   * each freshly-structured candidate's embedding against every existing
   * `source`-tagged entry for this bot before creating it: re-reading an
   * unchanged page used to dump the same facts back into moderation every
   * time, reworded by the AI just enough that they never looked identical.
   * Embeddings, not the AI's own say-so, decide "is this actually new" —
   * threshold calibrated live against real duplicate/non-duplicate pairs
   * (see DUPLICATE_FACT_SIMILARITY).
   */
  private async structureAndStore(
    botId: string,
    companyId: string,
    rawText: string,
    source: KnowledgeSource,
    options?: { dedupeAgainstExisting?: boolean },
  ) {
    const { entries, tokens } = await this.yandexGpt.structureKnowledgeText(rawText);
    await this.logUsage(botId, companyId, 'generation', tokens);

    let knownVectors: number[][] = [];
    if (options?.dedupeAgainstExisting) {
      // Deliberately NOT filtered by `source` — a fact already captured via
      // a site scan is just as much a duplicate when it shows up again in a
      // pasted price list (or vice versa) as a repeat within the same
      // channel. The visitor-facing bot doesn't care which button the owner
      // clicked; neither should the dedup check.
      const existing = await this.prisma.knowledgeEntry.findMany({
        where: { botId },
        select: { embedding: true },
      });
      knownVectors = existing.map((e) => e.embedding as unknown as number[]).filter((v) => Array.isArray(v));
    }

    const created = [];
    let skippedDuplicates = 0;
    for (const entry of entries) {
      const embedText = entry.question ? `${entry.question}\n${entry.answer}` : entry.answer;
      const embedResult = await this.embeddings.embedDocument(embedText);

      if (options?.dedupeAgainstExisting && embedResult) {
        const isDuplicate = knownVectors.some(
          (vec) => this.embeddings.cosineSimilarity(embedResult.vector, vec) >= DUPLICATE_FACT_SIMILARITY,
        );
        if (isDuplicate) {
          skippedDuplicates++;
          continue;
        }
      }

      created.push(await this.createForBot(botId, companyId, entry.question, entry.answer, source, { embedding: embedResult ?? null }));
      // Compare later candidates from this SAME scrape against earlier ones
      // too — two near-identical facts freshly parsed out of one page
      // shouldn't both slip through just because neither existed before.
      if (embedResult) knownVectors.push(embedResult.vector);
    }
    return { ok: true, count: created.length, ids: created.map((c) => c.id), skippedDuplicates };
  }

  /**
   * Fetches a page's visible text — same fetch SiteAnalysisService already
   * does during onboarding, just user-triggered and repeatable for any URL
   * (not only the one from signup) — and structures it into however many KB
   * entries the actual content calls for, same as pasted bulk text. Safe to
   * re-run on the same URL later (e.g. after a price update): already-known
   * facts are skipped rather than re-added as fresh duplicates.
   */
  async addFromSite(companyId: string, url: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);

    // thorough: true — this is an explicit "add site" click, not a live chat
    // turn, so it's fine to always pay for a real headless render instead of
    // only when the plain fetch looks thin (see SiteAnalysisService).
    const text = await this.siteAnalysis.fetchVisibleText(url, { thorough: true });
    if (!text) throw new BadRequestException('Could not read that site — check the link and try again');

    return this.structureAndStore(bot.id, companyId, text, 'site', { dedupeAgainstExisting: true });
  }

  /**
   * "Добавьте информацию" — the owner pastes raw text (price list, FAQ,
   * policies) and we do the question/answer splitting for them via AI
   * instead of asking them to structure it by hand. Each resulting entry
   * gets its own embedding via createForBot, same as any other KB row.
   * Same dedup as addFromSite: pasting an updated version of something
   * already mostly in the KB (a refreshed price list, an FAQ doc with a few
   * new questions added) skips whatever's still accurate instead of piling
   * up near-duplicates of facts that were never wrong to begin with.
   */
  async createFromBulkText(companyId: string, rawText: string, source: KnowledgeSource = 'bulk', botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    if (!rawText || rawText.trim().length < 10) {
      throw new BadRequestException('Paste at least a sentence or two of information');
    }
    return this.structureAndStore(bot.id, companyId, rawText, source, { dedupeAgainstExisting: true });
  }

  async delete(companyId: string, id: string) {
    const entry = await this.prisma.knowledgeEntry.findUnique({ where: { id } });
    if (!entry || entry.companyId !== companyId) throw new NotFoundException('Knowledge entry not found');
    await this.prisma.knowledgeEntry.delete({ where: { id } });
    // Best-effort — an orphaned file on disk is a cheap cost; a delete that
    // fails because the file happened to already be gone is not.
    if (entry.fileUrl) {
      const filename = entry.fileUrl.split('/').pop();
      if (filename) {
        unlink(join(UPLOADS_DIR, filename)).catch((error) => {
          this.logger.warn(`Failed to delete file for KnowledgeEntry ${id}: ${String(error)}`);
        });
      }
    }
    return { ok: true };
  }

  /**
   * Retrieval for the live prompt: embeds the visitor's current message and
   * ranks approved KB entries by cosine similarity against their stored
   * embedding, falling back to plain recency when embeddings aren't
   * available (API error, or entries written before this went live) — never
   * returns nothing just because search itself had a bad moment. Pending/
   * rejected entries never reach this far — an unmoderated site-scraped
   * price is never the thing the bot tells a real visitor.
   */
  async getForPrompt(
    botId: string,
    companyId: string,
    queryText: string,
    limit = SEARCH_TOP_K,
  ): Promise<Array<{ question: string | null; answer: string; fileUrl: string | null; fileName: string | null; fileMimeType: string | null }>> {
    const rows = await this.prisma.knowledgeEntry.findMany({
      where: { botId, moderationStatus: 'approved' },
      orderBy: { createdAt: 'desc' },
      take: 200, // hard ceiling so ranking stays instant even on a large KB
    });
    if (rows.length === 0) return [];

    const toPromptShape = (r: (typeof rows)[number]) => ({
      question: r.question,
      answer: r.answer,
      fileUrl: r.fileUrl,
      fileName: r.fileName,
      fileMimeType: r.fileMimeType,
    });

    // No real visitor question yet (isInit/isReveal turns, before they've
    // typed anything) — skip the embedding call entirely rather than search
    // against an empty string on every single page view.
    if (!queryText.trim()) {
      return rows.slice(0, limit).map(toPromptShape);
    }

    const queryResult = await this.embeddings.embedQuery(queryText);
    if (queryResult) {
      await this.logUsage(botId, companyId, 'embedding', queryResult.tokens);
    }

    const withEmbedding = rows.filter((r) => Array.isArray(r.embedding));
    if (!queryResult || withEmbedding.length === 0) {
      return rows.slice(0, limit).map(toPromptShape);
    }

    const ranked = withEmbedding
      .map((r) => ({ row: r, score: this.embeddings.cosineSimilarity(queryResult.vector, r.embedding as unknown as number[]) }))
      .filter((r) => r.score >= SEARCH_MIN_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (ranked.length === 0) {
      // Nothing scored as genuinely relevant — recency is a better default
      // than silently returning no knowledge at all.
      return rows.slice(0, limit).map(toPromptShape);
    }
    return ranked.map((r) => toPromptShape(r.row));
  }

  /**
   * The same embedding search as getForPrompt, exposed for a human typing
   * into the "База знаний" search box — across every entry regardless of
   * moderation status (so the owner can find and review pending/rejected
   * ones too) and with no recency fallback: an honest "nothing matched" is
   * more useful to a human than a plausible-looking but irrelevant row.
   */
  async searchForCabinet(companyId: string, queryText: string, limit = 20, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    if (!queryText.trim()) return [];

    const rows = await this.prisma.knowledgeEntry.findMany({ where: { botId: bot.id }, take: 500 });
    const withEmbedding = rows.filter((r) => Array.isArray(r.embedding));
    if (withEmbedding.length === 0) return [];

    const queryResult = await this.embeddings.embedQuery(queryText);
    if (!queryResult) return [];
    await this.logUsage(bot.id, companyId, 'embedding', queryResult.tokens);

    return withEmbedding
      .map((r) => ({ row: r, score: this.embeddings.cosineSimilarity(queryResult.vector, r.embedding as unknown as number[]) }))
      .filter((r) => r.score >= SEARCH_MIN_SIMILARITY)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.row);
  }

  private async logUsage(botId: string, companyId: string, kind: AiUsageKind, tokens: number) {
    if (tokens <= 0) return;
    const estimatedCostRub =
      kind === 'embedding' ? this.embeddings.estimateCostRub(tokens) : this.yandexGpt.estimateCompletionCostRub(tokens);
    await this.prisma.aiUsageEvent.create({ data: { botId, companyId, kind, tokens, estimatedCostRub } });
  }

  /**
   * Estimated spend on AI search specifically (embedding calls only) —
   * tokens are real, measured numbers from the API; the ruble figure is an
   * estimate from a rate constant in EmbeddingsService, not pulled from
   * Yandex Cloud's own billing. Good for tracking relative growth; check the
   * Yandex Cloud console for the authoritative charge.
   */
  async getUsageSummary(companyId: string, since?: Date, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);

    const events = await this.prisma.aiUsageEvent.findMany({
      where: { botId: bot.id, kind: 'embedding', ...(since && { createdAt: { gte: since } }) },
    });
    return {
      calls: events.length,
      tokens: events.reduce((sum, e) => sum + e.tokens, 0),
      estimatedCostRub: events.reduce((sum, e) => sum + e.estimatedCostRub, 0),
    };
  }
}
