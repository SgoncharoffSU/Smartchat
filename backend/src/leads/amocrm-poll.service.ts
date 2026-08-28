import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CrmIntegrationService } from './crm-integration.service';

// amoCRM's inbound sync goes through polling rather than a webhook — a real
// amoCRM webhook subscription needs a full OAuth-registered integration
// (client_id/secret, redirect URL), which the current private-integration
// (subdomain + long-lived token) connection deliberately doesn't set up (see
// CrmIntegrationService's own top comment on v1 scope). Polling works with
// that same long-lived token, no OAuth required.
const POLL_INTERVAL_MS = 5 * 60_000;
const POLL_BATCH_SIZE = 50;

@Injectable()
export class AmoCrmPollService implements OnModuleInit {
  private readonly logger = new Logger(AmoCrmPollService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crmIntegration: CrmIntegrationService,
  ) {}

  onModuleInit() {
    setInterval(() => {
      this.pollAll().catch((error) => {
        this.logger.error(`amoCRM poll sweep threw: ${String(error)}`);
      });
    }, POLL_INTERVAL_MS);
  }

  async pollAll(): Promise<void> {
    const bots = await this.prisma.bot.findMany({
      where: { amocrmSubdomain: { not: null }, amocrmAccessToken: { not: null } },
    });
    for (const bot of bots) {
      await this.pollBot(bot).catch((error) => {
        this.logger.warn(`amoCRM poll failed for bot ${bot.id}: ${String(error)}`);
      });
    }
  }

  private async pollBot(bot: { id: string; amocrmSubdomain: string | null; amocrmAccessToken: string | null; amocrmLastPolledAt: Date | null }): Promise<void> {
    if (!bot.amocrmSubdomain || !bot.amocrmAccessToken) return;
    const since = bot.amocrmLastPolledAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sinceUnix = Math.floor(since.getTime() / 1000);
    const base = `https://${bot.amocrmSubdomain}.amocrm.ru/api/v4`;

    const res = await fetch(`${base}/leads?filter[updated_at][from]=${sinceUnix}&limit=${POLL_BATCH_SIZE}`, {
      headers: { Authorization: `Bearer ${bot.amocrmAccessToken}` },
    });
    // amoCRM returns 204 with no body when nothing matches the filter.
    if (res.status === 204) {
      await this.prisma.bot.update({ where: { id: bot.id }, data: { amocrmLastPolledAt: new Date() } });
      return;
    }
    if (!res.ok) {
      this.logger.warn(`amoCRM poll for bot ${bot.id} failed: ${res.status}`);
      return;
    }
    const payload = await res.json();
    const leads: Array<{ id: number; name?: string; status_id?: number; price?: number }> = payload?._embedded?.leads ?? [];
    for (const lead of leads) {
      if (lead.status_id == null) continue;
      await this.crmIntegration.applyInboundAmoCrmUpdate(String(lead.id), lead.status_id, lead.name, lead.price);
    }
    await this.prisma.bot.update({ where: { id: bot.id }, data: { amocrmLastPolledAt: new Date() } });
  }
}
