// One-off repair: strips exitCondition from any funnel_config stage that
// isn't literally "handoff"/"closed" — fixes bots provisioned before
// yandex-gpt.service.ts started sanitizing generated funnels itself.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface StageLike {
  stageId: string;
  exitCondition?: string;
  [key: string]: unknown;
}

async function main() {
  const bots = await prisma.bot.findMany();
  let fixedCount = 0;

  for (const bot of bots) {
    if (!Array.isArray(bot.funnelConfig)) continue;
    const stages = bot.funnelConfig as unknown as StageLike[];
    let changed = false;

    const sanitized = stages.map((s) => {
      if (s.stageId !== 'handoff' && s.stageId !== 'closed' && s.exitCondition) {
        changed = true;
        const { exitCondition, ...rest } = s;
        return rest;
      }
      return s;
    });

    if (changed) {
      await prisma.bot.update({ where: { id: bot.id }, data: { funnelConfig: sanitized as any } });
      console.log(`Fixed bot ${bot.id} (${bot.name})`);
      fixedCount++;
    }
  }

  console.log(`Done. Fixed ${fixedCount} bot(s).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
