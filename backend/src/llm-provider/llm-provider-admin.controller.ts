import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { LlmProviderService } from './llm-provider.service';
import { SupportGuard } from '../auth/support.guard';

/**
 * Superadmin-only, applies to every account at once — this is which LLM
 * backend ALL bots run on, not a per-company setting. See LlmProviderService
 * for how the switch takes effect immediately with no redeploy.
 */
@Controller('api/admin/llm-providers')
@UseGuards(SupportGuard)
export class LlmProviderAdminController {
  constructor(private readonly llmProviders: LlmProviderService) {}

  @Get()
  list() {
    return this.llmProviders.list();
  }

  // Not wired into the admin UI as a form — see LlmProviderService.create
  // for why. Still a real endpoint: adding a new provider row is something
  // done directly (by whoever has the DB/API access), not through the
  // public admin page.
  @Post()
  create(
    @Body()
    body: {
      name: string;
      type: string;
      apiKey: string;
      baseUrl?: string;
      model: string;
      folderId?: string;
      systemPromptOverride?: string;
    },
  ) {
    return this.llmProviders.create(body);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string) {
    return this.llmProviders.setActive(id);
  }

  // Editable from the cabinet (unlike create() above) — tuning how a
  // reasoning model like DeepSeek behaves is routine tuning, not a new
  // provider integration. Empty string clears the override.
  @Post(':id/system-prompt')
  setSystemPrompt(@Param('id') id: string, @Body() body: { systemPromptOverride?: string }) {
    return this.llmProviders.setSystemPrompt(id, body.systemPromptOverride ?? null);
  }

  // Feeds BillingService's token-plan pricing (cost * TariffPlan.markup-
  // Multiplier) — the real numbers from this provider's own billing page,
  // not an estimate. See LlmProviderService.setCost.
  @Post(':id/cost')
  setCost(@Param('id') id: string, @Body() body: { costRubPer1kInput?: number | null; costRubPer1kOutput?: number | null }) {
    return this.llmProviders.setCost(id, body.costRubPer1kInput ?? null, body.costRubPer1kOutput ?? null);
  }
}
