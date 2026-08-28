import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { YookassaService } from './yookassa.service';
import { LlmProviderService } from '../llm-provider/llm-provider.service';

const RETURN_URL = 'https://chat.glavinstrument.com/cabinet/?paid=1';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly yookassa: YookassaService,
    private readonly llmProviders: LlmProviderService,
  ) {}

  /**
   * The real, live input/output rates a 'token'-plan company is charged per
   * 1000 tokens — active LlmProvider's real cost (from its own billing page,
   * set via the admin panel's "Провайдер ИИ" tab), input and output priced
   * separately since real providers charge them very differently (RouterAI's
   * gpt-4o-mini: 4x more per output token than input), times this plan's
   * markupMultiplier. Falls back to the plan's own flat tokenRubPer1k
   * (same rate both ways) ONLY if no provider cost has been entered yet, so
   * billing still works (at the old placeholder rate) before that's filled
   * in — never silently charges 0.
   */
  private effectiveRates(plan: { tokenRubPer1k: { toNumber(): number } | null; markupMultiplier: { toNumber(): number } }): { input: number; output: number } | null {
    const active = this.llmProviders.getActiveConfig();
    const markup = plan.markupMultiplier.toNumber();
    if (active?.costRubPer1kInput != null && active?.costRubPer1kOutput != null) {
      return { input: active.costRubPer1kInput * markup, output: active.costRubPer1kOutput * markup };
    }
    const fallback = plan.tokenRubPer1k?.toNumber() ?? null;
    if (fallback == null) return null;
    return { input: fallback, output: fallback };
  }

  async listPlans() {
    const plans = await this.prisma.tariffPlan.findMany({ where: { isActive: true }, orderBy: { priceRub: 'asc' } });
    return plans.map((p) => {
      const rates = this.effectiveRates(p);
      return {
        id: p.id,
        kind: p.kind,
        name: p.name,
        priceRub: p.priceRub.toNumber(),
        periodDays: p.periodDays,
        tokenRubPer1kInput: rates?.input ?? null,
        tokenRubPer1kOutput: rates?.output ?? null,
      };
    });
  }

  /**
   * One Payment row per checkout click, 'pending' until the webhook (via
   * confirmPayment below) verifies it actually succeeded. Returns the
   * YooKassa-hosted page to redirect the visitor's browser to.
   */
  async createCheckout(companyId: string, tariffPlanId: string) {
    const plan = await this.prisma.tariffPlan.findUnique({ where: { id: tariffPlanId } });
    if (!plan || !plan.isActive) throw new NotFoundException('Tariff plan not found');

    const payment = await this.prisma.payment.create({
      data: {
        companyId,
        tariffPlanId: plan.id,
        amountRub: plan.priceRub,
        status: 'pending',
      },
    });

    let checkout;
    try {
      checkout = await this.yookassa.createPayment({
        amountRub: plan.priceRub.toFixed(2),
        description: `Тариф «${plan.name}» — Умный Чат`,
        returnUrl: RETURN_URL,
        metadata: { paymentId: payment.id },
      });
    } catch (err) {
      // Leaves the Payment row as 'pending' with no yookassaPaymentId — never
      // silently deleted, so a failed checkout attempt (e.g. YooKassa not
      // configured yet) still shows up if someone goes looking for why a
      // purchase didn't work.
      this.logger.error(`createCheckout failed for company ${companyId}: ${(err as Error).message}`);
      throw new BadRequestException('Не удалось создать платёж. Попробуйте ещё раз позже.');
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { yookassaPaymentId: checkout.id },
    });

    return { paymentId: payment.id, confirmationUrl: checkout.confirmationUrl };
  }

  /**
   * The one thing YookassaWebhookController calls — re-confirms the real
   * status directly with YooKassa using OUR OWN credentials (never trusts
   * the webhook POST body alone, that's trivially fakeable) before crediting
   * anything. Returns quietly for a non-succeeded status (YooKassa also
   * notifies on 'canceled' etc. — nothing to do) or missing metadata.
   */
  async verifyAndConfirmPayment(yookassaPaymentId: string) {
    const real = await this.yookassa.getPayment(yookassaPaymentId);
    if (!real.paid || real.status !== 'succeeded') {
      this.logger.log(`Ignoring webhook for ${yookassaPaymentId}, real status is "${real.status}"`);
      return;
    }
    const paymentId = real.metadata?.paymentId;
    if (!paymentId) {
      this.logger.error(`YooKassa payment ${yookassaPaymentId} succeeded but carries no paymentId metadata`);
      return;
    }
    await this.confirmPayment(paymentId);
  }

  /** Idempotent: a re-delivered webhook for an already-'succeeded' row is a
   * no-op, not a double top-up/extension. */
  private async confirmPayment(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { tariffPlan: true } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status === 'succeeded') return { ok: true, alreadyProcessed: true };

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: payment.id }, data: { status: 'succeeded', confirmedAt: new Date() } });

      const plan = payment.tariffPlan;
      if (plan.kind === 'unlimited') {
        const company = await tx.company.findUnique({ where: { id: payment.companyId } });
        // Extends from "now" unless there's real time left on a still-active
        // period — stacking a renewal on top of unused days instead of
        // discarding them.
        const base = company?.planExpiresAt && company.planExpiresAt > new Date() ? company.planExpiresAt : new Date();
        const periodDays = plan.periodDays ?? 30;
        const expiresAt = new Date(base.getTime() + periodDays * 24 * 60 * 60 * 1000);
        await tx.company.update({
          where: { id: payment.companyId },
          data: { tariffPlanId: plan.id, planExpiresAt: expiresAt },
        });
      } else {
        // 'token' — top up the prepaid RUB balance, never overwrite it.
        await tx.company.update({
          where: { id: payment.companyId },
          data: { tariffPlanId: plan.id, tokenBalanceRub: { increment: payment.amountRub } },
        });
      }
    });

    this.logger.log(`Payment ${payment.id} confirmed for company ${payment.companyId} (plan ${payment.tariffPlan.name})`);
    return { ok: true, alreadyProcessed: false };
  }

  /**
   * Debits the real, measured cost of one completion call from a 'token'
   * plan company's prepaid balance — input and output tokens priced
   * separately (see effectiveRates) — called from WidgetService right after
   * every completion. A no-op for an 'unlimited'-plan or no-plan-yet company
   * (nothing to debit); balance is allowed to go negative rather than
   * mid-reply-cutting a conversation — see isBlocked below for where that
   * actually gets enforced, on the NEXT message instead.
   */
  async chargeTokenUsage(companyId: string, promptTokens: number, completionTokens: number) {
    if (promptTokens <= 0 && completionTokens <= 0) return;
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, include: { tariffPlan: true } });
    if (!company?.tariffPlan || company.tariffPlan.kind !== 'token') return;
    const rates = this.effectiveRates(company.tariffPlan);
    if (!rates) return;

    const costRub = (promptTokens / 1000) * rates.input + (completionTokens / 1000) * rates.output;
    if (costRub <= 0) return;
    await this.prisma.company.update({
      where: { id: companyId },
      data: { tokenBalanceRub: { decrement: costRub } },
    });
  }

  /**
   * True when the bot should stop answering — real billing state only,
   * doesn't touch the older trialEndsAt/subscriptionActive flow (that still
   * governs the "free trial" window on its own, checked separately by
   * whatever already reads those two fields). A 'token' company with a
   * depleted balance is blocked; an 'unlimited' company past planExpiresAt
   * is blocked; anyone else (no tariffPlan chosen) is NOT blocked here —
   * they're still just on the trial.
   */
  async isBlocked(companyId: string): Promise<boolean> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, include: { tariffPlan: true } });
    if (!company?.tariffPlan) return false;
    if (company.tariffPlan.kind === 'unlimited') {
      return !company.planExpiresAt || company.planExpiresAt < new Date();
    }
    return company.tokenBalanceRub.toNumber() <= 0;
  }
}
