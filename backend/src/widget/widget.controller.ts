import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { WidgetService } from './widget.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CoachBotDto } from './dto/coach-bot.dto';
import { AddKnowledgeDto } from './dto/add-knowledge.dto';
import { AddCorrectionDto } from './dto/add-correction.dto';
import { PreviewCorrectionDto } from './dto/preview-correction.dto';
import { DislikeMessageDto } from './dto/dislike-message.dto';
import { DiscardMessageDto } from './dto/discard-message.dto';
import { SessionThrottlerGuard } from './session-throttler.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';

interface AuthedRequest extends Request {
  companyId: string;
}

// ThrottlerModule.forRoot is @Global() and registered once, app-wide, in
// app.module.ts with multiple named configs ("widget-session", "cabinet-
// login"). @Throttle() only OVERRIDES the limit for the name(s) you give it —
// it does NOT exempt the route from every other registered config, which
// still gets checked too (via the same guard-level getTracker). Found live:
// real chat messages were being capped at the cabinet's 5-per-5-minutes login
// limit after just 5 messages. @SkipThrottle() is the only way to actually
// exclude a named config from a route.
const WIDGET_SESSION_THROTTLE = { 'widget-session': { limit: Number(process.env.WIDGET_SESSION_RATE_LIMIT ?? 10), ttl: 60_000 } };

@Controller('api/widget')
export class WidgetController {
  constructor(
    private readonly widgetService: WidgetService,
    private readonly auth: AuthService,
  ) {}

  @Post('messages')
  @UseGuards(SessionThrottlerGuard)
  @Throttle(WIDGET_SESSION_THROTTLE)
  @SkipThrottle({ 'cabinet-login': true })
  sendMessage(@Body() dto: SendMessageDto, @Req() req: Request) {
    const visitorIp = (req.headers['x-real-ip'] as string) || req.ip;
    // Only read, never required — a real visitor chatting on a client's site
    // has no cabinet session and none of this applies to them. It's only
    // trainingMode (checked in the service, against bot.companyId) that
    // actually needs it.
    const sessionToken = req.cookies?.[this.auth.cookieName];
    // 'close' fires on a premature client disconnect (chat.js's revealAbort
    // cancelling a superseded isInit/isReveal call — see WidgetService) just
    // as much as on a normal completed request. Only matters if something
    // actually checks .aborted while still mid-flight, so firing late on an
    // already-finished request is harmless.
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    return this.widgetService.sendMessage(dto, visitorIp, sessionToken, controller.signal);
  }

  @Get('history')
  getHistory(@Query('botToken') botToken: string, @Query('sessionId') sessionId: string) {
    return this.widgetService.getHistory(botToken, sessionId);
  }

  // Polled every few seconds by an open chat tab (see chat.js) — the only
  // channel for a team member's answer (delivered outside this visitor's own
  // request/response turn) to actually reach them live. Cheap read-only
  // query, same public/no-guard shape as GET history above.
  @Get('messages/poll')
  getNewMessages(
    @Query('botToken') botToken: string,
    @Query('sessionId') sessionId: string,
    @Query('after') after: string,
  ) {
    return this.widgetService.getNewMessages(botToken, sessionId, after);
  }

  // Deliberately public, no ownership check — see WidgetService.
  // dislikeMessage: it only ever flags a message for later owner review,
  // never writes anything to the bot, so an unauthenticated tester (the
  // whole point of test-chat.html) reporting one is safe.
  @Post('dislike')
  @UseGuards(SessionThrottlerGuard)
  @Throttle(WIDGET_SESSION_THROTTLE)
  @SkipThrottle({ 'cabinet-login': true })
  dislikeMessage(@Body() dto: DislikeMessageDto) {
    return this.widgetService.dislikeMessage(dto.botToken, dto.sessionId, dto.messageId);
  }

  // Deliberately public, no ownership check — same reasoning as /dislike:
  // it only ever removes the CALLING session's own still-unanswered last
  // message (see MessagesService.discardLastUnanswered), never anything
  // that's already been replied to.
  @Post('discard')
  @UseGuards(SessionThrottlerGuard)
  @Throttle(WIDGET_SESSION_THROTTLE)
  @SkipThrottle({ 'cabinet-login': true })
  discardMessage(@Body() dto: DiscardMessageDto) {
    return this.widgetService.discardLastMessage(dto.botToken, dto.sessionId);
  }

  // Owner-only: this permanently rewrites the bot's system prompt, unlike
  // /messages which only affects the caller's own conversation. Requires the
  // same cabinet session cookie as /api/cabinet/*, and the service verifies
  // the bot actually belongs to that company — a public widgetToken alone
  // (visible in any client site's page source) is no longer sufficient.
  @Post('coach')
  @UseGuards(AuthGuard)
  coachBot(@Body() dto: CoachBotDto, @Req() req: AuthedRequest) {
    return this.widgetService.coachBot(dto.botToken, dto.advice, req.companyId);
  }

  // Same ownership model as /coach: owner-only, permanently appends to the
  // bot's system prompt as business knowledge rather than behaviour advice.
  @Post('knowledge')
  @UseGuards(AuthGuard)
  addKnowledge(@Body() dto: AddKnowledgeDto, @Req() req: AuthedRequest) {
    return this.widgetService.addKnowledge(dto.botToken, dto.text, req.companyId);
  }

  // Same ownership model as /coach and /knowledge — the owner flagging a
  // specific bad reply while testing their own bot in the cabinet. See
  // KnowledgeService.createCorrection.
  @Post('correction')
  @UseGuards(AuthGuard)
  addCorrection(@Body() dto: AddCorrectionDto, @Req() req: AuthedRequest) {
    return this.widgetService.addCorrection(
      dto.botToken,
      dto.situationContext ?? '',
      dto.badReply ?? '',
      dto.goodReply,
      req.companyId,
    );
  }

  // Preview step ahead of /correction — see WidgetService.previewCorrection.
  @Post('correction/preview')
  @UseGuards(AuthGuard)
  previewCorrection(@Body() dto: PreviewCorrectionDto, @Req() req: AuthedRequest) {
    return this.widgetService.previewCorrection(
      dto.botToken,
      dto.situationContext ?? '',
      dto.badReply ?? '',
      dto.note,
      req.companyId,
    );
  }
}
