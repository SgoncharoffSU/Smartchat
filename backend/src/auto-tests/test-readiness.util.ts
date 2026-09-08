import { PrismaService } from '../prisma.service';

/**
 * "Готовность" of a bot's test coverage — used by BOTH AutoTestsService's
 * own dashboard summary and CabinetService.addGreetingVariant's A/B gate,
 * so the two can never disagree (found via code-review: they used to,
 * because addGreetingVariant checked "the single latest TestRun row" while
 * runOne's own single-scenario reruns kept creating NEW "latest" rows that
 * covered only one scenario, wrongly re-blocking the gate right after a
 * full passing batch).
 *
 * The real unit of truth is each ACTIVE scenario's own most recent
 * TestResult — across any run — not "the newest TestRun row". A full batch
 * run followed by a couple of single "Повторить тест" retries naturally
 * updates just those scenarios' own latest result, exactly matching what
 * the cabinet's own retest() already does to its local state.
 */
export async function computeBotTestReadiness(prisma: PrismaService, botId: string) {
  const activeScenarios = await prisma.testScenario.findMany({ where: { botId, archived: false } });
  const activeIds = activeScenarios.map((s) => s.id);

  const latestByScenario = new Map<string, { id: string; scenarioId: string; verdict: string; createdAt: Date }>();
  if (activeIds.length > 0) {
    const allResults = await prisma.testResult.findMany({
      where: { scenarioId: { in: activeIds } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, scenarioId: true, verdict: true, createdAt: true },
    });
    for (const r of allResults) {
      if (!latestByScenario.has(r.scenarioId)) latestByScenario.set(r.scenarioId, r);
    }
  }

  const criticalScenarios = activeScenarios.filter((s) => s.isCritical);
  const allCriticalCovered = criticalScenarios.every((s) => latestByScenario.has(s.id));
  const anyCriticalFailure = [...latestByScenario.values()].some((r) => r.verdict === 'critical');
  const hasAnyRun = latestByScenario.size > 0;

  return {
    activeScenarios,
    latestByScenario,
    hasAnyRun,
    // hasAnyRun is required explicitly, not just implied by
    // allCriticalCovered — a bot with ZERO critical scenarios (or zero
    // scenarios at all) would otherwise make allCriticalCovered vacuously
    // true and pass this with no test ever having actually run, directly
    // contradicting "no run yet blocks too, same as a failing one" (found
    // via code-review).
    readyToPublish: hasAnyRun && allCriticalCovered && !anyCriticalFailure,
  };
}
