import { Injectable, Logger } from '@nestjs/common';
import { ChatTurn, FunnelStage, StructuredReply } from './yandex-gpt.types';
import { DEFAULT_FUNNEL_TEMPLATE } from './default-funnel-template';
import { LlmProviderService } from '../llm-provider/llm-provider.service';

const YANDEX_COMPLETION_URL =
  'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

// Legacy env-var fallback only — used when the llm_providers table has no
// active row yet (a fresh deploy before the superadmin panel ever seeded
// one). Once a row exists, LlmProviderService.getActiveConfig() wins and
// these are never consulted. Kept so an empty table never breaks anything.
const ROUTERAI_COMPLETION_URL = 'https://routerai.ru/api/v1/chat/completions';
const ROUTERAI_DEFAULT_MODEL = 'deepseek/deepseek-v4-pro';

// Shared between parseStructuredReply's last-resort branch and generateReply's
// retry loop (see there) — a single source of truth for "this wasn't actually
// a usable reply, it was the apology", so the retry check can never drift out
// of sync with what gets returned on unrecoverable failure.
const UNRECOVERABLE_REPLY_FALLBACK = 'Извините, произошла ошибка. Повторите, пожалуйста, вопрос.';

// Prepended (not trusted-from-generation) to every generated funnel's
// "handoff" stage — see sanitizeFunnelConfig.
const HANDOFF_CONSENT_GATE_SUFFIX =
  'Прежде чем сделать что-либо ниже в этой стадии: проверь блок "Уже известно о собеседнике". Если ' +
  'согласие на обработку данных там уже отмечено — просто следуй остальным инструкциям этой стадии как ' +
  'есть. Если согласия там ещё нет — в этой реплике НЕ выполняй остальные инструкции стадии и НЕ отмечай ' +
  'leadCaptured=true; вместо этого одной короткой тёплой фразой предупреди, что для передачи контакта ' +
  'нужно согласие на обработку персональных данных, и предложи кнопками согласиться или уточнить, что ' +
  'это значит. Как только получишь явное согласие — установи pdConsentGiven=true в этом же ответе и сразу ' +
  'продолжай остальными инструкциями этой стадии в этом же сообщении.';

const OUTPUT_CONTRACT = `
Your entire response must be EXACTLY one valid JSON object and nothing else:
- No markdown, no \`\`\` code fences, no backticks, no comments, no text before or after the JSON.
- The JSON must be parseable by a strict JSON parser (each field appears exactly once, arrays use a single pair of brackets).

Shape (all fields required):
{
  "reply": string,
  "buttons": string[],
  "nextStage": string,
  "leadCaptured": boolean,
  "pdConsentGiven": boolean,
  "deletionRequested": boolean,
  "unansweredQuestion": string,
  "dissatisfactionSignal": string,
  "attachmentUrl": string,
  "leadData": {
    "name": string, "phone": string, "email": string,
    "website": string, "hasWebsite": boolean, "businessDescription": string,
    "knowledgeBase": string, "preferredChannel": string, "interest": string
  }
}
Only include the leadData fields you actually have values for (omit the rest or leave as empty strings) —
never invent a value the visitor didn't give you.

"leadData.hasWebsite": set this the moment the visitor answers whether they have a site at all, even if
that answer is a bare "yes"/button click with no URL yet — true the instant they confirm they have a site
at all (fill "website" too, but only once/if a URL is actually given — a plain "yes" alone still sets
hasWebsite=true with "website" left empty), false the instant they say they don't have one yet / no site.
This is the ONLY way either answer gets remembered: without this field explicitly set (to true OR false)
on the very turn the question gets answered, nothing marks the question as already asked — a later stage
has no way to know not to ask it again, and will repeat a question the visitor already answered turns ago.
Omit entirely only while it's genuinely still unknown (never asked yet).

"leadData.interest": fill this whenever the visitor has said what they specifically want — the product or
service, quantity or budget if mentioned, or the topic of a call/consultation they're asking for. One short
sentence, in Russian, close to their own words. This is what lets a human read the lead later and know
exactly what to do, instead of just a bare phone number — fill it as soon as it's known, don't wait for the
handoff turn.

"pdConsentGiven": true ONLY on the exact turn where the visitor just gave explicit affirmative consent
to processing their personal data (clicked an agree-style button, or said an unambiguous "да"/"согласен"
in direct reply to a consent question you asked). Never true just because they kept chatting or gave
their phone/email — providing contact info is not the same as consenting to its processing. false in
every other turn, including the turn where you ask the consent question itself.

"deletionRequested": true the moment the visitor asks to delete/remove their data, in any stage, in any
wording. false otherwise.

"unansweredQuestion": the visitor's own question, verbatim or close, ONLY on a turn where you genuinely
could not answer it from the system prompt, stage instructions, or the "already answered by a human"
knowledge block — leave as an empty string otherwise. This is not for objections you handled by design
(price, "why do you need my data" etc.) — only for a real gap in what you know.

"dissatisfactionSignal": a short (one sentence) description of what specifically didn't land, ONLY on a
turn where the visitor explicitly says your previous answer didn't help, wasn't clear, or was wrong —
even if you believe that answer was correct. Empty string otherwise.

"attachmentUrl": fill this with a file's EXACT url, copied character-for-character from the "Файлы из базы
знаний" block in the system prompt (if that block is present), ONLY when sending that specific file is
genuinely useful for what the visitor just asked (they asked to see a photo, wanted the contract text, etc.)
— never invent a url, never guess one, never fill this from anywhere except that exact block. Empty string
on every other turn, including every turn where no such block was given to you at all. Still write a normal
"reply" alongside it — and don't just label the photo (e.g. NOT only "Вот фото — гарнитур в цвете «дуб
сонома»:"), actually weave in whatever specific, useful detail that file's own description in the block
gives you (where it's installed/displayed, a fact worth mentioning, etc.) — e.g. "Вот эта модель, недавно
установили у клиента в Подмосковье:" or "Этот образец стоит у нас на выставке, можно посмотреть вживую:".
The description is there specifically so you can say something real about THIS file, not just name it.

Valid example for a greeting stage — note the question is narrow and easy to answer in one word or a
click, not an open "tell me about your business" that takes real effort to compose from scratch. This is
shape-only: it deliberately has no self-introduction, so it never becomes a name/company you'd copy — your
own name and company come only from the system prompt above, never from this example.
{"reply": "Подскажите, у вас уже есть сайт компании?", "buttons": ["Да, есть сайт", "Пока нет"], "nextStage": "greeting", "leadCaptured": false, "pdConsentGiven": false, "deletionRequested": false, "unansweredQuestion": "", "dissatisfactionSignal": "", "attachmentUrl": "", "leadData": {}}

Valid example for the VERY NEXT turn, right after the visitor clicks "Да, есть сайт" in reply to the
example above — note that leadData.hasWebsite is set to true on THIS exact turn, even though no URL was
given yet ("website" stays empty until a URL actually shows up). This is the single most commonly missed
field in real traffic: skipping it here means every later stage re-asks a question the visitor already
answered, which reads as not having listened at all.
{"reply": "Отлично! А как сейчас к вам попадают заявки от клиентов?", "buttons": [], "nextStage": "pain_discovery", "leadCaptured": false, "pdConsentGiven": false, "deletionRequested": false, "unansweredQuestion": "", "dissatisfactionSignal": "", "attachmentUrl": "", "leadData": {"hasWebsite": true}}
`.trim();

interface GenerateReplyParams {
  systemPrompt: string;
  stageInstructions: string;
  currentStageId: string;
  stages: FunnelStage[];
  history: ChatTurn[];
  // Optional, additive — only the auto-fired isInit/isReveal turn supplies
  // one (see WidgetService.processMessage). Aborting it mid-flight means the
  // visitor's own real message arrived and superseded it — a deliberate
  // cancellation, not a transient failure, so it must skip the retry loop
  // below entirely rather than burning through MAX_ATTEMPTS on something
  // nobody is waiting for anymore.
  signal?: AbortSignal;
}

// Ballpark placeholder, same caveat as EmbeddingsService's rate constant: not
// pulled from Yandex Cloud's billing API, update once the real per-1000-token
// completion rate is confirmed in the console. Used only for the "generation"
// AiUsageEvent kind (KB structuring, Telegram answer polishing) — the
// visitor-facing chat replies aren't logged here at all yet.
const RUB_PER_1K_COMPLETION_TOKENS = Number(process.env.YANDEX_COMPLETION_RUB_PER_1K_TOKENS ?? '0.2');

@Injectable()
export class YandexGptService {
  private readonly logger = new Logger(YandexGptService.name);
  // Legacy env-var defaults — only actually used when llm_providers has no
  // active row yet (see resolveActiveConfig). Once a superadmin has switched
  // providers even once, these are dead weight kept only as a fallback.
  private readonly apiKey = process.env.YANDEX_API_KEY ?? '';
  private readonly folderId = process.env.YANDEX_FOLDER_ID ?? '';
  private readonly model = process.env.YANDEX_GPT_MODEL ?? 'yandexgpt-lite';

  constructor(private readonly llmProviders: LlmProviderService) {}

  estimateCompletionCostRub(tokens: number): number {
    return (tokens / 1000) * RUB_PER_1K_COMPLETION_TOKENS;
  }

  /**
   * Resolves to whichever provider is currently active in the superadmin
   * panel (llm_providers.isActive) — falls back to the pre-panel env-var
   * switch only if that table is genuinely empty (fresh deploy, nothing
   * seeded yet), so this can never leave the bot unable to answer.
   */
  private resolveActiveConfig(): {
    type: 'yandex' | 'openai_compatible';
    apiKey: string;
    baseUrl: string;
    model: string;
    folderId: string;
    systemPromptOverride: string | null;
  } {
    const active = this.llmProviders.getActiveConfig();
    if (active) {
      return {
        type: active.type === 'yandex' ? 'yandex' : 'openai_compatible',
        apiKey: active.apiKey,
        baseUrl: active.baseUrl ?? ROUTERAI_COMPLETION_URL,
        model: active.model,
        folderId: active.folderId ?? '',
        systemPromptOverride: active.systemPromptOverride,
      };
    }
    if (process.env.LLM_PROVIDER === 'routerai') {
      return {
        type: 'openai_compatible',
        apiKey: process.env.ROUTERAI_API_KEY ?? '',
        baseUrl: ROUTERAI_COMPLETION_URL,
        model: process.env.ROUTERAI_MODEL ?? ROUTERAI_DEFAULT_MODEL,
        folderId: '',
        systemPromptOverride: null,
      };
    }
    return {
      type: 'yandex',
      apiKey: this.apiKey,
      baseUrl: YANDEX_COMPLETION_URL,
      model: this.model,
      folderId: this.folderId,
      systemPromptOverride: null,
    };
  }

  /**
   * Single point where every call site actually reaches the network —
   * everything else in this file only ever builds a messages[] array and a
   * prompt, then parses whatever text comes back. Swapping providers (via
   * the superadmin panel, see resolveActiveConfig) never touches a single
   * call site: both shapes send the same {role, text} in and return the
   * same {text, tokens} out. Throws on a non-2xx response either way, same
   * as the old inline fetches did — callers that retry (generateReply) or
   * catch-and-fall-back (everything else) keep working unchanged.
   */
  private async callCompletion(
    messages: Array<{ role: string; text: string }>,
    options: { temperature: number; maxTokens: number; jsonObjectMode?: boolean; signal?: AbortSignal },
  ): Promise<{ text: string; tokens: number; promptTokens: number; completionTokens: number }> {
    const config = this.resolveActiveConfig();
    // Prepended once, here, rather than in every call site — so a
    // per-provider quirk-fix (e.g. telling a reasoning model to skip visible
    // reasoning) applies to structured replies, KB structuring, polishing,
    // classification, everything, without touching each one individually.
    const effectiveMessages = config.systemPromptOverride
      ? [{ role: 'system', text: config.systemPromptOverride }, ...messages]
      : messages;

    if (config.type === 'openai_compatible') {
      const response = await fetch(config.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          messages: effectiveMessages.map((m) => ({ role: m.role, content: m.text })),
          // Opt-in, not global on this branch — several other callers here
          // (structureKnowledgeText wants a JSON ARRAY, polishAnswer wants
          // plain text) would break under OpenAI's json_object mode, which
          // requires the root to literally be an object. Only
          // requestStructuredReply's OUTPUT_CONTRACT actually needs this.
          // Added after seeing gpt-4o-mini reliably stop wrapping its reply
          // in JSON at all past the first couple of turns of a real
          // conversation, no matter how strongly the prompt insisted —
          // forcing it at the API level fixes that at the source instead of
          // fighting it with more prompt text.
          ...(options.jsonObjectMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: options.signal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`LLM request failed (${config.model}): ${response.status} ${errorText}`);
        throw new Error(`LLM request failed with status ${response.status}`);
      }
      const data = await response.json();
      const text: string = data?.choices?.[0]?.message?.content ?? '';
      const promptTokens = Number(data?.usage?.prompt_tokens ?? 0);
      const completionTokens = Number(data?.usage?.completion_tokens ?? 0);
      const tokens = Number(data?.usage?.total_tokens ?? promptTokens + completionTokens);
      return { text, tokens, promptTokens, completionTokens };
    }

    const response = await fetch(config.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${config.apiKey}` },
      body: JSON.stringify({
        modelUri: `gpt://${config.folderId}/${config.model}`,
        completionOptions: { stream: false, temperature: options.temperature, maxTokens: options.maxTokens },
        messages: effectiveMessages,
      }),
      signal: options.signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`YandexGPT request failed: ${response.status} ${errorText}`);
      throw new Error(`YandexGPT request failed with status ${response.status}`);
    }
    const data = await response.json();
    const text: string = data?.result?.alternatives?.[0]?.message?.text ?? '';
    const promptTokens = Number(data?.result?.usage?.inputTextTokens ?? 0);
    const completionTokens = Number(data?.result?.usage?.completionTokens ?? 0);
    const tokens = Number(data?.result?.usage?.totalTokens ?? promptTokens + completionTokens);
    return { text, tokens, promptTokens, completionTokens };
  }

  // The visitor's question is already saved (see MessagesService.append,
  // called before this ever runs) — a transient hiccup (Yandex 5xx/timeout,
  // or the model's JSON getting cut off mid-object) is OUR problem to absorb,
  // never the visitor's to retype. Up to 3 attempts before ever giving up;
  // each one is a completely fresh completion request, so a one-off
  // truncation or rate-limit blip essentially never reaches the visitor at
  // all — it just costs a slightly longer typing pause.
  //
  // On total failure this THROWS rather than returning an apology as if it
  // were a normal reply — the caller (WidgetService) lets that propagate
  // into a real HTTP error, and chat.js shows a small retry icon on the
  // visitor's own message instead of ever putting apology text in the bot's
  // mouth (see the widget's `retry` request flag). A canned "sorry, an error
  // occurred" bubble was worse than useless: it looked like the bot itself
  // was malfunctioning, on every single visitor's screen, for what's usually
  // a one-off blip a silent retry would have fixed anyway.
  async generateReply(params: GenerateReplyParams): Promise<StructuredReply> {
    // Raised from 3 — seen live: a real outage lasted roughly 30 seconds
    // (four separate calls to this method, each burning through all 3
    // attempts, all failed back to back), long enough to outlast the old
    // budget entirely regardless of backoff. More attempts, spread out with
    // backoff below, give a longer bad patch more room to clear before this
    // ever surfaces as a visible failure to the visitor.
    const MAX_ATTEMPTS = 5;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await this.requestStructuredReply(params);
        if (result.reply !== UNRECOVERABLE_REPLY_FALLBACK) return result;
        lastError = new Error('Model output could not be parsed into a usable reply, even after field-level recovery');
      } catch (error) {
        // A deliberate cancellation (the visitor's real message superseded
        // this auto-fired turn — see WidgetService) is not a transient
        // failure to retry through; it's the caller telling us to stop.
        // Rethrowing immediately lets WidgetService's own abort check skip
        // straight past this instead of burning 5 attempts and ~4.5s of
        // backoff sleeps on a reply nobody is waiting for anymore.
        if (params.signal?.aborted) throw error;
        lastError = error;
      }
      const willRetry = attempt < MAX_ATTEMPTS;
      this.logger.warn(
        `generateReply attempt ${attempt}/${MAX_ATTEMPTS} failed${willRetry ? ', retrying' : ', giving up'}: ${String(lastError)}`,
      );
      if (willRetry) await this.sleep(300 * attempt);
    }

    // Only reached after MAX_ATTEMPTS genuinely-independent completion
    // requests all failed — a real, sustained outage, not a one-off blip.
    this.logger.error(`generateReply gave up after ${MAX_ATTEMPTS} attempts: ${String(lastError)}`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async requestStructuredReply(params: GenerateReplyParams): Promise<StructuredReply> {
    const stageList = params.stages
      .map((s) => `- "${s.stageId}": ${s.instructions}`)
      .join('\n');

    const systemMessage: ChatTurn = {
      role: 'system',
      content: [
        params.systemPrompt,
        `Current funnel stage: "${params.currentStageId}". Stage instructions: ${params.stageInstructions}`,
        `All valid funnel stages (nextStage MUST be exactly one of these ids, never invent a new one):\n${stageList}`,
        OUTPUT_CONTRACT,
      ].join('\n\n'),
    };

    const messages = [systemMessage, ...params.history].map((m) => ({
      role: m.role,
      text: m.content,
    }));

    // Raised from 800, then 1400, then 2000, then 3000 — seen live even at
    // 3000: truncation on this exact turn is NOT fully deterministic
    // (retrying the identical prompt sometimes succeeds, sometimes hits the
    // same "Unexpected end of JSON input" again), which points to ordinary
    // sampling variance, not a fixed per-prompt ceiling. Raised further
    // (3000 -> 8000) once a reasoning-style provider (RouterAI/DeepSeek)
    // entered the rotation: max_tokens there caps REASONING + reply
    // combined, and probing it directly showed reasoning alone burning
    // 0-1900+ tokens on a trivial prompt with huge run-to-run variance —
    // on our real prompt (persona + full stage list + history +
    // OUTPUT_CONTRACT) a long reasoning pass could plausibly eat the whole
    // old budget before the model even started the actual JSON, which is
    // exactly the empty/truncated replies seen live after switching. A
    // non-reasoning model (Yandex) still only ever uses a few hundred
    // tokens regardless of this cap, so there's no real cost to the extra
    // headroom there — it only matters for a provider that actually needs it.
    const { text: rawText, tokens, promptTokens, completionTokens } = await this.callCompletion(messages, { temperature: 0.4, maxTokens: 8000, jsonObjectMode: true, signal: params.signal });
    const validStageIds = new Set(params.stages.map((s) => s.stageId));

    const result = this.parseStructuredReply(rawText, params.currentStageId, validStageIds);
    result.reply = this.debiasOpener(result.reply);
    result.tokensUsed = tokens;
    result.tokensUsedPrompt = promptTokens;
    result.tokensUsedCompletion = completionTokens;
    return result;
  }

  /**
   * Splits a raw-text paste (price lists, FAQs, policies — whatever the
   * owner pastes into "Добавьте информацию") into clean, independent
   * knowledge entries. Declarative facts ("Доставка 2-5 дней") get an
   * inferred implicit question ("Какие сроки доставки?") so retrieval can
   * match a visitor's phrased question against it later; question is left
   * null only when no sensible question fits. Falls back to a single
   * unsplit entry (the whole text as one answer) on any failure — the text
   * still becomes searchable, just not as finely chunked.
   */
  async structureKnowledgeText(rawText: string): Promise<{ entries: Array<{ question: string | null; answer: string }>; tokens: number }> {
    const prompt = `
Ниже — текст с информацией о бизнесе (цены, товары, условия, ответы на вопросы и т.п.),
который владелец вставил для обучения ИИ-консультанта. Разбей его на независимые записи
базы знаний.

Текст:
"""
${rawText.slice(0, 10000)}
"""

Верни ТОЛЬКО JSON-массив (без markdown, без другого текста) объектов вида:
{"question": string или null, "answer": string}

Правила:
- Каждая запись должна быть самостоятельной и понятной без остального текста.
- Если факт декларативный (цена, срок, условие) — сформулируй в question вероятный вопрос
  посетителя, на который отвечает этот факт (например, "Сколько стоит доставка?").
- question оставь null, только если по-настоящему не получается сформулировать вопрос.
- Не выдумывай факты, которых нет в тексте — только переформулируй и раздели то, что реально есть.
- Если в тексте есть перечень с явными подразделами (например, спецификация "что входит в комплектацию",
  разбитая на категории вроде "Каркас", "Печной узел", "Двери") — сделай ОТДЕЛЬНУЮ запись на каждый
  такой подраздел со своим полным перечнем пунктов. НЕ создавай при этом ЕЩЁ ОДНУ общую сводную запись,
  которая повторяет то же самое сразу по всем подразделам целиком — только отдельные записи по одному
  подразделу в каждой, без дублирующего "содержания".
- Никогда не сокращай перечисление словами «и другое», «и т.п.», «и т.д.» — либо перечисли все пункты
  целиком, либо раздели их на отдельные записи, но не отбрасывай молча ни один пункт, который есть в тексте.
- Если число или характеристика похожи на результат ТЕКУЩЕГО выбора в калькуляторе/конфигураторе
  (например, "ваша конфигурация", "итоговая стоимость", количество свай/материала для уже выбранного
  размера) — а не на неизменное свойство, верное для любого варианта — ВСЁ РАВНО ВКЛЮЧИ этот факт в
  ответ (не пропускай его молча), но с оговоркой ("например, для такой-то комплектации...", "зависит от
  размера/модели — уточняется при расчёте"), а не как жёсткий факт, одинаковый для всех случаев.
- Не создавай более 40 записей — если текст длиннее, объединяй близкие факты в одну запись (но не в
  ущерб правилам про подразделы и калькулятор выше).
`.trim();

    try {
      // maxTokens raised alongside the input cap above (2000 -> 4000) — a
      // deep source (product configurator, full spec sheet) genuinely needs
      // more than 2000 tokens to write out up to 40 real, un-truncated
      // entries; that used to mean the JSON just got cut off mid-array, or
      // the model compressed whole subsections away with "и другое" to fit.
      const { text: rawReply, tokens } = await this.callCompletion([{ role: 'system', text: prompt }], {
        temperature: 0.2,
        maxTokens: 4000,
      });
      const stripped = rawReply.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
      const jsonStart = stripped.indexOf('[');
      const jsonEnd = stripped.lastIndexOf(']');
      const parsed = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1));

      const entries = Array.isArray(parsed)
        ? parsed
            .filter((e) => e && typeof e.answer === 'string' && e.answer.trim())
            .slice(0, 30)
            .map((e) => ({ question: typeof e.question === 'string' && e.question.trim() ? e.question.trim() : null, answer: e.answer.trim() }))
        : [];

      if (entries.length === 0) throw new Error('Structuring produced no usable entries');
      return { entries, tokens };
    } catch (error) {
      this.logger.warn(`structureKnowledgeText failed, storing as a single entry: ${String(error)}`);
      return { entries: [{ question: null, answer: rawText.trim() }], tokens: 0 };
    }
  }

  /**
   * Fixes grammar/style in a human's draft answer (e.g. a Telegram reply to
   * an escalated question) WITHOUT changing its factual content — so the
   * owner can confirm a clean version instead of the bot storing/using a
   * typo-ridden first draft verbatim. Falls back to the original text
   * unchanged on any failure — never blocks the reply on a polish error.
   */
  async polishAnswer(rawText: string): Promise<{ text: string; tokens: number }> {
    const prompt = `
Ниже — черновой ответ сотрудника компании на вопрос клиента. Это будет использовано
ИИ-консультантом в диалогах с посетителями сайта.

Черновик: "${rawText.trim()}"

Верни ТОЛЬКО исправленный текст ответа, без markdown, без кавычек, без пояснений.
Исправь опечатки и грамматику, сделай стиль естественным и вежливым (обращение на "Вы").
НИ В КОЕМ СЛУЧАЕ не меняй фактическое содержание, не добавляй и не убирай факты — только
стилистика и грамотность. Если черновик уже написан грамотно и по делу — верни его как есть.
`.trim();

    try {
      const { text: polished, tokens } = await this.callCompletion([{ role: 'system', text: prompt }], {
        temperature: 0.2,
        maxTokens: 500,
      });
      const text = polished.trim();
      if (!text) throw new Error('Empty polish result');
      return { text, tokens };
    } catch (error) {
      this.logger.warn(`polishAnswer failed, using the draft unchanged: ${String(error)}`);
      return { text: rawText.trim(), tokens: 0 };
    }
  }

  /**
   * Free text typed in "Обучение и настройка" with no menu button picked
   * defaults to "structure this into the knowledge base as a fact" — right
   * for the common case (a pasted price list, working hours), wrong when the
   * owner is actually asking the training assistant something ("можно ли
   * открыть ещё один аккаунт?") or telling the bot how to behave ("не
   * упоминай цены"). Neither of those is a fact about the business, and
   * blindly structuring them into the KB is exactly what caused a training-
   * pane question to end up stored as a fake FAQ entry. This runs first to
   * tell the three cases apart. Falls back to "fact" (the old, unconditional
   * behavior) on any failure — never worse than before this existed.
   */
  async classifyTrainingInput(text: string): Promise<{ type: 'fact' | 'question' | 'command'; reply: string; tokens: number }> {
    const prompt = `
Ты — ассистент, который помогает владельцу бизнеса настраивать своего ИИ-продавца («Умный
Чат») в разделе «Обучение и настройка». Он написал сообщение. Определи, что это на самом
деле, прежде чем оно попадёт в базу знаний бота как факт о бизнесе.

Сообщение: "${text.slice(0, 2000)}"

Три варианта:
- "fact" — факт о бизнесе (цена, режим работы, товар, условия и т.п.), который должен знать
  бот-продавец при общении с посетителями сайта. Стандартный, самый частый случай.
- "question" — владелец задаёт вопрос ТЕБЕ (ассистенту по настройке) о том, как это всё
  работает, что можно сделать, можно ли настроить что-то ещё и т.п. Это НЕ факт о бизнесе,
  а вопрос про саму платформу/процесс.
- "command" — владелец даёт ТЕБЕ инструкцию, как боту-продавцу вести себя дальше (например,
  "не упоминай цены", "будь короче", "не предлагай скидку сразу"). Тоже не факт о бизнесе,
  а правило поведения.

Верни ТОЛЬКО JSON (без markdown, без другого текста): {"type": "fact"|"question"|"command", "reply": string}
Поле "reply" заполняй ТОЛЬКО когда type="question" — короткий дружелюбный ответ по существу
на "Вы" (2-3 предложения). Для "fact" и "command" верни "reply": "".
`.trim();

    try {
      const { text: rawReply, tokens } = await this.callCompletion([{ role: 'system', text: prompt }], {
        temperature: 0.2,
        maxTokens: 400,
      });
      const stripped = rawReply.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
      const jsonStart = stripped.indexOf('{');
      const jsonEnd = stripped.lastIndexOf('}');
      const parsed = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1));

      const type = parsed?.type === 'question' || parsed?.type === 'command' ? parsed.type : 'fact';
      const reply = type === 'question' && typeof parsed?.reply === 'string' ? parsed.reply.trim() : '';
      return { type, reply, tokens };
    } catch (error) {
      this.logger.warn(`classifyTrainingInput failed, defaulting to "fact": ${String(error)}`);
      return { type: 'fact', reply: '', tokens: 0 };
    }
  }

  /**
   * For the dislike-review queue in "Обучение бота": unlike
   * classifyTrainingInput (cold, context-free text), this always has the
   * exact situation already pinned down — what the owner writes is
   * specifically about THIS reply, so "we need maximum value out of every
   * action" (the owner's own framing) means routing it to whichever of the
   * three tools actually fits, not defaulting to one. Falls back to
   * "correction" on failure — the narrowest-scoped of the three, since it
   * only ever affects future turns that resemble this exact situation.
   */
  async classifyDislikeNote(
    situationContext: string,
    badReply: string,
    note: string,
  ): Promise<{ type: 'fact' | 'instruction' | 'correction'; tokens: number }> {
    const prompt = `
Владелец бизнеса просматривает диалог своего ИИ-продавца («Умный Чат») с посетителем сайта,
отметил один ответ бота как неудачный и написал заметку, что не так. Определи, во что должна
превратиться эта заметка.

Посетитель написал: "${situationContext.slice(0, 1000)}"
Бот ответил (неудачно): "${badReply.slice(0, 1000)}"
Заметка владельца: "${note.slice(0, 1000)}"

Три варианта:
- "fact" — заметка сообщает факт о бизнесе, которого бот не знал (цена, условия, товар и
  т.п.) — общее знание, пригодится в любом разговоре на эту тему, не только в этой ситуации.
- "instruction" — заметка описывает правило поведения, которое должно действовать ВСЕГДА, в
  любом разговоре, а не только в похожей ситуации (тон, что нельзя говорить, что всегда
  делать).
- "correction" — заметка — это конкретно "здесь надо было ответить иначе", относится именно к
  этой ситуации/этому типу вопроса, не тянет на общее правило или факт сам по себе.

Верни ТОЛЬКО JSON (без markdown, без другого текста): {"type": "fact"|"instruction"|"correction"}
`.trim();

    try {
      const { text: rawReply, tokens } = await this.callCompletion([{ role: 'system', text: prompt }], {
        temperature: 0.2,
        maxTokens: 200,
      });
      const stripped = rawReply.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(stripped);
      const type = parsed.type === 'fact' || parsed.type === 'instruction' ? parsed.type : 'correction';
      return { type, tokens };
    } catch (error) {
      this.logger.warn(`classifyDislikeNote failed, defaulting to "correction": ${String(error)}`);
      return { type: 'correction', tokens: 0 };
    }
  }

  /**
   * Called only when a new instruction would push the bot past
   * MAX_INSTRUCTION_COUNT — the owner never sees a "limit reached" message
   * (see KnowledgeService.createInstruction), this is what makes that
   * possible without silently downgrading a universal rule into a
   * similarity-retrieved correction, where a rule with no clear topical
   * trigger ("always address as вы") would end up almost never actually
   * firing — a silent failure worse than the rejection it replaces. Instead,
   * merges the full existing set plus the new one into a tighter,
   * deduplicated list that still fits, preserving every rule's intent
   * rather than dropping any of them. Falls back to just appending and
   * truncating to the cap (keeping the newest ones) on any failure — never
   * blocks the save outright.
   */
  async consolidateInstructions(existingTexts: string[], newText: string, maxCount: number): Promise<string[]> {
    const prompt = `
Владелец бизнеса настраивает поведенческие правила своего ИИ-продавца («Умный Чат») — они
применяются ВСЕГДА, к каждому ответу, независимо от темы разговора. Список правил разросся
до предела. Твоя задача — объединить существующие правила с новым в более компактный список
того же смысла, не теряя ни одной инструкции по сути: убери дословные повторы и объедини то,
что явно про одно и то же (например, два похожих правила про обращение на "вы" — в одно), но
НЕ выбрасывай правила, которые говорят о разных вещах, даже если их много.

Существующие правила:
${existingTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Новое правило: "${newText}"

Верни ТОЛЬКО JSON (без markdown, без другого текста): {"instructions": string[]}
Итоговый список — не больше ${maxCount} пунктов. Каждый пункт — короткое самостоятельное
правило, как в исходном списке.
`.trim();

    try {
      const { text: rawReply } = await this.callCompletion([{ role: 'system', text: prompt }], {
        temperature: 0.2,
        maxTokens: 2000,
      });
      const stripped = rawReply.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(stripped);
      const list = Array.isArray(parsed.instructions) ? parsed.instructions.filter((t: unknown) => typeof t === 'string' && t.trim()) : null;
      if (!list || list.length === 0) throw new Error('empty or malformed instructions list');
      return list.slice(0, maxCount);
    } catch (error) {
      this.logger.warn(`consolidateInstructions failed, falling back to newest-${maxCount}: ${String(error)}`);
      return [...existingTexts, newText].slice(-maxCount);
    }
  }

  /**
   * Groups "the bot couldn't answer" questions (Escalation.question, reason:
   * unanswered) by MEANING, not literal text — the same underlying question
   * almost never arrives word-for-word twice ("как оплатить" vs "какая
   * цена"), so a plain string-equality count would show nothing. Used by
   * CabinetService.getRecurringQuestions to surface, inside "Требует
   * внимания", which gaps in the bot's knowledge keep coming up across
   * DIFFERENT visitors — the strongest signal for what's actually worth
   * fixing first, as opposed to a one-off. Falls back to one singleton
   * cluster per question on any failure — the caller then filters those
   * out (count < 2), so a clustering failure just means "nothing recurring
   * found this time", never a crash or a wrong grouping shown as fact.
   */
  async clusterRecurringQuestions(
    items: Array<{ id: string; text: string }>,
  ): Promise<Array<{ representativeText: string; ids: string[] }>> {
    const prompt = `
Ниже пронумерованный список вопросов, которые разные посетители задавали ИИ-продавцу
(«Умный Чат»), и на которые бот не смог сразу ответить. Сгруппируй вопросы, которые
спрашивают ОБ ОДНОМ И ТОМ ЖЕ по смыслу, даже если сформулированы совершенно разными
словами (например, "как оплатить" и "какая цена" — про одно и то же, деньги; а "как
оплатить" и "как подключить бота" — про разное, в разные группы). Каждый вопрос из
списка должен попасть РОВНО в одну группу — если ни на что не похож, это группа из
одного вопроса.

Вопросы:
${items.map((it, i) => `${i + 1} (id=${it.id}): ${it.text.slice(0, 300)}`).join('\n')}

Верни ТОЛЬКО JSON (без markdown, без другого текста):
{"clusters": [{"representativeText": string, "ids": string[]}]}
"representativeText" — самая ясная и короткая формулировка вопроса из группы (можно
слегка поправить грамматику, суть не менять). "ids" — id всех вопросов этой группы
из списка выше, как есть.
`.trim();

    const fallback = () => items.map((it) => ({ representativeText: it.text, ids: [it.id] }));
    try {
      const { text: rawReply } = await this.callCompletion([{ role: 'system', text: prompt }], {
        temperature: 0.1,
        maxTokens: 3000,
      });
      const stripped = rawReply.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(stripped);
      const clusters = Array.isArray(parsed.clusters) ? parsed.clusters : null;
      if (!clusters) throw new Error('missing "clusters" array');
      const knownIds = new Set(items.map((it) => it.id));
      const seen = new Set<string>();
      const result: Array<{ representativeText: string; ids: string[] }> = [];
      for (const c of clusters) {
        if (typeof c?.representativeText !== 'string' || !Array.isArray(c.ids)) continue;
        const ids = c.ids.filter((id: unknown) => typeof id === 'string' && knownIds.has(id) && !seen.has(id));
        ids.forEach((id: string) => seen.add(id));
        if (ids.length > 0) result.push({ representativeText: c.representativeText, ids });
      }
      // Any id the model dropped or duplicated still needs to be accounted
      // for somewhere, or it silently vanishes from the view — put each back
      // as its own singleton rather than lose it.
      for (const it of items) {
        if (!seen.has(it.id)) result.push({ representativeText: it.text, ids: [it.id] });
      }
      return result;
    } catch (error) {
      this.logger.warn(`clusterRecurringQuestions failed, falling back to no grouping: ${String(error)}`);
      return fallback();
    }
  }

  /**
   * Generates a tailored funnel for a newly-provisioned client bot from
   * whatever business info is available. Never throws — falls back to the
   * generic DEFAULT_FUNNEL_TEMPLATE on any failure (bad JSON, missing
   * required stages, network error), since provisioning must always leave
   * the client with a working bot.
   */
  async generateFunnelConfig(params: {
    businessDescription: string;
    knowledgeBase?: string | null;
    siteText?: string | null;
  }): Promise<FunnelStage[]> {
    const prompt = `
Ты проектируешь сценарий продаж (воронку) для ИИ чат-бота, который встроят на сайт
конкретного бизнеса. На основе информации о бизнесе ниже составь JSON-массив стадий
воронки, заточенный под этот бизнес.

Описание бизнеса: ${params.businessDescription}
${params.knowledgeBase ? `Заметки о товарах/ценах/каталоге: ${params.knowledgeBase}` : ''}
${params.siteText ? `Текст с главной страницы их сайта: ${params.siteText}` : ''}

КРИТИЧЕСКИ ВАЖНО — не выдумывай факты: используй в instructions только те конкретные
товары, услуги, опции, характеристики и цены, которые реально есть в тексте выше
(описание бизнеса / заметки / текст сайта). Если текста сайта нет или в нём мало
конкретики — не придумывай правдоподобные детали "от общих знаний о нише" (например,
не пиши, что у бани есть "сауна, бассейн, зона отдыха", если это не упомянуто в
исходном тексте — это выглядит как то, что сайт вообще не смотрели). Формулируй instructions
в этом случае честно и обобщённо (например, "спроси, что именно из ассортимента интересует
собеседника" вместо перечисления конкретных опций) — обобщённый, но правдивый сценарий
лучше, чем конкретный, но придуманный.

Верни ТОЛЬКО JSON-объект (без markdown, без другого текста) вида:
{"stages": [ {"stageId": string, "instructions": string, "suggestedButtons": string[], "exitCondition"?: "handoff" | "closed"}, ... ], "greetingHooks": string[]}

Требования к stages:
- Обязательно должна быть стадия "greeting" (открывает разговор, БЕЗ поля exitCondition)
  и стадия "handoff" (exitCondition: "handoff", просит контакт, когда посетитель
  заинтересован).
- Стадия "greeting" ОБЯЗАТЕЛЬНО должна требовать крючок, который удивляет или вызывает
  любопытство под ЭТОТ бизнес — неожиданный факт, наблюдение или обещание показать что-то
  впечатляющее, связанное с нишей (тон — удивление и лёгкость, а не давление или
  провокация). Явно напиши в instructions этой стадии: НЕ начинать с формального
  "Здравствуйте, меня зовут..." и НЕ начинать с банального "Чем можем помочь?" — это
  выглядит как все остальные боты и не цепляет внимание. Представление по имени — чуть
  позже, по ходу разговора.
- ВАЖНО: поле exitCondition можно указывать ТОЛЬКО у стадий "handoff" и "closed" —
  у всех промежуточных стадий (выявление потребности, питч и т.п.) поле exitCondition
  не указывай вообще (не пиши null, просто пропусти это поле). Если оно есть у
  промежуточной стадии, диалог будет ошибочно считаться завершённым раньше времени.
- Пиши "instructions" на русском языке — это инструкции для ИИ-продавца на данной
  стадии разговора именно для ЭТОГО бизнеса (упоминай реальный продукт/услугу).
- Всего 4-6 стадий в естественном порядке продающего диалога (открывающий крючок,
  выявление потребности, питч, хэндофф, и опционально стадия "closed" для отказа).

Требования к greetingHooks:
- Ровно 3 РАЗНЫХ коротких цепляющих фразы — самостоятельные первые реплики бота для
  этого же бизнеса, в том же духе, что описан выше для greeting (удивление/любопытство,
  БЕЗ "Здравствуйте" и БЕЗ "Чем можем помочь"). Это альтернативные варианты для
  A/B/C/D-тестирования разных крючков на реальных посетителях.
- instructions стадии "greeting" должна требовать РОВНО одну из этих же трёх фраз
  (или максимально близкую по духу) как первую реплику.
`.trim();

    try {
      const { text: rawText } = await this.callCompletion([{ role: 'system', text: prompt }], {
        temperature: 0.5,
        maxTokens: 2000,
      });
      const stripped = rawText
        .trim()
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/```$/i, '')
        .trim();
      const jsonStart = stripped.indexOf('{');
      const jsonEnd = stripped.lastIndexOf('}');
      const parsed = JSON.parse(stripped.slice(jsonStart, jsonEnd + 1));
      const stages = parsed?.stages;

      if (!this.isValidFunnelConfig(stages)) {
        throw new Error('Generated funnel is malformed or missing required stages');
      }
      const sanitized = this.sanitizeFunnelConfig(stages);

      const hooks: string[] = Array.isArray(parsed?.greetingHooks)
        ? parsed.greetingHooks.filter((h: unknown) => typeof h === 'string' && h.trim()).slice(0, 4)
        : [];
      if (hooks.length > 0) {
        const greetingIdx = sanitized.findIndex((s) => s.stageId === 'greeting');
        if (greetingIdx !== -1) {
          sanitized[greetingIdx] = {
            ...sanitized[greetingIdx],
            variants: hooks.map((h) => this.buildPinnedOpenerInstruction(h)),
          };
        }
      }
      return sanitized;
    } catch (error) {
      this.logger.warn(`generateFunnelConfig failed, falling back to default template: ${String(error)}`);
      return DEFAULT_FUNNEL_TEMPLATE;
    }
  }

  /**
   * Wraps a single opener phrase (AI-generated or typed in by the owner via
   * the cabinet's "своя фраза" field) into the same pinned-instruction shape
   * used for every A/B/C/D greeting variant — one place defining that shape
   * so manually-added variants are tested on identical footing.
   */
  buildPinnedOpenerInstruction(hook: string): string {
    return (
      `Твоя первая реплика должна быть РОВНО такой, без изменений: "${hook.trim()}" Не добавляй приветствие ` +
      'или представление — это единственная фраза целиком. Представься по имени позже, по ходу разговора.'
    );
  }

  /**
   * The model sometimes puts exitCondition on intermediate stages despite
   * being told not to, which would mark a dialog "done" the moment it
   * reaches, say, the pitch stage. Strip exitCondition from every stage
   * except the ones actually named "handoff"/"closed" — never trust the
   * model to get this structural rule right on its own.
   *
   * Also appends a fixed PD-consent gate to the "handoff" stage's own
   * instructions, regardless of what the generation prompt produced there —
   * the same reasoning as above: a legally load-bearing behavior (152-FZ
   * consent before a contact is actually captured) can't depend on the model
   * having reliably included it in a one-off generated funnel.
   */
  private sanitizeFunnelConfig(stages: FunnelStage[]): FunnelStage[] {
    return stages.map((s) => {
      if (s.stageId === 'handoff') {
        return { ...s, instructions: `${HANDOFF_CONSENT_GATE_SUFFIX}\n${s.instructions}` };
      }
      return s.stageId === 'closed' ? s : { ...s, exitCondition: undefined };
    });
  }

  private isValidFunnelConfig(value: unknown): value is FunnelStage[] {
    if (!Array.isArray(value) || value.length === 0) return false;
    const stagesValid = value.every(
      (s) =>
        s && typeof s.stageId === 'string' && typeof s.instructions === 'string' && Array.isArray(s.suggestedButtons),
    );
    if (!stagesValid) return false;
    const ids = new Set(value.map((s: FunnelStage) => s.stageId));
    return ids.has('greeting') && ids.has('handoff');
  }

  /**
   * The model sometimes ignores the prompt's ban on the word "Понимаю" as a
   * sentence opener — in various grammatical forms ("Понимаю, что X.", "Понимаю
   * вашу ситуацию.", "Понимаю.") that are too varied to surgically patch word-by-
   * word without risking broken grammar. Instead, cut the *entire* sentence that
   * starts with "Понимаю" and splice in a complete standalone reaction sentence
   * (or nothing) — safe regardless of how the rest of that sentence was phrased.
   *
   * Mostly empty on purpose: swapping every "Понимаю" for a *different* generic
   * filler ("Ясно"/"Бывает") just traded one empty opener for another — seen in
   * live feedback as still feeling thin/empty. Cutting straight to substance is
   * the default; only occasionally does a light one-word reaction survive.
   */
  private readonly openerAlternatives = ['', '', '', 'Ясно. '];

  private debiasOpener(text: string): string {
    // Matches a whole sentence starting with "Понимаю" — from a "^" or a
    // preceding ".", "!" or "?" boundary, through everything up to (and
    // including) its own closing punctuation — and drops it wholesale.
    return text.replace(/(^|[.!?]\s+)понимаю[^.!?]*[.!?]\s*/gi, (_m, boundary: string) => {
      const pick = this.openerAlternatives[Math.floor(Math.random() * this.openerAlternatives.length)];
      return boundary + pick;
    });
  }

  private parseStructuredReply(
    rawText: string,
    fallbackStageId: string,
    validStageIds: Set<string>,
  ): StructuredReply {
    const stripped = rawText
      .trim()
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/```$/i, '')
      .trim();

    // Seen live: for a short, example-heavy instruction (e.g. the hostage-
    // taking rule's "Это, к сожалению, не по моей части..." sample line),
    // the model sometimes answers with ONLY that plain sentence — no JSON
    // wrapper at all. indexOf('{') then returns -1, the slice below becomes
    // empty, and JSON.parse('') throws "Unexpected end of JSON input" — a
    // deterministic failure on every retry, not a truncation fluke, since
    // the same prompt reliably produces the same unwrapped plain answer.
    // The text itself is a perfectly good reply; it just never had braces to
    // find, so treat "no { anywhere at all" as plain text up front rather
    // than only discovering that after JSON.parse already failed.
    if (!stripped.includes('{')) {
      return { reply: stripped, buttons: [], nextStage: fallbackStageId, leadCaptured: false };
    }

    try {
      const jsonStart = stripped.indexOf('{');
      const jsonEnd = stripped.lastIndexOf('}');
      const jsonSlice = stripped.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonSlice);
      const nextStage =
        typeof parsed.nextStage === 'string' && validStageIds.has(parsed.nextStage)
          ? parsed.nextStage
          : fallbackStageId;
      // Distinguishes "the model deliberately chose to stay on the current
      // stage" (silent, not a bug) from "the model returned something we had
      // to discard" (a real format-compliance gap worth knowing about per
      // provider — different models vary a lot in how reliably they pick a
      // valid id from the list, see UNIVERSAL_STAGE_GUIDANCE's stage list).
      if (nextStage === fallbackStageId && parsed.nextStage !== fallbackStageId) {
        this.logger.warn(
          `Model returned invalid/missing nextStage ${JSON.stringify(parsed.nextStage)} (valid: ${[...validStageIds].join(', ')}) — staying on "${fallbackStageId}"`,
        );
      }

      return {
        reply: typeof parsed.reply === 'string' ? parsed.reply : stripped,
        buttons: Array.isArray(parsed.buttons) ? parsed.buttons.slice(0, 4) : [],
        nextStage,
        leadCaptured: Boolean(parsed.leadCaptured),
        pdConsentGiven: Boolean(parsed.pdConsentGiven),
        deletionRequested: Boolean(parsed.deletionRequested),
        unansweredQuestion: typeof parsed.unansweredQuestion === 'string' ? parsed.unansweredQuestion.trim() : undefined,
        dissatisfactionSignal:
          typeof parsed.dissatisfactionSignal === 'string' ? parsed.dissatisfactionSignal.trim() : undefined,
        // Raw pass-through only — NOT validated here (this function has no
        // idea which files were actually offered to the model this turn).
        // WidgetService checks this against the real retrieved-file list
        // before ever saving/sending it, discarding anything that doesn't
        // match exactly (an invented or stale url).
        attachmentUrl: typeof parsed.attachmentUrl === 'string' && parsed.attachmentUrl.trim() ? parsed.attachmentUrl.trim() : undefined,
        leadData: typeof parsed.leadData === 'object' && parsed.leadData !== null ? parsed.leadData : undefined,
      };
    } catch (error) {
      this.logger.warn(`Failed to parse structured reply, attempting field-level recovery: ${String(error)}`);
      // The model produced invalid JSON (e.g. malformed array). Best-effort: pull just
      // the "reply" string out with a regex rather than showing broken JSON to the visitor.
      const replyMatch = stripped.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (replyMatch) {
        const recoveredReply = replyMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        const buttonsMatch = stripped.match(/"buttons"\s*:\s*(\[[^\]]*\])/);
        let buttons: string[] = [];
        if (buttonsMatch) {
          try {
            buttons = JSON.parse(buttonsMatch[1]);
          } catch {
            buttons = [];
          }
        }
        return { reply: recoveredReply, buttons, nextStage: fallbackStageId, leadCaptured: false };
      }

      // Seen live: raising maxTokens (800 → 1400 → 2000 → 3000) never fully
      // stopped this — "reply" is the first field the model writes, so a
      // hard cutoff mid-generation very often lands right inside its string
      // value, before the closing quote the strict match above requires.
      // Same 3 attempts, same truncation every time (retrying doesn't help
      // when it's not a one-off blip) — the actual generated text is real
      // and usable, just missing its closing quote and everything after.
      // Recovering it beats the canned apology below, which was the one
      // thing the visitor actually complained about: a stuck "!" they
      // couldn't get past no matter how many times they retried.
      const partialReplyMatch = stripped.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)$/);
      if (partialReplyMatch) {
        const recovered = partialReplyMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        // Trim back to the last complete sentence — showing a fragment cut
        // off mid-word reads as broken, where the same text ending at its
        // last finished sentence just reads as a normal, slightly shorter
        // answer. If the cutoff happened before even ONE full sentence
        // finished, there's nothing clean to salvage — better to let the
        // caller's own retry loop try again (or fall through to the apology
        // below) than show a ragged, punctuation-less fragment.
        const lastSentenceEnd = Math.max(recovered.lastIndexOf('.'), recovered.lastIndexOf('!'), recovered.lastIndexOf('?'));
        if (lastSentenceEnd > 0) {
          const trimmed = recovered.slice(0, lastSentenceEnd + 1).trim();
          if (trimmed.length >= 10) {
            this.logger.warn('Recovered a truncated reply by trimming it to its last complete sentence');
            return { reply: trimmed, buttons: [], nextStage: fallbackStageId, leadCaptured: false };
          }
        }
      }

      return {
        reply: UNRECOVERABLE_REPLY_FALLBACK,
        buttons: [],
        nextStage: fallbackStageId,
        leadCaptured: false,
      };
    }
  }
}
