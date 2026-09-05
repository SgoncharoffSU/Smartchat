import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { BillingService } from './billing.service';

interface AuthedRequest extends Request {
  companyId: string;
}

/** Cabinet-facing — "Выбрать тариф" reads plans from here, then posts to
 * checkout and redirects the visitor's browser to the returned YooKassa URL.
 * Billing is per-bot now (see Bot's own schema comment) — checkout/autopay
 * both accept an optional botId, same fallback-to-oldest-bot convention as
 * every other bot-scoped endpoint in this app (see BillingService's own
 * findOwnedBot): the pre-multi-bot cabinet never sends one and keeps working
 * unchanged, since it only ever meant "this company's one bot" anyway. */
@Controller('api/cabinet/tariffs')
@UseGuards(AuthGuard)
export class PaymentsController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  list() {
    return this.billing.listPlans();
  }

  @Post(':id/checkout')
  checkout(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { botId?: string }) {
    return this.billing.createCheckout(req.companyId, body?.botId, id);
  }

  @Get('payments')
  payments(@Req() req: AuthedRequest) {
    return this.billing.listPayments(req.companyId);
  }

  @Post('autopay')
  autopay(@Req() req: AuthedRequest, @Body() body: { botId?: string; enabled?: boolean }) {
    return this.billing.setAutoPay(req.companyId, body?.botId, Boolean(body?.enabled));
  }
}
