import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ManagerNotesService } from './manager-notes.service';
import { SupportGuard } from '../auth/support.guard';

/** Superadmin-only (same support-admin.html panel as manager/payment-settings) — internal per-bot onboarding notes, never exposed to the cabinet. */
@Controller('api/admin/manager-notes')
@UseGuards(SupportGuard)
export class ManagerNotesAdminController {
  constructor(private readonly notes: ManagerNotesService) {}

  @Get()
  list() {
    return this.notes.listForAdmin();
  }

  @Post(':botId')
  update(@Param('botId') botId: string, @Body() body: { note?: string }) {
    return this.notes.updateNote(botId, body?.note ?? '');
  }

  @Post(':botId/lock')
  lock(@Param('botId') botId: string) {
    return this.notes.lock(botId);
  }

  @Post(':botId/unlock')
  unlock(@Param('botId') botId: string) {
    return this.notes.unlock(botId);
  }
}
