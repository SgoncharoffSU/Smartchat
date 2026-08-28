import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { CabinetService } from './cabinet.service';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { TelegramService } from '../telegram/telegram.service';
import { AddVariantDto } from './dto/add-variant.dto';
import { LoginThrottlerGuard } from './login-throttler.guard';

// ThrottlerModule.forRoot is @Global(), registered once app-wide (see
// app.module.ts) with multiple named configs ("cabinet-login", "widget-
// session"). @Throttle() only overrides the limit for the name(s) given —
// every OTHER registered config still gets checked too, via this same
// guard's getTracker, unless explicitly @SkipThrottle()'d. Found live: this
// route's ip+email tracker was leaking onto real chat messages too, capping
// them at 5 every 5 minutes. Always pair @Throttle (the one you want) with
// @SkipThrottle (every other registered name).
const CABINET_LOGIN_THROTTLE = { 'cabinet-login': { limit: 5, ttl: 5 * 60_000 } };

interface AuthedRequest extends Request {
  companyId: string;
  userId: string;
  companyRole?: string;
  impersonating?: boolean;
}

@Controller('api/cabinet')
export class CabinetController {
  constructor(
    private readonly cabinet: CabinetService,
    private readonly auth: AuthService,
    private readonly telegram: TelegramService,
  ) {}

  private setSessionCookie(res: Response, session: string) {
    res.cookie(this.auth.cookieName, session, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });
  }

  @Get('registration-info')
  getRegistrationInfo(@Query('token') token: string) {
    return this.cabinet.getRegistrationInfo(token);
  }

  // No cookie set here on purpose — the account exists but is unverified
  // until the confirmation email is clicked (see confirm-email below).
  @Post('register')
  async register(@Body() body: { token: string; email: string; password: string; name: string; consent?: boolean }) {
    const result = await this.cabinet.register(body.token, body.email, body.password, body.name, body.consent === true);
    return { ok: true, pendingConfirmation: true, email: result.email };
  }

  @Post('login')
  @UseGuards(LoginThrottlerGuard)
  @Throttle(CABINET_LOGIN_THROTTLE)
  @SkipThrottle({ 'widget-session': true })
  async login(@Body() body: { email: string; password: string }, @Res({ passthrough: true }) res: Response) {
    const session = await this.cabinet.login(body.email, body.password);
    this.setSessionCookie(res, session);
    return { ok: true };
  }

  @Post('resend-confirmation')
  async resendConfirmation(@Body() body: { email: string; password: string }) {
    await this.cabinet.resendConfirmation(body.email, body.password);
    return { ok: true };
  }

  @Post('forgot-password')
  @UseGuards(LoginThrottlerGuard)
  @Throttle(CABINET_LOGIN_THROTTLE)
  @SkipThrottle({ 'widget-session': true })
  async forgotPassword(@Body() body: { email: string }) {
    await this.cabinet.requestPasswordReset(body.email);
    return { ok: true };
  }

  @Post('reset-password')
  async resetPassword(@Body() body: { token: string; password: string }) {
    await this.cabinet.resetPassword(body.token, body.password);
    return { ok: true };
  }

  @Get('confirm-email')
  async confirmEmail(@Query('token') token: string, @Res({ passthrough: true }) res: Response) {
    const session = await this.cabinet.confirmEmail(token);
    this.setSessionCookie(res, session);
    return { ok: true };
  }

  // The invite email's link target — no session/company context yet (the
  // teammate isn't signed in), same shape as confirm-email above.
  @Post('accept-invite')
  async acceptInvite(@Body() body: { token: string; password: string }, @Res({ passthrough: true }) res: Response) {
    const session = await this.cabinet.acceptInvite(body.token, body.password);
    this.setSessionCookie(res, session);
    return { ok: true };
  }

  @Get('team')
  @UseGuards(AuthGuard)
  listTeam(@Req() req: AuthedRequest) {
    return this.cabinet.listTeam(req.companyId, req.companyRole ?? 'owner');
  }

  @Post('team/invite')
  @UseGuards(AuthGuard)
  async inviteTeammate(@Req() req: AuthedRequest, @Body() body: { email: string; name: string; companyRole: string }) {
    const result = await this.cabinet.inviteTeammate(req.companyId, req.companyRole ?? 'owner', body.email, body.name, body.companyRole);
    return { ok: true, email: result.email };
  }

  @Post('team/:userId/role')
  @UseGuards(AuthGuard)
  async updateTeammateRole(@Req() req: AuthedRequest, @Param('userId') userId: string, @Body() body: { companyRole: string }) {
    await this.cabinet.updateTeammateRole(req.companyId, req.companyRole ?? 'owner', userId, body.companyRole);
    return { ok: true };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(this.auth.cookieName, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async getMe(@Req() req: AuthedRequest) {
    const me = await this.cabinet.getMe(req.companyId, req.userId);
    return { ...me, impersonating: req.impersonating === true };
  }

  // Bot switcher data — a company only ever sees its own bots.
  @Get('bots')
  @UseGuards(AuthGuard)
  listBots(@Req() req: AuthedRequest) {
    return this.cabinet.listBots(req.companyId);
  }

  // A second (or third...) bot for the same company — starts blank on the
  // generic default funnel, same as any fresh bot; the owner trains it via
  // "Обучение и настройка" same as usual.
  @Post('bots')
  @UseGuards(AuthGuard)
  createBot(@Req() req: AuthedRequest, @Body() body: { name: string }) {
    return this.cabinet.createBot(req.companyId, body.name);
  }

  // Replaced the old "Сила вашего бота" status badge + its dropdown of
  // onboarding nudges — see CabinetService.getReadiness for the full
  // rationale. Trial-expired and pending-escalations alerts (previously
  // also folded into this same endpoint) already have their own dedicated
  // UI (trialBanner, the "Требует внимания" nav badge) and don't need a
  // third place to surface from.
  @Get('readiness')
  @UseGuards(AuthGuard)
  getReadiness(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.getReadiness(req.companyId, botId);
  }

  @Get('embed-snippet')
  @UseGuards(AuthGuard)
  getEmbedSnippet(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.getEmbedSnippet(req.companyId, botId);
  }

  @Get('analytics')
  @UseGuards(AuthGuard)
  getAnalytics(
    @Req() req: AuthedRequest,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('botId') botId?: string,
  ) {
    const allowed = ['week', 'month', 'all', 'yesterday', 'custom'];
    const p = (allowed.includes(period ?? '') ? period : 'week') as
      | 'week'
      | 'month'
      | 'all'
      | 'yesterday'
      | 'custom';
    return this.cabinet.getAnalytics(req.companyId, p, from, to, botId);
  }

  // Same endpoint for Алина's own company and every client — no separate
  // internal-only admin path for connecting escalation notifications.
  @Get('telegram-connect')
  @UseGuards(AuthGuard)
  getTelegramConnect(@Req() req: AuthedRequest) {
    return this.telegram.getConnectionInfo(req.companyId);
  }

  @Post('leads/:id/mark-paid')
  @UseGuards(AuthGuard)
  markLeadPaid(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.cabinet.markLeadPaid(req.companyId, id);
  }

  @Post('escalations/:id/verify')
  @UseGuards(AuthGuard)
  verifyEscalation(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.cabinet.verifyEscalation(req.companyId, id);
  }

  // "Обработано" checkbox — see CabinetService.setEscalationProcessed.
  @Post('escalations/:id/process')
  @UseGuards(AuthGuard)
  setEscalationProcessed(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { processed: boolean }) {
    return this.cabinet.setEscalationProcessed(req.companyId, id, Boolean(body.processed));
  }

  // The "Требует внимания" table only ever showed the one question/reply
  // pair the escalation itself carries — not enough to tell whether the bot
  // actually lost the thread three turns earlier. This hands back the whole
  // surrounding conversation instead, with phone numbers/emails redacted
  // (see CabinetService.redactPii) since this is a debugging tool, not the
  // existing lead-contact view — no reason for raw contact details to sit in
  // a transcript pulled up to diagnose a conversation-quality bug.
  // "Найти повторы" button in "Требует внимания" — on-demand (an LLM call),
  // never auto-loaded. See CabinetService.getRecurringQuestions.
  @Get('escalations/recurring')
  @UseGuards(AuthGuard)
  getRecurringQuestions(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.getRecurringQuestions(req.companyId, botId);
  }

  @Get('escalations/:id/dialog')
  @UseGuards(AuthGuard)
  getEscalationDialog(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.cabinet.getEscalationDialog(req.companyId, id);
  }

  // "Реестр диалогов" — every conversation across every bot of this company,
  // not just the ones tied to an escalation (see the comment on
  // CabinetService.listDialogs). Also used by the CRM deal panel to show
  // the originating conversation via deal.dialogId.
  @Get('dialogs')
  @UseGuards(AuthGuard)
  listDialogs(@Req() req: AuthedRequest, @Query('botId') botId?: string, @Query('page') page?: string) {
    return this.cabinet.listDialogs(req.companyId, { botId, page: page ? parseInt(page, 10) : undefined });
  }

  @Get('dialogs/:id')
  @UseGuards(AuthGuard)
  getDialogDetail(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.cabinet.getDialogDetail(req.companyId, id);
  }

  @Post('reset-stats')
  @UseGuards(AuthGuard)
  resetStats(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.resetStats(req.companyId, botId);
  }

  @Post('variants')
  @UseGuards(AuthGuard)
  addGreetingVariant(@Body() dto: AddVariantDto, @Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.addGreetingVariant(req.companyId, dto.text, botId);
  }

  @Get('goal')
  @UseGuards(AuthGuard)
  getGoal(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.getGoal(req.companyId, botId);
  }

  // Previously only reachable through the training-mode chat's conversational
  // menu (see widget.service.ts) — that follow-up question was just a nicety,
  // not a real requirement, so a direct preset picker in "Настройки чата"
  // works exactly as well and doesn't need a whole chat turn to reach.
  @Post('goal')
  @UseGuards(AuthGuard)
  setGoal(@Body() body: { preset: string; customText?: string }, @Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.setGoal(req.companyId, body.preset, body.customText, botId);
  }

  @Get('integrations/crm')
  @UseGuards(AuthGuard)
  getCrmIntegrations(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.getCrmIntegrations(req.companyId, botId);
  }

  // Owner-facing "new lead" alerts — separate opt-in from Telegram
  // escalations (same connected chat, different toggle) and a plain
  // notification email address, independent of any User's login email.
  @Get('lead-notifications')
  @UseGuards(AuthGuard)
  getLeadNotificationSettings(@Req() req: AuthedRequest) {
    return this.cabinet.getLeadNotificationSettings(req.companyId);
  }

  @Post('lead-notifications')
  @UseGuards(AuthGuard)
  setLeadNotificationSettings(
    @Req() req: AuthedRequest,
    @Body() body: { notifyLeadsViaTelegram?: boolean; notificationEmail?: string | null },
  ) {
    return this.cabinet.setLeadNotificationSettings(req.companyId, body);
  }

  // Real stage/status names+ids from the owner's own connected Bitrix24/
  // amoCRM account, for the pipeline-settings mapping dropdowns.
  @Get('integrations/crm/stages')
  @UseGuards(AuthGuard)
  getCrmStageOptions(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.getCrmStageOptions(req.companyId, botId);
  }

  @Post('integrations/crm/bitrix24')
  @UseGuards(AuthGuard)
  saveBitrix24(@Body() body: { webhookUrl: string }, @Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.saveBitrix24(req.companyId, body.webhookUrl ?? '', botId);
  }

  @Post('integrations/crm/amocrm')
  @UseGuards(AuthGuard)
  saveAmoCrm(
    @Body() body: { subdomain: string; accessToken: string },
    @Req() req: AuthedRequest,
    @Query('botId') botId?: string,
  ) {
    return this.cabinet.saveAmoCrm(req.companyId, body.subdomain ?? '', body.accessToken ?? '', botId);
  }

  @Get('appearance')
  @UseGuards(AuthGuard)
  getAppearance(@Req() req: AuthedRequest, @Query('botId') botId?: string) {
    return this.cabinet.getAppearance(req.companyId, botId);
  }

  @Post('appearance')
  @UseGuards(AuthGuard)
  updateAppearance(
    @Req() req: AuthedRequest,
    @Body() body: { name?: string; label?: string; gender?: string; color?: string; position?: string },
    @Query('botId') botId?: string,
  ) {
    return this.cabinet.updateAppearance(req.companyId, body, botId);
  }

  // Separate from /appearance: that's per-bot (persona name/color/etc.), this
  // is per-company and shared across every one of the company's bots — see
  // CabinetService.updateCompanyName for why it exists at all.
  @Post('company')
  @UseGuards(AuthGuard)
  updateCompanyName(@Req() req: AuthedRequest, @Body() body: { name: string }) {
    return this.cabinet.updateCompanyName(req.companyId, body.name);
  }
}
