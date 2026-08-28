import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @MinLength(1)
  botToken!: string;

  @IsString()
  @MinLength(1)
  sessionId!: string;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsString()
  buttonPayload?: string;

  // True for the very first turn of a dialog: the widget didn't collect any
  // real visitor input, it just wants the bot's opening line. No visitor
  // message is stored for this turn — only allowed when the dialog is empty.
  @IsOptional()
  @IsBoolean()
  isInit?: boolean;

  // True right when the visitor actually opens the chat window, immediately
  // after the outside teaser hook (isInit) already fired. No visitor message
  // is stored for this turn either — only valid when the dialog has exactly
  // one prior (assistant) message.
  @IsOptional()
  @IsBoolean()
  isReveal?: boolean;

  // True for the owner's own test/training session in the cabinet (widget.js
  // data-preview="true"). The bot's replies are identical either way, but a
  // question the OWNER asks while deliberately testing must never trigger
  // the same "real customer is stuck" escalation to Telegram that a genuine
  // visitor's unanswered question would — that's just noise from your own
  // testing, not a signal. Corrections from a preview session go through
  // coachBot instead, which the owner triggers on purpose.
  @IsOptional()
  @IsBoolean()
  isPreview?: boolean;

  // True when the cabinet's test widget is switched to "Обучение" instead of
  // "Тестирование". Bypasses the bot's own sales funnel entirely in favor of
  // a fixed onboarding wizard that asks the owner about their business and
  // feeds each answer into the knowledge base — see widget.service.ts's
  // processTrainingMessage. Implies isPreview (never escalates, never counted
  // in analytics) even if the caller didn't also set isPreview.
  @IsOptional()
  @IsBoolean()
  trainingMode?: boolean;

  // The real page hostname widget.js is actually running on (window.location.
  // hostname), sent on the isInit call — a client-reported value read by our
  // own script, not a trusted security boundary, but a much stronger signal
  // than a self-typed URL in a form. See WidgetService.checkDomainIntegrity.
  @IsOptional()
  @IsString()
  pageHostname?: string;

  // Set when the visitor tapped the small retry icon left on their own
  // message after a failed attempt, messenger-style (see chat.js's
  // showSendFailure) — the request still carries the SAME `message`/
  // `buttonPayload` as the original attempt. Not branched on directly in
  // processMessage: whether the previous attempt's text ever actually got
  // saved depends on WHERE it failed (never reached us at all vs. reached us
  // and saved but the reply itself failed to generate — see
  // YandexGptService.generateReply), so processMessage instead compares
  // against the dialog's last message and skips re-saving only if it's
  // already exactly this same unanswered text. This field is just a hint for
  // logs/diagnostics, not something the dedup logic depends on.
  @IsOptional()
  @IsBoolean()
  retry?: boolean;
}
