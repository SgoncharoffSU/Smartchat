import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CrmIntegrationService } from '../leads/crm-integration.service';
import { getOrCreateDefaultPipeline } from './pipeline.util';

const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select', 'phone', 'email', 'textarea'];

interface DealInput {
  title?: string;
  name?: string;
  phone?: string;
  email?: string;
  amount?: number | null;
  currency?: string;
  assignedUserId?: string | null;
  stageId?: string;
  customFields?: Record<string, string>;
}

/**
 * The mini-CRM's own service — separate from LeadsService (which stays a
 * thin PII-capture record) and CrmIntegrationService (which owns the actual
 * outbound/inbound wire protocol to Bitrix24/amoCRM). This owns the board
 * itself: deals, pipeline/stages, custom fields, activity feed, and the
 * employee/manager visibility rule.
 */
@Injectable()
export class DealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crmIntegration: CrmIntegrationService,
  ) {}

  private canSeeAllDeals(companyRole: string): boolean {
    return companyRole === 'owner' || companyRole === 'manager';
  }

  private canManagePipeline(companyRole: string): boolean {
    return companyRole === 'owner';
  }

  /** Employee: only their own (or unassigned) deals. Owner/manager: everything. */
  private dealVisibilityWhere(companyId: string, userId: string, companyRole: string) {
    if (this.canSeeAllDeals(companyRole)) return { companyId, redactedAt: null };
    return { companyId, redactedAt: null, OR: [{ assignedUserId: userId }, { assignedUserId: null }] };
  }

  private async assertDealVisible(companyId: string, dealId: string, userId: string, companyRole: string) {
    const deal = await this.prisma.deal.findFirst({ where: { id: dealId, ...this.dealVisibilityWhere(companyId, userId, companyRole) } });
    if (!deal) throw new NotFoundException('Deal not found');
    return deal;
  }

  /** Only owner/manager may reassign a deal or edit another employee's deal directly (not just view it). */
  private assertCanEdit(deal: { assignedUserId: string | null }, userId: string, companyRole: string) {
    if (this.canSeeAllDeals(companyRole)) return;
    if (deal.assignedUserId && deal.assignedUserId !== userId) {
      throw new ForbiddenException('Эта сделка назначена другому сотруднику');
    }
  }

  async getBoard(companyId: string, userId: string, companyRole: string) {
    const pipeline = await getOrCreateDefaultPipeline(this.prisma, companyId);
    const deals = await this.prisma.deal.findMany({
      where: this.dealVisibilityWhere(companyId, userId, companyRole),
      include: {
        customFieldValues: { include: { field: true } },
        assignedUser: true,
        // Just enough to show "a task is set" + its due date on the card
        // itself, without pulling every task for every deal on the board —
        // take:1 (soonest due date first) for the preview, a separate
        // _count for the real total so the badge (see shapeDeal below) isn't
        // stuck at "1" once a deal has more than one open task.
        tasks: { where: { completedAt: null }, orderBy: { dueDate: 'asc' }, take: 1 },
        _count: { select: { tasks: { where: { completedAt: null } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return {
      stages: pipeline.stages.map((s) => ({ id: s.id, name: s.name, color: s.color, order: s.order, isWon: s.isWon, isLost: s.isLost })),
      deals: deals.map((d) => this.shapeDeal(d)),
    };
  }

  async getDeal(companyId: string, dealId: string, userId: string, companyRole: string) {
    const deal = await this.assertDealVisible(companyId, dealId, userId, companyRole);
    const full = await this.prisma.deal.findUnique({
      where: { id: deal.id },
      include: {
        customFieldValues: { include: { field: true } },
        assignedUser: true,
        activities: { orderBy: { createdAt: 'desc' }, include: { author: true } },
        // Open tasks (completedAt still null) first — Postgres' own default
        // for DESC is NULLS FIRST, but spelled out explicitly rather than
        // relying on that default, then newest-created within each group.
        tasks: { orderBy: [{ completedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }] },
      },
    });
    if (!full) throw new NotFoundException('Deal not found');
    return {
      ...this.shapeDeal(full),
      dialogId: full.dialogId,
      source: full.source,
      activities: full.activities.map((a) => ({
        id: a.id,
        kind: a.kind,
        text: a.text,
        authorName: a.author?.name ?? null,
        createdAt: a.createdAt,
      })),
      tasks: full.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        dueDate: t.dueDate,
        completedAt: t.completedAt,
        createdAt: t.createdAt,
      })),
    };
  }

  private shapeDeal(d: any) {
    const customFields: Record<string, string | null> = {};
    for (const v of d.customFieldValues ?? []) customFields[v.field.key] = v.value;
    // Computed from d.tasks itself rather than trusted to already be "the
    // soonest-due open task" at d.tasks[0] — getBoard's own include DOES
    // sort that way before capping to 1, but getDeal's include sorts by
    // completedAt/createdAt instead (right for ITS OWN "open tasks first in
    // the full list" use), so trusting a shared [0] here silently picked
    // the wrong "next" task depending on which caller ran the query (found
    // in review — latent, since nothing consumed getDeal's copy of this
    // yet). Re-deriving it here means shapeDeal never depends on the
    // caller's own query ordering at all.
    const openTasks = Array.isArray(d.tasks) ? d.tasks.filter((t: any) => !t.completedAt) : [];
    // openTaskCount prefers the real _count (getBoard's own include has one)
    // — getDeal doesn't fetch that aggregate, but its own `tasks` include IS
    // the complete, uncapped list, so openTasks.length is exactly as
    // accurate there; getBoard's own `tasks` is capped to 1 (just the
    // soonest-due preview), which is why it needs the separate _count to
    // not undercount.
    const openTaskCount = d._count?.tasks ?? openTasks.length;
    const nextOpenTask = [...openTasks].sort((a: any, b: any) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    })[0];
    return {
      id: d.id,
      title: d.title,
      name: d.name,
      phone: d.phone,
      email: d.email,
      amount: d.amount ? Number(d.amount) : null,
      currency: d.currency,
      stageId: d.stageId,
      assignedUserId: d.assignedUserId,
      assignedUserName: d.assignedUser?.name ?? null,
      source: d.source,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      customFields,
      // Shown as a small badge on the card itself (see cabinet-next's
      // deal-card) — "a task is set" was previously only visible after
      // opening the deal (found live: "на карточке лида должно быть видно,
      // что поставлена задача").
      openTaskCount,
      nextTaskDueDate: nextOpenTask?.dueDate ?? null,
    };
  }

  async createDeal(companyId: string, userId: string, companyRole: string, input: DealInput) {
    const pipeline = await getOrCreateDefaultPipeline(this.prisma, companyId);
    const stage = input.stageId ? pipeline.stages.find((s) => s.id === input.stageId) : pipeline.stages[0];
    if (!stage) throw new BadRequestException('Invalid stage');

    const assignedUserId = input.assignedUserId ?? (this.canSeeAllDeals(companyRole) ? null : userId);
    const deal = await this.prisma.deal.create({
      data: {
        companyId,
        title: input.title?.trim() || 'Новая сделка',
        name: input.name,
        phone: input.phone,
        email: input.email,
        amount: input.amount ?? undefined,
        currency: input.currency ?? 'RUB',
        stageId: stage.id,
        assignedUserId,
        source: 'manual',
      },
    });
    await this.prisma.dealActivity.create({ data: { dealId: deal.id, authorUserId: userId, kind: 'system', text: 'Сделка создана' } });
    return this.getDeal(companyId, deal.id, userId, companyRole);
  }

  async updateDeal(companyId: string, dealId: string, userId: string, companyRole: string, input: DealInput) {
    const deal = await this.assertDealVisible(companyId, dealId, userId, companyRole);
    this.assertCanEdit(deal, userId, companyRole);

    if (input.assignedUserId !== undefined && !this.canSeeAllDeals(companyRole)) {
      throw new ForbiddenException('Только владелец или руководитель может переназначать сделки');
    }

    const stageChanged = input.stageId !== undefined && input.stageId !== deal.stageId;
    if (stageChanged) {
      const stage = await this.prisma.pipelineStage.findFirst({ where: { id: input.stageId, pipeline: { companyId } } });
      if (!stage) throw new BadRequestException('Invalid stage');
    }

    const updated = await this.prisma.deal.update({
      where: { id: dealId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.assignedUserId !== undefined ? { assignedUserId: input.assignedUserId } : {}),
        // A stage change resets both sync timestamps — the retry sweep (and
        // the immediate push right below) treat this exactly like a brand
        // new pending push, since the new stage may have a different (or no)
        // CRM mapping than the old one.
        ...(stageChanged ? { stageId: input.stageId, bitrix24SyncedAt: null, amocrmSyncedAt: null } : {}),
      },
      include: { stage: true, bot: true },
    });

    if (input.customFields) {
      for (const [key, value] of Object.entries(input.customFields)) {
        const field = await this.prisma.customFieldDefinition.findUnique({ where: { companyId_key: { companyId, key } } });
        if (!field) continue;
        await this.prisma.dealCustomFieldValue.upsert({
          where: { dealId_fieldId: { dealId, fieldId: field.id } },
          create: { dealId, fieldId: field.id, value },
          update: { value },
        });
      }
    }

    if (stageChanged) {
      await this.prisma.dealActivity.create({
        data: { dealId, authorUserId: userId, kind: 'stage_change', text: `Стадия изменена на «${updated.stage.name}»` },
      });
      // The old "Заявки" table's "Отметить оплаченным" button set Lead.paidAt
      // directly — deleted along with that whole page when the cabinet moved
      // to this Лиды/CRM kanban (per the owner: "это теперь Лиды или СРМ").
      // A chat-captured deal reaching a "won" stage IS that same real-world
      // event now, so it drives the same field instead of leaving it
      // permanently frozen (found by code review: getAnalytics' paidCur/
      // dashboard "Заявок оплачено" reads only Lead.paidAt, and nothing else
      // in the rewritten UI can set it any more). Only set, never clear, on
      // moving back out of "won" — a lead that already got paid stays paid.
      if (updated.stage.isWon && updated.leadId) {
        await this.prisma.lead.updateMany({
          where: { id: updated.leadId, paidAt: null },
          data: { paidAt: new Date() },
        });
      }
      if (updated.bot) {
        this.crmIntegration
          .pushDeal(
            dealId,
            updated.bot,
            {
              title: updated.title,
              name: updated.name,
              phone: updated.phone,
              email: updated.email,
              amount: updated.amount ? Number(updated.amount) : null,
              currency: updated.currency,
              bitrix24DealId: updated.bitrix24DealId,
              bitrix24LeadId: updated.bitrix24LeadId,
              amocrmLeadId: updated.amocrmLeadId,
            },
            updated.stage,
          )
          .catch(() => {
            // Logged inside pushDeal itself; the retry sweep covers it from here.
          });
      }
    }

    return this.getDeal(companyId, dealId, userId, companyRole);
  }

  async addActivity(companyId: string, dealId: string, userId: string, companyRole: string, text: string) {
    await this.assertDealVisible(companyId, dealId, userId, companyRole);
    if (!text?.trim()) throw new BadRequestException('Текст заметки обязателен');
    await this.prisma.dealActivity.create({ data: { dealId, authorUserId: userId, kind: 'note', text: text.trim() } });
    return this.getDeal(companyId, dealId, userId, companyRole);
  }

  /**
   * A task is its own checkbox item (DealTask.completedAt), not something
   * inferred from the activity feed — but setting one ALSO drops a
   * 'task_created' line into that same feed, so the timeline reads as one
   * continuous story instead of the task list and the notes/history feed
   * silently disagreeing about what happened and when.
   */
  async createTask(companyId: string, dealId: string, userId: string, companyRole: string, title: string, dueDate?: string) {
    await this.assertDealVisible(companyId, dealId, userId, companyRole);
    if (!title?.trim()) throw new BadRequestException('Название задачи обязательно');
    const parsedDueDate = dueDate ? new Date(dueDate) : null;
    if (dueDate && (!parsedDueDate || Number.isNaN(parsedDueDate.getTime()))) {
      throw new BadRequestException('Некорректная дата');
    }
    // $transaction, not two sequential awaits — a crash or dropped connection
    // between the two used to be able to create the task with no matching
    // feed line (or the reverse), which is exactly the "task list and the
    // notes/history feed silently disagree" scenario this feature's own
    // docstring above says it prevents (found by code review).
    await this.prisma.$transaction(async (tx) => {
      const task = await tx.dealTask.create({
        data: { dealId, title: title.trim(), dueDate: parsedDueDate, createdByUserId: userId },
      });
      await tx.dealActivity.create({
        data: { dealId, authorUserId: userId, kind: 'task_created', text: `Поставлена задача: ${task.title}` },
      });
    });
    return this.getDeal(companyId, dealId, userId, companyRole);
  }

  async setTaskCompleted(companyId: string, dealId: string, taskId: string, userId: string, companyRole: string, completed: boolean) {
    await this.assertDealVisible(companyId, dealId, userId, companyRole);
    const task = await this.prisma.dealTask.findFirst({ where: { id: taskId, dealId } });
    if (!task) throw new NotFoundException('Task not found');
    // No-op (and no duplicate activity line) if it's already in that state —
    // a second checkbox click racing the first, or the panel re-rendering
    // with stale props, shouldn't log "выполнена" twice.
    const alreadyInState = completed ? !!task.completedAt : !task.completedAt;
    if (!alreadyInState) {
      // Same reasoning as createTask above — one $transaction, not two
      // sequential awaits, so the checkbox and the feed line can't drift
      // apart on a crash between them.
      await this.prisma.$transaction(async (tx) => {
        await tx.dealTask.update({ where: { id: taskId }, data: { completedAt: completed ? new Date() : null } });
        if (completed) {
          await tx.dealActivity.create({
            data: { dealId, authorUserId: userId, kind: 'task_completed', text: `Задача выполнена: ${task.title}` },
          });
        }
      });
    }
    return this.getDeal(companyId, dealId, userId, companyRole);
  }

  // --- Pipeline / stage configuration (owner-only) ---

  async getPipelineConfig(companyId: string) {
    const pipeline = await getOrCreateDefaultPipeline(this.prisma, companyId);
    return pipeline.stages.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      order: s.order,
      isWon: s.isWon,
      isLost: s.isLost,
      bitrix24CategoryId: s.bitrix24CategoryId,
      bitrix24StageId: s.bitrix24StageId,
      bitrix24TargetType: s.bitrix24TargetType,
      amocrmStatusId: s.amocrmStatusId,
      amocrmPipelineId: s.amocrmPipelineId,
    }));
  }

  async updateStage(companyId: string, companyRole: string, stageId: string, input: Partial<{ name: string; color: string; order: number; isWon: boolean; isLost: boolean; bitrix24CategoryId: string | null; bitrix24StageId: string | null; bitrix24TargetType: string | null; amocrmStatusId: number | null; amocrmPipelineId: number | null }>) {
    if (!this.canManagePipeline(companyRole)) throw new ForbiddenException('Только владелец может настраивать воронку');
    const stage = await this.prisma.pipelineStage.findFirst({ where: { id: stageId, pipeline: { companyId } } });
    if (!stage) throw new NotFoundException('Stage not found');
    await this.prisma.pipelineStage.update({ where: { id: stageId }, data: input });
  }

  async createStage(companyId: string, companyRole: string, name: string) {
    if (!this.canManagePipeline(companyRole)) throw new ForbiddenException('Только владелец может настраивать воронку');
    const pipeline = await getOrCreateDefaultPipeline(this.prisma, companyId);
    const maxOrder = pipeline.stages.reduce((m, s) => Math.max(m, s.order), -1);
    return this.prisma.pipelineStage.create({ data: { pipelineId: pipeline.id, name: name.trim() || 'Новая стадия', order: maxOrder + 1 } });
  }

  async deleteStage(companyId: string, companyRole: string, stageId: string) {
    if (!this.canManagePipeline(companyRole)) throw new ForbiddenException('Только владелец может настраивать воронку');
    const stage = await this.prisma.pipelineStage.findFirst({ where: { id: stageId, pipeline: { companyId } }, include: { deals: { take: 1 } } });
    if (!stage) throw new NotFoundException('Stage not found');
    if (stage.deals.length > 0) throw new BadRequestException('В этой стадии ещё есть сделки — перенесите их перед удалением');
    await this.prisma.pipelineStage.delete({ where: { id: stageId } });
  }

  // --- Custom fields (owner-only to manage; readable by everyone for board rendering) ---

  async listCustomFields(companyId: string) {
    return this.prisma.customFieldDefinition.findMany({ where: { companyId }, orderBy: { order: 'asc' } });
  }

  async createCustomField(companyId: string, companyRole: string, label: string, type: string, options?: string[]) {
    if (!this.canManagePipeline(companyRole)) throw new ForbiddenException('Только владелец может добавлять поля');
    if (!CUSTOM_FIELD_TYPES.includes(type)) throw new BadRequestException('Недопустимый тип поля');
    if (!label?.trim()) throw new BadRequestException('Название поля обязательно');
    const key = label
      .trim()
      .toLowerCase()
      .replace(/[^a-zа-яё0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '') || `field_${Date.now()}`;
    const count = await this.prisma.customFieldDefinition.count({ where: { companyId } });
    return this.prisma.customFieldDefinition.create({
      data: { companyId, key, label: label.trim(), type, options: options ?? undefined, order: count },
    });
  }

  async deleteCustomField(companyId: string, companyRole: string, fieldId: string) {
    if (!this.canManagePipeline(companyRole)) throw new ForbiddenException('Только владелец может удалять поля');
    const field = await this.prisma.customFieldDefinition.findFirst({ where: { id: fieldId, companyId } });
    if (!field) throw new NotFoundException('Field not found');
    await this.prisma.customFieldDefinition.delete({ where: { id: fieldId } });
  }
}
