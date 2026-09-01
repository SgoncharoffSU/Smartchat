import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { BillingService } from './billing.service';

interface AuthedRequest extends Request {
  companyId: string;
}

/** Cabinet-facing — "Выбрать тариф" reads plans from here, then posts to
 * checkout and redirects the visitor's browser to the returned YooKassa URL. */
@Controller('api/cabinet/tariffs')
@UseGuards(AuthGuard)
export class PaymentsController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  list() {
    return this.billing.listPlans();
  }

  @Post(':id/checkout')
  checkout(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.billing.createCheckout(req.companyId, id);
  }

  @Get('payments')
  payments(@Req() req: AuthedRequest) {
    return this.billing.listPayments(req.companyId);
  }

  @Post('autopay')
  autopay(@Req() req: AuthedRequest, @Body() body: { enabled?: boolean }) {
    return this.billing.setAutoPay(req.companyId, Boolean(body.enabled));
  }
}
