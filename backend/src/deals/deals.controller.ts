import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { DealsService } from './deals.service';

interface AuthedRequest extends Request {
  companyId: string;
  userId: string;
  companyRole?: string;
}

/**
 * The mini-CRM's own API surface — separate from CabinetController's
 * lead/analytics endpoints (those keep reading Lead/Company as before, see
 * DealsService's own comment on why Deal is a parallel entity, not a
 * replacement). Mounted under the same AuthGuard/session cookie as the rest
 * of the cabinet, so crm.html can reuse it with no separate login system —
 * just a different page that never touches bot/billing routes.
 */
@Controller('api/cabinet/deals')
@UseGuards(AuthGuard)
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  getBoard(@Req() req: AuthedRequest) {
    return this.deals.getBoard(req.companyId, req.userId, req.companyRole ?? 'owner');
  }

  @Get(':id')
  getDeal(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.deals.getDeal(req.companyId, id, req.userId, req.companyRole ?? 'owner');
  }

  @Post()
  createDeal(@Req() req: AuthedRequest, @Body() body: any) {
    return this.deals.createDeal(req.companyId, req.userId, req.companyRole ?? 'owner', body);
  }

  @Patch(':id')
  updateDeal(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: any) {
    return this.deals.updateDeal(req.companyId, id, req.userId, req.companyRole ?? 'owner', body);
  }

  @Post(':id/activities')
  addActivity(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { text: string }) {
    return this.deals.addActivity(req.companyId, id, req.userId, req.companyRole ?? 'owner', body.text);
  }

  @Get('pipeline/stages')
  getPipeline(@Req() req: AuthedRequest) {
    return this.deals.getPipelineConfig(req.companyId);
  }

  @Post('pipeline/stages')
  createStage(@Req() req: AuthedRequest, @Body() body: { name: string }) {
    return this.deals.createStage(req.companyId, req.companyRole ?? 'owner', body.name);
  }

  @Patch('pipeline/stages/:stageId')
  updateStage(@Req() req: AuthedRequest, @Param('stageId') stageId: string, @Body() body: any) {
    return this.deals.updateStage(req.companyId, req.companyRole ?? 'owner', stageId, body);
  }

  @Delete('pipeline/stages/:stageId')
  deleteStage(@Req() req: AuthedRequest, @Param('stageId') stageId: string) {
    return this.deals.deleteStage(req.companyId, req.companyRole ?? 'owner', stageId);
  }

  @Get('custom-fields/list')
  listCustomFields(@Req() req: AuthedRequest) {
    return this.deals.listCustomFields(req.companyId);
  }

  @Post('custom-fields/list')
  createCustomField(@Req() req: AuthedRequest, @Body() body: { label: string; type: string; options?: string[] }) {
    return this.deals.createCustomField(req.companyId, req.companyRole ?? 'owner', body.label, body.type, body.options);
  }

  @Delete('custom-fields/:fieldId')
  deleteCustomField(@Req() req: AuthedRequest, @Param('fieldId') fieldId: string) {
    return this.deals.deleteCustomField(req.companyId, req.companyRole ?? 'owner', fieldId);
  }
}
