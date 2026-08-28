import { Body, Controller, Logger, NotFoundException, Param, Post } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CrmIntegrationService } from '../leads/crm-integration.service';

/**
 * Receives Bitrix24's own "исходящий вебхук" (outgoing webhook) — a
 * portal-admin-configured feature (Разработчикам → Другое → Исходящий
 * вебхук), NOT an OAuth marketplace app. The owner pastes the URL from
 * CabinetService.getCrmIntegrations's bitrix24InboundWebhookUrl into that
 * portal setting, selecting ONCRMDEALUPDATE/ONCRMLEADUPDATE as the events.
 *
 * Bitrix's own event payload only ever says "this entity changed" (the id),
 * never the new field values — so this calls back to the SAME
 * bitrix24WebhookUrl already stored on the bot (the one used for outbound
 * pushes) to fetch the entity's current STAGE_ID/TITLE/OPPORTUNITY before
 * handing off to CrmIntegrationService.applyInboundBitrix24Update, which
 * does the actual local Deal resolution/update.
 */
@Controller('api/webhooks/bitrix24')
export class Bitrix24WebhookController {
  private readonly logger = new Logger(Bitrix24WebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crmIntegration: CrmIntegrationService,
  ) {}

  @Post(':token')
  async handle(@Param('token') token: string, @Body() body: Record<string, any>): Promise<{ ok: true }> {
    const bot = await this.prisma.bot.findUnique({ where: { bitrix24WebhookToken: token } });
    if (!bot || !bot.bitrix24WebhookUrl) throw new NotFoundException();

    const event = String(body?.event ?? '').toUpperCase();
    const entityId = body?.data?.FIELDS?.ID;
    if (!entityId || (event !== 'ONCRMDEALUPDATE' && event !== 'ONCRMLEADUPDATE')) {
      // Not an event we care about (Bitrix lets an owner subscribe to more
      // than these two) — acknowledge anyway so Bitrix doesn't retry/disable
      // the webhook for "failing".
      return { ok: true };
    }

    const targetType: 'deal' | 'lead' = event === 'ONCRMDEALUPDATE' ? 'deal' : 'lead';
    try {
      const method = targetType === 'deal' ? 'crm.deal.get' : 'crm.lead.get';
      const res = await fetch(`${bot.bitrix24WebhookUrl}${method}.json?id=${encodeURIComponent(String(entityId))}`);
      if (!res.ok) {
        this.logger.warn(`Bitrix24 webhook: failed to fetch current ${targetType} ${entityId}: ${res.status}`);
        return { ok: true };
      }
      const payload = await res.json();
      const fields = payload?.result;
      if (!fields) return { ok: true };

      const stageId = targetType === 'deal' ? fields.STAGE_ID : fields.STATUS_ID;
      const title = fields.TITLE as string | undefined;
      const amount = targetType === 'deal' && fields.OPPORTUNITY != null ? Number(fields.OPPORTUNITY) : undefined;
      if (stageId) {
        await this.crmIntegration.applyInboundBitrix24Update(String(entityId), targetType, String(stageId), title, amount);
      }
    } catch (error) {
      this.logger.warn(`Bitrix24 webhook processing failed: ${String(error)}`);
    }
    return { ok: true };
  }
}
