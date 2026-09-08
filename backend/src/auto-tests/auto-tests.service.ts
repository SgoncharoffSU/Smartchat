import { BadRequestException, HttpException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
import { WidgetService, TRIAL_EXPIRED_REPLY, BILLING_BLOCKED_REPLY } from '../widget/widget.service';
import { YandexGptService } from '../yandex-gpt/yandex-gpt.service';
import { SendMessageDto } from '../widget/dto/send-message.dto';
import { computeBotTestReadiness } from './test-readiness.util';

const MAX_SIMULATED_TURNS = 6;
// WidgetService.sendMessage shares BotRateLimiterService (60 req/min per
// botToken by default) with real site traffic — a batch run sending many
// turns back-to-back could burst past it, get 429'd mid-conversation, and
// have the truncated transcript misgraded as a real bot failure instead of
// "we sent messages too fast" (found via code-review). Real LLM latency
// (2 completions per turn — customer simulation + the bot's own reply)
// already keeps actual throughput well under that limit; this is a modest
// floor on top, not the only thing preventing a burst. Kept short
// deliberately — runAll/runOne execute synchronously within one HTTP
// request (see their own comments), so a long batch already risks a
// reverse-proxy/browser timeout on its own; a background-job version would
// be the real fix if the onboarding scenario set grows large, not a bigger
// number here.
const TURN_SPACING_MS = 600;

type TranscriptMessage = { role: 'visitor' | 'assistant'; content: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * "Автотесты" — the real thing, not the hardcoded "92% · 44 из 48" demo the
 * cabinet used to show (found live, full spec given: "автотесты проверяют
 * работу бота до того, как изменения увидят реальные посетители сайта").
 * Every simulated/replayed turn runs through WidgetService.sendMessage with
 * isPreview: true — the SAME funnel/knowledge/reply pipeline a real visitor
 * hits, just excluded from real analytics/dialog counts (see Dialog's own
 * isPreview comment) — never a separate, drifting reimplementation of "what
 * would the bot say".
 */
@Injectable()
export class AutoTestsService {
  private readonly logger = new Logger(AutoTestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly widget: WidgetService,
    private readonly yandexGpt: YandexGptService,
  ) {}

  /** Same "explicit botId, else this company's oldest bot" convention as KnowledgeService.findOwnedBot. */
  private async findOwnedBot(companyId: string, botId?: string) {
    const bot = botId
      ? await this.prisma.bot.findFirst({ where: { id: botId, companyId } })
      : await this.prisma.bot.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    if (!bot) throw new NotFoundException('No bot found for this company');
    return bot;
  }

  async listScenarios(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    return this.prisma.testScenario.findMany({
      where: { botId: bot.id, archived: false },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createScenario(
    companyId: string,
    input: { title: string; mode: 'simulated' | 'replay'; customerBrief?: string; isCritical?: boolean },
    botId?: string,
  ) {
    const bot = await this.findOwnedBot(companyId, botId);
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new BadRequestException('Title is required');
    return this.prisma.testScenario.create({
      data: {
        botId: bot.id,
        title,
        mode: input.mode === 'replay' ? 'replay' : 'simulated',
        customerBrief: input.customerBrief?.trim() || null,
        isCritical: Boolean(input.isCritical),
      },
    });
  }

  /**
   * "Если в реальном диалоге позже находится новая ошибка, этот диалог
   * можно добавить в автотесты, чтобы она больше не повторялась" — the real
   * visitor's own message texts are replayed verbatim on every future run
   * (mode: replay), not re-improvised, so this is a true regression test:
   * it can never quietly start passing again just from the simulator
   * phrasing something differently.
   */
  async promoteDialog(companyId: string, dialogId: string, title: string, isCritical: boolean) {
    const dialog = await this.prisma.dialog.findUnique({
      where: { id: dialogId },
      include: { bot: true, messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!dialog || dialog.bot.companyId !== companyId) throw new NotFoundException('Dialog not found');
    const visitorLines = dialog.messages.filter((m) => m.role === 'visitor').map((m) => m.content);
    if (visitorLines.length === 0) throw new NotFoundException('This dialog has no visitor messages to replay');
    return this.prisma.testScenario.create({
      data: {
        botId: dialog.botId,
        title: title.trim().slice(0, 200) || 'Из реального диалога',
        mode: 'replay',
        replayMessages: visitorLines,
        sourceDialogId: dialogId,
        isCritical,
      },
    });
  }

  async deleteScenario(companyId: string, scenarioId: string) {
    const scenario = await this.prisma.testScenario.findUnique({ where: { id: scenarioId }, include: { bot: true } });
    if (!scenario || scenario.bot.companyId !== companyId) throw new NotFoundException('Scenario not found');
    await this.prisma.testScenario.update({ where: { id: scenarioId }, data: { archived: true } });
    return { ok: true };
  }

  /**
   * The cabinet's own main-screen summary — each ACTIVE scenario's own most
   * recent result (see computeBotTestReadiness's own comment for why this
   * is not just "the single latest TestRun row": a full batch followed by
   * a couple of single "Повторить тест" retries must show the up-to-date
   * combined picture, not collapse to whichever tiny single-scenario run
   * happened most recently — found via code-review).
   */
  async getLatestRun(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    const readiness = await computeBotTestReadiness(this.prisma, bot.id);
    const totalScenarios = readiness.activeScenarios.length;
    if (!readiness.hasAnyRun) return { run: null, totalScenarios };

    const resultIds = [...readiness.latestByScenario.values()].map((r) => r.id);
    const results = await this.prisma.testResult.findMany({
      where: { id: { in: resultIds } },
      include: { scenario: true },
    });
    const mostRecent = results.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), results[0]?.createdAt ?? new Date(0));

    return {
      totalScenarios,
      run: this.summarizeRun({ id: 'current', startedAt: mostRecent, finishedAt: mostRecent, results }, readiness.readyToPublish),
    };
  }

  async getRun(companyId: string, runId: string) {
    const run = await this.prisma.testRun.findUnique({
      where: { id: runId },
      include: { bot: true, results: { include: { scenario: true } } },
    });
    if (!run || run.bot.companyId !== companyId) throw new NotFoundException('Run not found');
    return this.summarizeRun(run);
  }

  private summarizeRun(
    run: {
      id: string;
      startedAt: Date;
      finishedAt: Date | null;
      results: Array<{
        id: string;
        transcript: unknown;
        verdict: string;
        whatWasWrong: string | null;
        expectedAnswer: string | null;
        scenario: { id: string; title: string; isCritical: boolean };
      }>;
    },
    // Only passed by getLatestRun's synthetic "current status" view, which
    // needs the FULL coverage-aware check from computeBotTestReadiness
    // (matches what actually gates addGreetingVariant — see its own
    // comment). getRun views one specific historical batch in isolation,
    // where "critical === 0 in just this batch" is the correct, simpler
    // reading — it was already run against whatever the scenario set was
    // at the time, nothing to reconcile with the CURRENT set.
    readyToPublishOverride?: boolean,
  ) {
    const passed = run.results.filter((r) => r.verdict === 'pass').length;
    const critical = run.results.filter((r) => r.verdict === 'critical').length;
    const issues = run.results.filter((r) => r.verdict === 'issue').length;
    return {
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      total: run.results.length,
      passed,
      issues,
      critical,
      // "Публикация" здесь — добавление второго+ варианта приветствия
      // (см. CabinetService.addGreetingVariant) — единственное реальное
      // действие в приложении сегодня, которое имеет смысл гейтить (см.
      // TestScenario.isCritical's own comment).
      readyToPublish: readyToPublishOverride ?? critical === 0,
      results: run.results.map((r) => ({
        id: r.id,
        scenarioId: r.scenario.id,
        scenarioTitle: r.scenario.title,
        isCritical: r.scenario.isCritical,
        transcript: r.transcript,
        verdict: r.verdict,
        whatWasWrong: r.whatWasWrong,
        expectedAnswer: r.expectedAnswer,
      })),
    };
  }

  /** "Запустить N тестов" — every non-archived scenario for this bot, in one batch. */
  async runAll(companyId: string, botId?: string) {
    const bot = await this.findOwnedBot(companyId, botId);
    const scenarios = await this.prisma.testScenario.findMany({ where: { botId: bot.id, archived: false } });
    // Guards status.run! below — with zero scenarios, getLatestRun's own
    // hasAnyRun stays false and returns { run: null }, which would
    // otherwise violate this method's non-null return type (found via
    // code-review; the cabinet's own "Запустить" button is already disabled
    // at 0 scenarios, but the API itself must not rely on that alone).
    if (scenarios.length === 0) throw new BadRequestException('No test scenarios to run for this bot');
    const run = await this.prisma.testRun.create({ data: { botId: bot.id } });
    for (const scenario of scenarios) {
      await this.runScenario(bot, run.id, scenario);
    }
    await this.prisma.testRun.update({ where: { id: run.id }, data: { finishedAt: new Date() } });
    // getLatestRun (not getRun(run.id)) — the correct "current status" is
    // every active scenario's own most recent result, which right after a
    // full batch IS this run's own results, but returning it through the
    // same coverage-aware path keeps runAll/runOne/getLatestRun agreeing by
    // construction instead of by coincidence (see getLatestRun's own
    // comment).
    const status = await this.getLatestRun(companyId, bot.id);
    return status.run!;
  }

  /**
   * "Повторить тест" — after a fix, re-run just the one problem scenario
   * instead of the whole batch, without losing the rest of the picture:
   * returns the SAME coverage-aware "current status" runAll does (every
   * active scenario's own most recent result), not a lone one-result batch
   * that would otherwise make the dashboard collapse to "1 из 1 пройден"
   * right after fixing one problem out of several (found via code-review).
   */
  async runOne(companyId: string, scenarioId: string) {
    const scenario = await this.prisma.testScenario.findUnique({ where: { id: scenarioId }, include: { bot: true } });
    if (!scenario || scenario.bot.companyId !== companyId) throw new NotFoundException('Scenario not found');
    const run = await this.prisma.testRun.create({ data: { botId: scenario.botId } });
    await this.runScenario(scenario.bot, run.id, scenario);
    await this.prisma.testRun.update({ where: { id: run.id }, data: { finishedAt: new Date() } });
    const status = await this.getLatestRun(companyId, scenario.botId);
    return status.run!;
  }

  private async runScenario(
    bot: { id: string; widgetToken: string },
    runId: string,
    scenario: { id: string; mode: string; customerBrief: string | null; replayMessages: unknown; isCritical: boolean },
  ) {
    // Own session per scenario per run — an autotest dialog must never
    // continue an EARLIER run's session (stale funnel stage, stale lead
    // state), and isPreview: true keeps it out of the owner's real
    // "Диалоги" list and analytics entirely (see Dialog's own comment).
    const sessionId = `autotest-${scenario.id}-${randomUUID()}`;
    const transcript: TranscriptMessage[] = [];
    let blockedReason: string | null = null;
    // Set only for a TRANSIENT/technical failure mid-conversation (rate
    // limit, network blip) — distinct from blockedReason (a real, stable
    // bot state: trial/billing) so the two get graded differently below.
    let technicalFailure: string | null = null;

    try {
      if (scenario.mode === 'replay') {
        const lines = Array.isArray(scenario.replayMessages) ? (scenario.replayMessages as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        for (const line of lines) {
          blockedReason = await this.sendTurn(bot, sessionId, line, transcript);
          if (blockedReason) break;
        }
      } else {
        for (let i = 0; i < MAX_SIMULATED_TURNS; i++) {
          const { message } = await this.yandexGpt.simulateCustomerTurn(scenario.customerBrief ?? '', transcript);
          if (!message) break;
          blockedReason = await this.sendTurn(bot, sessionId, message, transcript);
          if (blockedReason) break;
        }
      }
    } catch (error) {
      this.logger.warn(`runScenario(${scenario.id}) failed mid-conversation: ${String(error)}`);
      // A rate limit (BotRateLimiterService — shared with real site
      // traffic, see TURN_SPACING_MS's own comment) or any other transient
      // HTTP failure here is an infrastructure hiccup, not the bot
      // answering badly — grading the truncated transcript anyway would
      // misattribute it as a quality issue/critical failure and could
      // wrongly block the greeting A/B gate (found via code-review).
      technicalFailure = error instanceof HttpException ? error.message : 'техническая ошибка';
    }

    let grade: { verdict: 'pass' | 'issue' | 'critical'; whatWasWrong: string | null; expectedAnswer: string | null };
    if (technicalFailure) {
      grade = { verdict: 'issue', whatWasWrong: `Тест не завершился из-за технической ошибки (${technicalFailure}), не бота — повторите тест.`, expectedAnswer: null };
    } else if (blockedReason) {
      // Trial expired / billing blocked — a fixed canned reply, not the
      // bot's own quality. Grading THIS transcript would judge "did the bot
      // correctly answer the question" against a message that never
      // attempted to (found via code-review) — always "issue", never
      // "critical": this is a billing state, not a scripted required step
      // the scenario is meant to catch.
      grade = { verdict: 'issue', whatWasWrong: `Бот не ответил — ${blockedReason}`, expectedAnswer: null };
    } else if (transcript.length === 0) {
      grade = { verdict: 'issue', whatWasWrong: 'Диалог не состоялся — бот не ответил ни на одну реплику.', expectedAnswer: null };
    } else {
      // orderBy for determinism — a bot past the 200-row cap (same cap
      // KnowledgeService's own real prompt-building uses elsewhere) must at
      // least see a STABLE subset run to run, not an arbitrary one that
      // could make the grader see a fact on one run and not the next for
      // no reason tied to the actual conversation (found via code-review).
      const knowledgeFacts = await this.prisma.knowledgeEntry
        .findMany({ where: { botId: bot.id, moderationStatus: 'approved' }, select: { answer: true }, orderBy: { createdAt: 'desc' }, take: 200 })
        .then((rows) => rows.map((r) => r.answer));
      grade = await this.yandexGpt.gradeTestTranscript(
        scenario.mode === 'replay' ? 'Повтор реального диалога клиента' : scenario.customerBrief ?? '',
        transcript,
        knowledgeFacts,
        scenario.isCritical,
      );
    }

    return this.prisma.testResult.create({
      data: {
        runId,
        scenarioId: scenario.id,
        transcript: transcript as unknown as object,
        verdict: grade.verdict,
        whatWasWrong: grade.whatWasWrong,
        expectedAnswer: grade.expectedAnswer,
      },
    });
  }

  /** Returns a human-readable block reason when the reply was a canned billing message, null otherwise. */
  private async sendTurn(bot: { widgetToken: string }, sessionId: string, message: string, transcript: TranscriptMessage[]): Promise<string | null> {
    // See TURN_SPACING_MS's own comment — keeps a run's own turns under the
    // same per-botToken rate limit real visitor traffic shares.
    await sleep(TURN_SPACING_MS);
    transcript.push({ role: 'visitor', content: message });
    const dto: SendMessageDto = { botToken: bot.widgetToken, sessionId, message, isPreview: true, isAutoTest: true };
    const result = await this.widget.sendMessage(dto);
    transcript.push({ role: 'assistant', content: result.reply });
    if (result.reply === TRIAL_EXPIRED_REPLY) return 'пробный период бота закончился';
    if (result.reply === BILLING_BLOCKED_REPLY) return 'оплата не подтверждена или закончился баланс';
    return null;
  }
}
