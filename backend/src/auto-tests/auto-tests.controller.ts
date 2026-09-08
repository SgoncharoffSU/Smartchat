import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AutoTestsService } from './auto-tests.service';
import { AuthGuard } from '../auth/auth.guard';

interface AuthedRequest extends Request {
  companyId: string;
}

/**
 * "Автотесты" — bot QA, not account data, so unlike appearance/goal/CRM
 * this is NOT blocked during either a manager lock (bot-lock.util.ts) or
 * support impersonation — it's exactly the kind of "настройка бота по
 * заявке клиента" work impersonation exists to let a manager do.
 */
@Controller('api/cabinet/auto-tests')
@UseGuards(AuthGuard)
export class AutoTestsController {
  constructor(private readonly autoTests: AutoTestsService) {}

  @Get('scenarios')
  listScenarios(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.autoTests.listScenarios(req.companyId, botId);
  }

  @Post('scenarios')
  createScenario(
    @Req() req: AuthedRequest,
    @Body() body: { title: string; mode: 'simulated' | 'replay'; customerBrief?: string; isCritical?: boolean },
    @Query('botId') botId?: string,
  ) {
    return this.autoTests.createScenario(req.companyId, body, botId);
  }

  @Post('scenarios/from-dialog/:dialogId')
  promoteDialog(
    @Req() req: AuthedRequest,
    @Param('dialogId') dialogId: string,
    @Body() body: { title?: string; isCritical?: boolean },
  ) {
    return this.autoTests.promoteDialog(req.companyId, dialogId, body?.title ?? '', Boolean(body?.isCritical));
  }

  @Delete('scenarios/:id')
  deleteScenario(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.autoTests.deleteScenario(req.companyId, id);
  }

  @Get('latest')
  getLatestRun(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.autoTests.getLatestRun(req.companyId, botId);
  }

  @Get('runs/:id')
  getRun(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.autoTests.getRun(req.companyId, id);
  }

  @Post('run')
  runAll(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.autoTests.runAll(req.companyId, botId);
  }

  @Post('scenarios/:id/run')
  runOne(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.autoTests.runOne(req.companyId, id);
  }
}
