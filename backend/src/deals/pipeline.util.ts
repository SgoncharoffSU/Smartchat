import { PrismaService } from '../prisma.service';

/**
 * Every company gets a default pipeline+4 stages via this session's mini-CRM
 * migration, but a company created AFTER that migration (a fresh self-sell
 * registration, most commonly) has none yet — this lazily creates one the
 * first time anything needs it, so the CRM board and chat-capture Deal
 * creation both work for brand-new companies without a second migration.
 * Shared (not duplicated) between CrmIntegrationService and DealsService.
 */
// Auto-populated on the deal card so an owner can tell what a self-sell
// registration (or a chat lead who mentioned their site) is actually about
// without opening the original conversation transcript — see
// CrmIntegrationService's ensureDealForLead/ensureDealForProvisioning. Fixed
// keys so repeated calls for the same company reuse the same definition
// instead of creating duplicates.
const ENRICHMENT_FIELDS: Record<string, { key: string; label: string }> = {
  website: { key: 'website', label: 'Сайт' },
  businessDescription: { key: 'business_description', label: 'Чем занимается' },
};

/**
 * Writes website/businessDescription (when present — both are optional,
 * model-captured facts, not guaranteed on every lead) onto a Deal as
 * ordinary custom field values, auto-creating the two field definitions on
 * first use. Reuses the existing custom-fields mechanism instead of adding
 * dedicated Deal columns, so this shows up in the exact same "Поля" section
 * the owner's own manually-added fields do.
 */
export async function applyLeadEnrichmentFields(
  prisma: PrismaService,
  companyId: string,
  dealId: string,
  facts: { website?: unknown; businessDescription?: unknown },
): Promise<void> {
  for (const [factKey, def] of Object.entries(ENRICHMENT_FIELDS)) {
    const value = facts[factKey as keyof typeof facts];
    if (typeof value !== 'string' || !value.trim()) continue;

    const field = await prisma.customFieldDefinition.upsert({
      where: { companyId_key: { companyId, key: def.key } },
      create: { companyId, key: def.key, label: def.label, type: 'text' },
      update: {},
    });
    await prisma.dealCustomFieldValue.upsert({
      where: { dealId_fieldId: { dealId, fieldId: field.id } },
      create: { dealId, fieldId: field.id, value: value.trim() },
      update: { value: value.trim() },
    });
  }
}

export async function getOrCreateDefaultPipeline(prisma: PrismaService, companyId: string) {
  const existing = await prisma.pipeline.findFirst({
    where: { companyId, isDefault: true },
    include: { stages: { orderBy: { order: 'asc' } } },
  });
  if (existing && existing.stages.length > 0) return existing;

  return prisma.pipeline.create({
    data: {
      companyId,
      name: 'Основная воронка',
      isDefault: true,
      stages: {
        create: [
          { name: 'Новая', color: '#94a3b8', order: 0 },
          { name: 'В работе', color: '#4f46e5', order: 1 },
          { name: 'Успешно', color: '#16a34a', order: 2, isWon: true },
          { name: 'Отказ', color: '#dc2626', order: 3, isLost: true },
        ],
      },
    },
    include: { stages: { orderBy: { order: 'asc' } } },
  });
}
