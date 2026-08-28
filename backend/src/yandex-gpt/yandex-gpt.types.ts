export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface FunnelStage {
  stageId: string;
  instructions: string;
  suggestedButtons: string[];
  exitCondition?: string;
  // A/B/C/D... test: alternative instruction texts for this stage. When present,
  // one is randomly assigned per dialog (on its first turn) and used instead of
  // `instructions`, so conversion can later be compared per variant.
  variants?: string[];
}

export interface StructuredReply {
  reply: string;
  buttons: string[];
  nextStage?: string;
  leadCaptured: boolean;
  // True only on the turn where the visitor just gave explicit affirmative
  // consent to processing their personal data (152-FZ) — never inferred from
  // them merely continuing the conversation. Code (not the model) decides
  // whether a lead actually gets persisted, gated on this flag.
  pdConsentGiven?: boolean;
  // True when the visitor asked to have their data deleted. Code redacts the
  // Lead row (if any) the moment this comes back true — never left to a
  // "someone will handle it later" promise with no actual action behind it.
  deletionRequested?: boolean;
  // The visitor's actual question, verbatim or close, when the model genuinely
  // couldn't answer it from anything it knows. Code escalates this to the
  // company's Telegram for a human to answer — never left as just an apology
  // with no real follow-up.
  unansweredQuestion?: string;
  // Short description of what specifically didn't land, filled when the
  // visitor explicitly says the previous answer didn't help / wasn't
  // understood — even if the model itself believed that answer was fine.
  // Also escalated to Telegram, together with the model's own prior reply.
  dissatisfactionSignal?: string;
  // Filled with a knowledge-base file's exact URL (see the "Файлы из базы
  // знаний" block injected into the prompt) when — and only when — sending
  // THAT specific file is actually relevant to what was just asked. Never a
  // URL the model invented itself; code doesn't validate this against the
  // known set, so an invented one would silently render as a broken
  // attachment for the visitor.
  attachmentUrl?: string;
  leadData?: {
    name?: string;
    phone?: string;
    email?: string;
    website?: string;
    // The only place a "no, I don't have a site" answer gets remembered —
    // "website" has nowhere to put a negative, so without this explicit
    // flag the next stage has no way to know the question was already
    // asked and answered (see the field's own instruction in the prompt
    // for why this matters).
    hasWebsite?: boolean;
    businessDescription?: string;
    knowledgeBase?: string;
    preferredChannel?: string;
    // Short, free-text: what the visitor specifically wants — product/service,
    // quantity or budget if mentioned, or the topic of a requested call/
    // consultation. Lets the owner act on a lead without re-asking from
    // scratch; especially load-bearing for a "Продать в чате" goal, where this
    // is the difference between a bare phone number and an actual order.
    interest?: string;
    [key: string]: unknown;
  };
  // Real, measured token count from THIS completion call (callCompletion's
  // own return value) — not an estimate. WidgetService charges a 'token'-
  // plan company's prepaid balance with this right after the reply comes
  // back (see BillingService.chargeTokenUsage); irrelevant for an
  // 'unlimited'-plan or no-plan-yet company, but always populated so the
  // charging code doesn't need to know which plan a company is on.
  tokensUsed?: number;
  // Split out because BillingService.chargeTokenUsage prices input and
  // output tokens at different real per-provider rates (RouterAI's
  // gpt-4o-mini: 4x more per output token) — tokensUsed above stays as the
  // simple total for anything that doesn't care about the split.
  tokensUsedPrompt?: number;
  tokensUsedCompletion?: number;
}
