import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { SupportTicketsService } from './support-tickets.service';
import { SupportGuard } from '../auth/support.guard';

/** Support-role side — across every company. See SupportGuard for why this is a separate guard, not AuthGuard. */
@Controller('api/admin/support-tickets')
@UseGuards(SupportGuard)
export class SupportTicketsAdminController {
  constructor(private readonly tickets: SupportTicketsService) {}

  @Get()
  list() {
    return this.tickets.listAllForSupport();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.tickets.getTicketForSupport(id);
  }

  @Post(':id/reply')
  reply(@Param('id') id: string, @Body() body: { content: string }) {
    return this.tickets.replyAsSupport(id, body.content ?? '');
  }

  @Post(':id/resolve')
  resolve(@Param('id') id: string, @Body() body: { report: string }) {
    return this.tickets.resolveTicket(id, body.report ?? '');
  }
}
