import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { getOrCreateDefaultPipeline, applyLeadEnrichmentFields } from '../deals/pipeline.util';

interface CrmTargetBot {
  bitrix24WebhookUrl: string | null;
  amocrmSubdomain: string | null;
  amocrmAccessToken: string | null;
  // Only actually read by findProvisioningOrigin's caller (to know whose
  // CRM board a provisioning-sourced deal belongs on) — every other call
  // site ignores it.
  companyId: string;
}

interface LeadData {
  name?: string;
  phone?: string;
  email?: string;
  interest?: string;
  businessDescription?: string;
  [key: string]: unknown;
}

// A push's sync-status timestamp lives on whichever row the conversion
// actually is — a real Lead for a normal chat capture, or the Company itself
// for a self-sell provisioning bot's "registration completed" conversion
// (see CabinetService.register — that flow never creates a Lead row at all,
// see its own comment for why), or a Deal for the mini-CRM board. All three
// get the exact same push/retry/durability treatment; this is just where
// markSynced writes the timestamp (and, for a deal, the remote id) back to.
type SyncTarget = { kind: 'lead'; id: string } | { kind: 'company'; id: string } | { kind: 'deal'; id: string };

// Per-stage CRM mapping (see PipelineStage) — null fields mean "don't sync
// this stage to that CRM." bitrix24TargetType decides whether a stage push
// creates/updates a Bitrix Lead (simple CRM / pre-conversion) or a Deal
// (classic CRM, a specific pipeline/category) — see pushDealToBitrix24.
interface DealStageSync {
  bitrix24CategoryId: string | null;
  bitrix24StageId: string | null;
  bitrix24TargetType: string | null; // 'lead' | 'deal'
  amocrmStatusId: number | null;
  amocrmPipelineId: number | null;
}

interface DealSyncData {
  title: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  amount?: number | null;
  currency?: string | null;
  bitrix24DealId?: string | null;
  bitrix24LeadId?: string | null;
  amocrmLeadId?: string | null;
}

// How often the retry sweep runs — a CRM outage lasting less than this
// window self-heals on the visitor's own next successful push anyway; this
// only matters for a lead captured DURING an outage, which otherwise would
// never get pushed once the CRM comes back. Not configurable via env yet —
// this is a fixed background sweep, not a per-tenant setting.
const RETRY_SWEEP_INTERVAL_MS = 5 * 60_000;
// Caps each sweep's work — an extended outage across many bots/leads
// shouldn't turn one sweep into an unbounded burst of outbound requests the
// moment the CRM (or this process) comes back up. The next sweep picks up
// whatever's left.
const RETRY_SWEEP_BATCH_SIZE = 50;

/**
 * Pushes a just-captured lead out to whichever CRM(s) the bot owner has
 * connected (see CabinetService.saveBitrix24/saveAmoCrm) — v1, the simplest
 * thing that works: an incoming-webhook URL for Bitrix24, a private-
 * integration (long-lived) token for amoCRM. Neither requires an OAuth app
 * listed in either platform's marketplace, which is real future work, not
 * this pass.
 *
 * Always fire-and-forget from the caller's point of view (see
 * WidgetService.processMessage and CabinetService.register) — a CRM being
 * down, misconfigured, or not connected at all must never affect the
 * visitor's own reply or a new owner's registration. A failed push is never
 * silently final, though: the target row's bitrix24SyncedAt/amocrmSyncedAt
 * stay null until a push actually succeeds, and the background sweep below
 * keeps retrying every such row (for whichever CRM is actually connected)
 * until it does — a CRM outage at capture time delays delivery, it doesn't
 * lose the lead.
 */
@Injectable()
export class CrmIntegrationService implements OnModuleInit {
  private readonly logger = new Logger(CrmIntegrationService.name);

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    setInterval(() => {
      this.retryPendingPushes().catch((error) => {
        this.logger.error(`CRM retry sweep (leads) threw: ${String(error)}`);
      });
      this.retryPendingProvisionedRegistrations().catch((error) => {
        this.logger.error(`CRM retry sweep (provisioned registrations) threw: ${String(error)}`);
      });
      this.retryPendingDealPushes().catch((error) => {
        this.logger.error(`CRM retry sweep (deals) threw: ${String(error)}`);
      });
    }, RETRY_SWEEP_INTERVAL_MS);
  }

  /** Called right after a lead is first captured — see widget.service.ts. */
  async pushLead(leadId: string, bot: CrmTargetBot, leadData: LeadData): Promise<void> {
    await this.push({ kind: 'lead', id: leadId }, bot, leadData);
  }

  /**
   * Mirrors a chat-captured Lead into the mini-CRM board, right alongside the
   * v1 pushLead call above — see widget.service.ts. Idempotent (upsert on
   * Deal.leadId, which is @unique) since the same dialog can re-trigger
   * leadCaptured across turns as leads.upsertAndCheckNew keeps refining the same Lead
   * row. Deliberately does NOT push to Bitrix24/amoCRM itself — that only
   * happens once a stage with a real CRM mapping is entered (see
   * DealsService.updateDeal), so a brand-new deal in the default "Новая"
   * stage sits locally until the owner has actually configured a mapping.
   */
  async ensureDealForLead(leadId: string, botId: string, companyId: string, dialogId: string, leadData: LeadData): Promise<void> {
    const pipeline = await getOrCreateDefaultPipeline(this.prisma, companyId);
    const firstStage = pipeline.stages[0];
    if (!firstStage) return;

    const name = typeof leadData.name === 'string' ? leadData.name : undefined;
    const deal = await this.prisma.deal.upsert({
      where: { leadId },
      create: {
        companyId,
        botId,
        leadId,
        dialogId,
        title: name ? `Заявка от ${name}` : 'Заявка из Умного Чата',
        name,
        phone: typeof leadData.phone === 'string' ? leadData.phone : undefined,
        email: typeof leadData.email === 'string' ? leadData.email : undefined,
        stageId: firstStage.id,
        source: 'chat',
      },
      update: {
        name,
        phone: typeof leadData.phone === 'string' ? leadData.phone : undefined,
        email: typeof leadData.email === 'string' ? leadData.email : undefined,
      },
    });
    // website/businessDescription aren't always present (the model only
    // captures them if the visitor actually mentioned them) — see
    // applyLeadEnrichmentFields for how these show up on the card.
    await applyLeadEnrichmentFields(this.prisma, companyId, deal.id, {
      website: leadData.website,
      businessDescription: leadData.businessDescription,
    });
  }

  /**
   * Called right after a self-sell provisioning bot's registration completes
   * — see cabinet.service.ts's register(). Looks up which bot's sales
   * conversation actually provisioned this company (a Company has no direct
   * foreign key back to it — see findProvisioningOrigin) and pushes to
   * whichever CRM that bot has connected, if any.
   */
  async notifyRegistrationCompleted(companyId: string, leadData: LeadData): Promise<void> {
    const origin = await this.findProvisioningOrigin(companyId);
    if (!origin) return;
    await this.pushProvisionedRegistration(companyId, origin.bot, leadData);
    // The deal belongs on the SELLER's own CRM board (origin.bot.companyId —
    // whoever owns the self-sell bot, e.g. "Айна") — it's their sales
    // pipeline of "who signed up through our bot", not something that
    // belongs on the brand-new signup's own (otherwise-empty) board. Easy to
    // get backwards since `companyId` here is the NEWLY PROVISIONED company;
    // see ensureDealForProvisioning's own comment.
    await this.ensureDealForProvisioning(origin.bot.companyId, origin.bot.id, origin.dialogId, leadData);
  }

  /**
   * Same idea as ensureDealForLead, for the provisioning entry point — see
   * notifyRegistrationCompleted. `sellerCompanyId` is deliberately NOT the
   * newly-provisioned company (that company has no sales team of its own
   * looking at this deal) — it's whoever owns the bot that sold them, whose
   * CRM board this registration is meant to show up on.
   */
  private async ensureDealForProvisioning(sellerCompanyId: string, botId: string, dialogId: string, leadData: LeadData): Promise<void> {
    const already = await this.prisma.deal.findFirst({ where: { companyId: sellerCompanyId, source: 'provisioning', dialogId } });
    if (already) return;

    const pipeline = await getOrCreateDefaultPipeline(this.prisma, sellerCompanyId);
    const firstStage = pipeline.stages[0];
    if (!firstStage) return;

    const name = typeof leadData.name === 'string' ? leadData.name : undefined;
    const interest = typeof leadData.interest === 'string' ? leadData.interest : undefined;
    const deal = await this.prisma.deal.create({
      data: {
        companyId: sellerCompanyId,
        botId,
        dialogId,
        title: interest ? `Регистрация: ${interest}` : 'Заявка из Умного Чата',
        name,
        email: typeof leadData.email === 'string' ? leadData.email : undefined,
        stageId: firstStage.id,
        source: 'provisioning',
      },
    });

    // The registration-completion leadData passed in here (built from the
    // Company/User rows at register() time) never carries website/
    // businessDescription — those were only ever captured earlier, during
    // the ORIGINAL sales conversation this dialogId points at. Read them
    // back from there instead so "какой сайт, чем занимается" still shows up
    // on a self-sell registration's card.
    const originDialog = await this.prisma.dialog.findUnique({ where: { id: dialogId }, select: { visitorMeta: true } });
    const originLeadData = (originDialog?.visitorMeta as Record<string, unknown> | null)?.leadData as Record<string, unknown> | undefined;
    await applyLeadEnrichmentFields(this.prisma, sellerCompanyId, deal.id, {
      website: originLeadData?.website,
      businessDescription: originLeadData?.businessDescription,
    });
  }

  private async pushProvisionedRegistration(companyId: string, bot: CrmTargetBot, leadData: LeadData): Promise<void> {
    await this.push({ kind: 'company', id: companyId }, bot, leadData);
  }

  private async push(target: SyncTarget, bot: CrmTargetBot, leadData: LeadData): Promise<void> {
    await Promise.all([this.pushToBitrix24(target, bot, leadData), this.pushToAmoCrm(target, bot, leadData)]);
  }

  /**
   * Finds leads that still owe a push to a CRM their own bot has connected —
   * "owe" meaning: that CRM is configured AND this specific lead's sync
   * timestamp for it is still null. Redacted leads are skipped entirely:
   * their contact fields are already nulled out (152-FZ erasure), so there is
   * nothing left worth pushing.
   */
  async retryPendingPushes(): Promise<void> {
    const pending = await this.prisma.lead.findMany({
      where: {
        redactedAt: null,
        OR: [
          { bitrix24SyncedAt: null, dialog: { bot: { bitrix24WebhookUrl: { not: null } } } },
          { amocrmSyncedAt: null, dialog: { bot: { amocrmSubdomain: { not: null }, amocrmAccessToken: { not: null } } } },
        ],
      },
      include: { dialog: { include: { bot: true } } },
      take: RETRY_SWEEP_BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });
    if (pending.length === 0) return;
    this.logger.log(`CRM retry sweep: ${pending.length} lead(s) with a pending push`);
    for (const lead of pending) {
      const leadData: LeadData = { name: lead.name ?? undefined, phone: lead.phone ?? undefined, email: lead.email ?? undefined, ...(lead.rawCapture as object) };
      await this.pushLead(lead.id, lead.dialog.bot, leadData);
    }
  }

  /**
   * Same idea as retryPendingPushes, but for provisioned registrations (see
   * pushProvisionedRegistration) — these never had a bot reference of their
   * own to filter by directly (a Company doesn't know which bot sold it), so
   * each candidate's originating bot has to be looked up individually via
   * findProvisioningOrigin before we know whether there's actually a CRM
   * connected to push to.
   */
  async retryPendingProvisionedRegistrations(): Promise<void> {
    const pending = await this.prisma.company.findMany({
      where: {
        registeredAt: { not: null },
        OR: [{ bitrix24SyncedAt: null }, { amocrmSyncedAt: null }],
      },
      include: { users: { orderBy: { createdAt: 'asc' }, take: 1 } },
      take: RETRY_SWEEP_BATCH_SIZE,
      orderBy: { registeredAt: 'asc' },
    });
    if (pending.length === 0) return;
    for (const company of pending) {
      const user = company.users[0];
      await this.notifyRegistrationCompleted(company.id, {
        name: user?.name ?? undefined,
        email: user?.email ?? undefined,
        interest: company.name,
      });
    }
  }

  /**
   * A provisioned company doesn't carry a direct foreign key to the self-sell
   * bot that sold it — that link only ever exists as
   * Dialog.visitorMeta.provisioning.companyId on whichever dialog actually
   * ran the sales conversation (see ProvisioningService). This is the one
   * place that reverses that lookup.
   */
  private async findProvisioningOrigin(companyId: string): Promise<{ bot: CrmTargetBot & { id: string }; dialogId: string } | null> {
    const dialog = await this.prisma.dialog.findFirst({
      where: { visitorMeta: { path: ['provisioning', 'companyId'], equals: companyId } },
      include: { bot: true },
    });
    return dialog ? { bot: dialog.bot, dialogId: dialog.id } : null;
  }

  private async markSynced(target: SyncTarget, field: 'bitrix24SyncedAt' | 'amocrmSyncedAt', extra?: Record<string, unknown>): Promise<void> {
    const data = { [field]: new Date(), ...(extra ?? {}) };
    if (target.kind === 'lead') {
      await this.prisma.lead.update({ where: { id: target.id }, data });
    } else if (target.kind === 'company') {
      await this.prisma.company.update({ where: { id: target.id }, data });
    } else {
      await this.prisma.deal.update({ where: { id: target.id }, data });
    }
  }

  /**
   * Pushes (or updates) a Deal's stage/contact/amount out to whichever CRM(s)
   * are connected AND that stage has a mapping for (see PipelineStage) —
   * called right after a stage change on the board (DealsService.updateDeal)
   * and by the retry sweep below. Never called for an inbound-originated
   * update (see Bitrix24WebhookController/AmoCrmPollService) — those write
   * the Deal directly and must NOT bounce back out as another outbound push,
   * which is what would happen if this were reused for both directions.
   */
  async pushDeal(dealId: string, bot: CrmTargetBot, data: DealSyncData, stage: DealStageSync): Promise<void> {
    await Promise.all([this.pushDealToBitrix24(dealId, bot, data, stage), this.pushDealToAmoCrm(dealId, bot, data, stage)]);
  }

  /**
   * Same shape as retryPendingPushes/retryPendingProvisionedRegistrations,
   * for Deal rows — "owes a push" means: the stage this deal currently sits
   * in has a mapping for that CRM, that CRM is actually connected on the
   * deal's bot, and the corresponding synced timestamp is still null (a
   * stage change resets both timestamps — see DealsService.updateDeal).
   * Deals with no bot (manually created, never touched a chat) are skipped —
   * there's no bot to read CRM credentials from.
   */
  async retryPendingDealPushes(): Promise<void> {
    const pending = await this.prisma.deal.findMany({
      where: {
        redactedAt: null,
        botId: { not: null },
        OR: [
          { bitrix24SyncedAt: null, stage: { bitrix24StageId: { not: null } }, bot: { bitrix24WebhookUrl: { not: null } } },
          { amocrmSyncedAt: null, stage: { amocrmStatusId: { not: null } }, bot: { amocrmSubdomain: { not: null }, amocrmAccessToken: { not: null } } },
        ],
      },
      include: { bot: true, stage: true },
      take: RETRY_SWEEP_BATCH_SIZE,
      orderBy: { updatedAt: 'asc' },
    });
    if (pending.length === 0) return;
    this.logger.log(`CRM retry sweep: ${pending.length} deal(s) with a pending push`);
    for (const deal of pending) {
      if (!deal.bot) continue;
      await this.pushDeal(
        deal.id,
        deal.bot,
        {
          title: deal.title,
          name: deal.name,
          phone: deal.phone,
          email: deal.email,
          amount: deal.amount ? Number(deal.amount) : null,
          currency: deal.currency,
          bitrix24DealId: deal.bitrix24DealId,
          bitrix24LeadId: deal.bitrix24LeadId,
          amocrmLeadId: deal.amocrmLeadId,
        },
        deal.stage,
      );
    }
  }

  private async pushDealToBitrix24(dealId: string, bot: CrmTargetBot, data: DealSyncData, stage: DealStageSync): Promise<void> {
    if (!bot.bitrix24WebhookUrl || !stage.bitrix24StageId) return;
    try {
      const asDeal = stage.bitrix24TargetType === 'deal';
      const method = asDeal
        ? data.bitrix24DealId
          ? 'crm.deal.update'
          : 'crm.deal.add'
        : data.bitrix24LeadId
          ? 'crm.lead.update'
          : 'crm.lead.add';

      const fields: Record<string, unknown> = {
        TITLE: data.title,
        STAGE_ID: stage.bitrix24StageId,
      };
      if (asDeal) {
        if (stage.bitrix24CategoryId) fields.CATEGORY_ID = stage.bitrix24CategoryId;
        if (data.amount != null) fields.OPPORTUNITY = data.amount;
        if (data.currency) fields.CURRENCY_ID = data.currency;
      } else {
        // Bitrix "simple CRM"/Lead entity — same fixed PHONE/EMAIL shape as
        // the v1 Lead push (see pushToBitrix24 above), no per-account lookup needed.
        if (data.name) fields.NAME = data.name;
        if (data.phone) fields.PHONE = [{ VALUE: data.phone, VALUE_TYPE: 'WORK' }];
        if (data.email) fields.EMAIL = [{ VALUE: data.email, VALUE_TYPE: 'WORK' }];
      }

      const body: Record<string, unknown> = { fields };
      const existingId = asDeal ? data.bitrix24DealId : data.bitrix24LeadId;
      if (existingId) body.id = existingId;

      const res = await fetch(`${bot.bitrix24WebhookUrl}${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.logger.warn(`Bitrix24 deal push failed (will retry later): ${res.status} ${await res.text()}`);
        return;
      }
      // Recorded alongside the timestamp so a later inbound webhook echoing
      // this EXACT state right back (Bitrix commonly fires one on the update
      // it was just told to make) is recognized as a no-op — see
      // applyInboundBitrix24Update.
      const extra: Record<string, unknown> = { lastCrmFingerprint: `bitrix:${stage.bitrix24StageId}:${data.title}:${data.amount ?? ''}` };
      if (!existingId) {
        const created = await res.json();
        if (asDeal) extra.bitrix24DealId = String(created.result);
        else extra.bitrix24LeadId = String(created.result);
      }
      await this.markSynced({ kind: 'deal', id: dealId }, 'bitrix24SyncedAt', extra);
    } catch (error) {
      this.logger.warn(`Bitrix24 deal push threw (will retry later): ${String(error)}`);
    }
  }

  private async pushDealToAmoCrm(dealId: string, bot: CrmTargetBot, data: DealSyncData, stage: DealStageSync): Promise<void> {
    if (!bot.amocrmSubdomain || !bot.amocrmAccessToken || stage.amocrmStatusId == null) return;
    try {
      const base = `https://${bot.amocrmSubdomain}.amocrm.ru/api/v4`;
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${bot.amocrmAccessToken}` };
      const payload: Record<string, unknown> = {
        name: data.title,
        status_id: stage.amocrmStatusId,
      };
      if (stage.amocrmPipelineId != null) payload.pipeline_id = stage.amocrmPipelineId;
      if (data.amount != null) payload.price = data.amount;

      let amoLeadId = data.amocrmLeadId;
      if (amoLeadId) {
        const res = await fetch(`${base}/leads`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify([{ id: Number(amoLeadId), ...payload }]),
        });
        if (!res.ok) {
          this.logger.warn(`amoCRM deal update failed (will retry later): ${res.status} ${await res.text()}`);
          return;
        }
      } else {
        const res = await fetch(`${base}/leads`, { method: 'POST', headers, body: JSON.stringify([payload]) });
        if (!res.ok) {
          this.logger.warn(`amoCRM deal create failed (will retry later): ${res.status} ${await res.text()}`);
          return;
        }
        const created = await res.json();
        amoLeadId = String(created?._embedded?.leads?.[0]?.id ?? '');
      }

      // Same contact-details-as-a-note limitation as the v1 Lead push (see
      // pushToAmoCrm above) — no fixed phone/email field id without a
      // per-account custom-field lookup, which is real follow-up work.
      const noteText = [data.name && `Имя: ${data.name}`, data.phone && `Телефон: ${data.phone}`, data.email && `Email: ${data.email}`].filter(Boolean).join('\n');
      if (amoLeadId && noteText) {
        const noteRes = await fetch(`${base}/leads/${amoLeadId}/notes`, {
          method: 'POST',
          headers,
          body: JSON.stringify([{ note_type: 'common', params: { text: noteText } }]),
        });
        if (!noteRes.ok) this.logger.warn(`amoCRM deal note failed: ${noteRes.status} ${await noteRes.text()}`);
      }

      const amoExtra: Record<string, unknown> = { lastCrmFingerprint: `amocrm:${stage.amocrmStatusId}:${data.title}:${data.amount ?? ''}` };
      if (amoLeadId) amoExtra.amocrmLeadId = amoLeadId;
      await this.markSynced({ kind: 'deal', id: dealId }, 'amocrmSyncedAt', amoExtra);
    } catch (error) {
      this.logger.warn(`amoCRM deal push threw (will retry later): ${String(error)}`);
    }
  }

  /**
   * Inbound direction — Bitrix24's own "исходящий вебхук" (portal-admin
   * configured, no OAuth app needed) calls Bitrix24WebhookController on
   * ONCRMDEALUPDATE/ONCRMLEADUPDATE, which resolves the local Deal and calls
   * this. Deliberately never calls pushDeal — an inbound update must not
   * bounce straight back out as another outbound push (see pushDeal's own
   * comment on this). Silently no-ops if the entity isn't one of ours or the
   * remote stage has no local mapping (an owner-side stage-mapping gap, not
   * an error worth surfacing per-webhook-call).
   */
  async applyInboundBitrix24Update(entityId: string, targetType: 'lead' | 'deal', remoteStageId: string, title?: string, amount?: number): Promise<void> {
    const deal =
      targetType === 'deal'
        ? await this.prisma.deal.findFirst({ where: { bitrix24DealId: entityId }, include: { stage: true } })
        : await this.prisma.deal.findFirst({ where: { bitrix24LeadId: entityId }, include: { stage: true } });
    if (!deal) return;

    const fingerprint = `bitrix:${remoteStageId}:${title ?? ''}:${amount ?? ''}`;
    if (deal.lastCrmFingerprint === fingerprint) return; // same update delivered again — nothing changed

    const targetStage = await this.prisma.pipelineStage.findFirst({
      where: { pipelineId: deal.stage.pipelineId, bitrix24StageId: remoteStageId },
    });
    if (!targetStage) {
      this.logger.warn(`Inbound Bitrix24 update for deal ${deal.id}: remote stage ${remoteStageId} has no local mapping — skipped`);
      return;
    }

    await this.prisma.$transaction([
      this.prisma.deal.update({
        where: { id: deal.id },
        data: {
          ...(targetStage.id !== deal.stageId ? { stageId: targetStage.id } : {}),
          ...(amount != null ? { amount } : {}),
          lastCrmFingerprint: fingerprint,
        },
      }),
      this.prisma.dealActivity.create({
        data: { dealId: deal.id, kind: 'system', text: `Стадия обновлена из Bitrix24: «${targetStage.name}»` },
      }),
    ]);
  }

  /** Inbound direction for amoCRM — called by AmoCrmPollService, same no-loop guarantee as applyInboundBitrix24Update. */
  async applyInboundAmoCrmUpdate(amoLeadId: string, remoteStatusId: number, title?: string, amount?: number): Promise<void> {
    const deal = await this.prisma.deal.findFirst({ where: { amocrmLeadId: String(amoLeadId) }, include: { stage: true } });
    if (!deal) return;

    const fingerprint = `amocrm:${remoteStatusId}:${title ?? ''}:${amount ?? ''}`;
    if (deal.lastCrmFingerprint === fingerprint) return;

    const targetStage = await this.prisma.pipelineStage.findFirst({
      where: { pipelineId: deal.stage.pipelineId, amocrmStatusId: remoteStatusId },
    });
    if (!targetStage) {
      this.logger.warn(`Inbound amoCRM update for deal ${deal.id}: remote status ${remoteStatusId} has no local mapping — skipped`);
      return;
    }

    await this.prisma.$transaction([
      this.prisma.deal.update({
        where: { id: deal.id },
        data: {
          ...(targetStage.id !== deal.stageId ? { stageId: targetStage.id } : {}),
          ...(amount != null ? { amount } : {}),
          lastCrmFingerprint: fingerprint,
        },
      }),
      this.prisma.dealActivity.create({
        data: { dealId: deal.id, kind: 'system', text: `Стадия обновлена из amoCRM: «${targetStage.name}»` },
      }),
    ]);
  }

  /**
   * Real STAGE_ID/CATEGORY_ID/STATUS_ID values from the owner's own connected
   * account — feeds the pipeline-settings dropdowns in the cabinet so the
   * owner picks a stage by name instead of typing an ID by hand (that manual
   * entry is exactly why every PipelineStage's mapping columns sit empty
   * right now — nobody could reasonably know the raw ID to type). Read-only,
   * no local writes; each side is independent and a failure on one (bad
   * token, network) never blocks the other from returning what it has.
   */
  async getStageMappingOptions(bot: CrmTargetBot): Promise<{
    bitrix24: {
      connected: boolean;
      error?: string;
      leadStatuses: Array<{ id: string; name: string }>;
      dealCategories: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
    };
    amocrm: {
      connected: boolean;
      error?: string;
      pipelines: Array<{ id: number; name: string; statuses: Array<{ id: number; name: string }> }>;
    };
  }> {
    const bitrix24: {
      connected: boolean;
      error?: string;
      leadStatuses: Array<{ id: string; name: string }>;
      dealCategories: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
    } = { connected: Boolean(bot.bitrix24WebhookUrl), leadStatuses: [], dealCategories: [] };

    if (bot.bitrix24WebhookUrl) {
      try {
        const [statusRes, categoryRes] = await Promise.all([
          fetch(`${bot.bitrix24WebhookUrl}crm.status.list.json?filter[ENTITY_ID]=STATUS`),
          fetch(`${bot.bitrix24WebhookUrl}crm.dealcategory.list.json`),
        ]);
        if (!statusRes.ok || !categoryRes.ok) throw new Error(`${statusRes.status}/${categoryRes.status}`);
        const statusPayload = await statusRes.json();
        const categoryPayload = await categoryRes.json();
        bitrix24.leadStatuses = (statusPayload?.result ?? []).map((s: any) => ({ id: String(s.STATUS_ID), name: String(s.NAME) }));

        // Category 0 is Bitrix's own always-present default funnel — not
        // listed by crm.dealcategory.list (which only returns EXTRA custom
        // funnels), but crm.dealcategory.stage.list still answers for it.
        const categories: Array<{ id: string; name: string }> = [
          { id: '0', name: 'Основная воронка' },
          ...(categoryPayload?.result ?? []).map((c: any) => ({ id: String(c.ID), name: String(c.NAME) })),
        ];
        const stageLists = await Promise.all(
          categories.map((c) => fetch(`${bot.bitrix24WebhookUrl}crm.dealcategory.stage.list.json?id=${encodeURIComponent(c.id)}`)),
        );
        for (let i = 0; i < categories.length; i++) {
          const res = stageLists[i];
          if (!res.ok) continue;
          const payload = await res.json();
          const stages = (payload?.result ?? []).map((s: any) => ({ id: String(s.STATUS_ID), name: String(s.NAME) }));
          bitrix24.dealCategories.push({ ...categories[i], stages });
        }
      } catch (error) {
        this.logger.warn(`getStageMappingOptions: Bitrix24 fetch failed: ${String(error)}`);
        bitrix24.error = 'Не удалось получить список из Bitrix24 — проверьте вебхук.';
      }
    }

    const amocrm: {
      connected: boolean;
      error?: string;
      pipelines: Array<{ id: number; name: string; statuses: Array<{ id: number; name: string }> }>;
    } = { connected: Boolean(bot.amocrmSubdomain && bot.amocrmAccessToken), pipelines: [] };

    if (bot.amocrmSubdomain && bot.amocrmAccessToken) {
      try {
        const res = await fetch(`https://${bot.amocrmSubdomain}.amocrm.ru/api/v4/leads/pipelines`, {
          headers: { Authorization: `Bearer ${bot.amocrmAccessToken}` },
        });
        if (!res.ok) throw new Error(String(res.status));
        const payload = await res.json();
        const pipelines = payload?._embedded?.pipelines ?? [];
        amocrm.pipelines = pipelines.map((p: any) => ({
          id: p.id,
          name: p.name,
          statuses: (p?._embedded?.statuses ?? []).map((s: any) => ({ id: s.id, name: s.name })),
        }));
      } catch (error) {
        this.logger.warn(`getStageMappingOptions: amoCRM fetch failed: ${String(error)}`);
        amocrm.error = 'Не удалось получить список из amoCRM — проверьте поддомен и токен.';
      }
    }

    return { bitrix24, amocrm };
  }

  private async pushToBitrix24(target: SyncTarget, bot: CrmTargetBot, leadData: LeadData): Promise<void> {
    if (!bot.bitrix24WebhookUrl) return;
    try {
      // crm.lead.add is a genuinely native Bitrix24 method — PHONE/EMAIL are
      // real fixed multi-value fields on every account, unlike amoCRM below,
      // so this needs no per-account custom-field lookup to be correct.
      const fields: Record<string, unknown> = {
        TITLE: leadData.name ? `Заявка от ${leadData.name}` : 'Заявка из Умного Чата',
        COMMENTS: [leadData.interest, leadData.businessDescription].filter(Boolean).join('\n'),
        SOURCE_ID: 'WEB',
      };
      if (leadData.name) fields.NAME = leadData.name;
      if (leadData.phone) fields.PHONE = [{ VALUE: leadData.phone, VALUE_TYPE: 'WORK' }];
      if (leadData.email) fields.EMAIL = [{ VALUE: leadData.email, VALUE_TYPE: 'WORK' }];

      const res = await fetch(`${bot.bitrix24WebhookUrl}crm.lead.add.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) {
        this.logger.warn(`Bitrix24 lead push failed (will retry later): ${res.status} ${await res.text()}`);
        return;
      }
      await this.markSynced(target, 'bitrix24SyncedAt');
    } catch (error) {
      this.logger.warn(`Bitrix24 lead push threw (will retry later): ${String(error)}`);
    }
  }

  private async pushToAmoCrm(target: SyncTarget, bot: CrmTargetBot, leadData: LeadData): Promise<void> {
    if (!bot.amocrmSubdomain || !bot.amocrmAccessToken) return;
    try {
      const base = `https://${bot.amocrmSubdomain}.amocrm.ru/api/v4`;
      const leadName = leadData.name ? `Заявка от ${leadData.name}` : 'Заявка из Умного Чата';
      const createRes = await fetch(`${base}/leads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bot.amocrmAccessToken}`,
        },
        body: JSON.stringify([{ name: leadName }]),
      });
      if (!createRes.ok) {
        this.logger.warn(`amoCRM lead create failed (will retry later): ${createRes.status} ${await createRes.text()}`);
        return;
      }
      const created = await createRes.json();
      const amoLeadId = created?._embedded?.leads?.[0]?.id;
      // Phone/email live as CUSTOM FIELDS on the lead/contact in amoCRM, and
      // which field ID means "phone" varies per account — there's no fixed
      // field like Bitrix24's PHONE/EMAIL to write into without first
      // looking that account's field IDs up (real follow-up work, not this
      // pass). A note attached to the lead needs no field IDs at all and
      // always works, so that's where the actual contact details go for now.
      if (amoLeadId) {
        const noteText = [
          leadData.name && `Имя: ${leadData.name}`,
          leadData.phone && `Телефон: ${leadData.phone}`,
          leadData.email && `Email: ${leadData.email}`,
          leadData.interest && `Интерес: ${leadData.interest}`,
        ]
          .filter(Boolean)
          .join('\n');
        if (noteText) {
          const noteRes = await fetch(`${base}/leads/${amoLeadId}/notes`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${bot.amocrmAccessToken}`,
            },
            body: JSON.stringify([{ note_type: 'common', params: { text: noteText } }]),
          });
          if (!noteRes.ok) {
            // The lead itself was created — a lost note isn't worth re-creating
            // a duplicate lead over on retry, so this alone doesn't block
            // marking the lead as synced. Logged for visibility only.
            this.logger.warn(`amoCRM lead note failed: ${noteRes.status} ${await noteRes.text()}`);
          }
        }
      }
      await this.markSynced(target, 'amocrmSyncedAt');
    } catch (error) {
      this.logger.warn(`amoCRM lead push threw (will retry later): ${String(error)}`);
    }
  }
}
