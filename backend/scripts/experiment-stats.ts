// Conversion breakdown per A/B/C/D variant for a given funnel stage.
// Usage: npx ts-node scripts/experiment-stats.ts [stageId]
// Defaults to the "greeting" stage. Conversion = dialog reached status "handoff"
// (i.e. a lead was captured) at least once.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface FunnelStageLike {
  stageId: string;
  variants?: string[];
}

async function main() {
  const stageKey = process.argv[2] || 'greeting';

  const bots = await prisma.bot.findMany();

  for (const bot of bots) {
    const dialogs = await prisma.dialog.findMany({ where: { botId: bot.id } });
    const funnel = Array.isArray(bot.funnelConfig) ? (bot.funnelConfig as unknown as FunnelStageLike[]) : [];
    const stage = funnel.find((s) => s.stageId === stageKey);
    const variants: string[] = stage?.variants ?? [];

    const buckets = new Map<number, { total: number; converted: number }>();
    let noVariant = 0;

    for (const d of dialogs) {
      const meta = (d.visitorMeta as Record<string, any>) ?? {};
      const idx = meta?.experiments?.[stageKey];
      if (idx === undefined || idx === null) {
        noVariant++;
        continue;
      }
      const bucket = buckets.get(idx) ?? { total: 0, converted: 0 };
      bucket.total++;
      if (d.status === 'handoff') bucket.converted++;
      buckets.set(idx, bucket);
    }

    if (buckets.size === 0) continue;

    console.log(`\n=== Бот: ${bot.name} (${bot.widgetToken}) — стадия "${stageKey}" ===`);
    const sortedIndexes = Array.from(buckets.keys()).sort((a, b) => a - b);
    for (const idx of sortedIndexes) {
      const { total, converted } = buckets.get(idx)!;
      const rate = total > 0 ? ((converted / total) * 100).toFixed(1) : '0.0';
      const label = String.fromCharCode(65 + idx);
      const preview = variants[idx]
        ? variants[idx].slice(0, 90).replace(/\s+/g, ' ') + '…'
        : '(текст варианта не найден в текущем funnel_config)';
      console.log(`  Вариант ${label}: ${total} диалогов, ${converted} лидов, конверсия ${rate}%`);
      console.log(`    ${preview}`);
    }
    if (noVariant > 0) {
      console.log(`  Без варианта (созданы до включения A/B-теста): ${noVariant} диалогов`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
