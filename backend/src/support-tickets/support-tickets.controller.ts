import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SupportTicketsService } from './support-tickets.service';
import { AuthGuard } from '../auth/auth.guard';

interface AuthedRequest extends Request {
  companyId: string;
  userId: string;
}

/** Client side — every route scoped to the caller's own company (req.companyId), same as every other cabinet controller. */
@Controller('api/cabinet/support-tickets')
@UseGuards(AuthGuard)
export class SupportTicketsController {
  constructor(private readonly tickets: SupportTicketsService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.tickets.listForCompany(req.companyId);
  }

  @Get(':id')
  get(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.tickets.getTicketForClient(req.companyId, id);
  }

  @Post()
  create(@Req() req: AuthedRequest, @Body() body: { subject: string; message: string }) {
    return this.tickets.createTicket(req.companyId, req.userId, body.subject ?? '', body.message ?? '');
  }

  @Post(':id/reply')
  reply(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { content: string }) {
    return this.tickets.replyAsClient(req.companyId, id, body.content ?? '');
  }
}
