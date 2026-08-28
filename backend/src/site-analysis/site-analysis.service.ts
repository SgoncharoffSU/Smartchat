import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 500 * 1024;
const MAX_TEXT_CHARS = 4000;
// thorough-mode-only: a configurator/calculator site (seen live: a "что
// входит в стоимость базовой комплектации" spec sheet behind two nested
// clicks) can genuinely have more real content than a normal page — worth
// keeping more of it since this is already the "pay for a real render"
// path. Matches structureKnowledgeText's own prompt cap — no point keeping
// text here that just gets cut off at the next step anyway.
const MAX_TEXT_CHARS_THOROUGH = 10000;

// Below this many characters, a plain fetch almost always means an empty SPA
// shell (React/Vue/etc. with no server-side rendering) rather than a genuinely
// short page — that's when it's worth paying for a real headless-browser render.
const THIN_TEXT_THRESHOLD = 200;
const BROWSER_NAV_TIMEOUT_MS = 12000;
const BROWSER_NAV_TIMEOUT_THOROUGH_MS = 20000;

// Best-effort clicks on common cookie/consent-banner accept buttons before
// reading the page — these overlays block the real content underneath and
// are the single biggest reason a real headless render still comes back thin.
const COOKIE_ACCEPT_PATTERNS = [
  'принять', 'согласен', 'согласна', 'хорошо', 'ок', 'разрешить все',
  'accept', 'agree', 'allow all', 'got it', 'i understand',
];

// thorough-mode-only: many sites hide their most useful content — a full
// spec/what's-included list, a pricing breakdown — behind an accordion or
// "show more" toggle rather than putting it directly on the page. Seen live:
// a "что входит в стоимость базовой комплектации" button that opens a modal
// listing 9 collapsed categories (37 total spec lines) — none of it visible
// without clicking through two separate reveal actions.
const REVEAL_MORE_PATTERNS = [
  'показать ещё', 'показать все', 'показать всё', 'показать больше',
  'развернуть', 'развернуть все', 'развернуть всё', 'подробнее',
  'что входит', 'узнать больше', 'смотреть все', 'смотреть всё', 'состав',
  'read more', 'show more', 'show all', 'expand', 'view details', 'details',
];
// Never click something that also reads like a purchase/submit/auth action,
// even if its label happens to also contain a reveal-more phrase — a false
// click here should never do worse than "found no extra text": it must not
// risk placing an order, sending a form, or logging in as someone.
const UNSAFE_ACTION_SUBSTRINGS = [
  'корзин', 'заказ', 'оплат', 'купить', 'оформит', 'отправит', 'войти',
  'регистра', 'подпиш', 'checkout', 'buy', 'pay', 'submit', 'sign in',
  'sign up', 'subscribe', 'log in',
];

// Common chat-widget vendors, checked against the raw (pre-strip) HTML/script
// src attributes — a cheap but reasonably reliable signal that a site already
// has some kind of live chat, without needing to actually execute the page.
const CHAT_WIDGET_SIGNATURES = [
  'jivosite', 'jivo.ru', 'jivochat', 'tawk.to', 'intercom', 'livechatinc',
  'crisp.chat', 'callibri', 'envybox', 'redhelper', 'talk-me', 'chatra.io',
  'carrotquest', 'usedesk', 'onlinepbx', 'b24-chat', 'bitrix24', 'webim',
  'livetex',
];

// Derived rather than imported directly — keeps this in sync with whatever
// `puppeteer.launch(...).newPage()` actually returns for the installed
// version, same reasoning as the inline `browser` type below.
type PuppeteerPage = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>['newPage']>>;

export interface SiteAnalysisResult {
  text: string | null;
  hasChatWidget: boolean;
}

@Injectable()
export class SiteAnalysisService {
  private readonly logger = new Logger(SiteAnalysisService.name);

  // Headless Chromium is memory-hungry — never let two renders launch at once
  // on this box. Renders queue behind this instead of piling up concurrently.
  private browserQueue: Promise<unknown> = Promise.resolve();

  /**
   * Fetches a page and returns its visible text (nav/scripts/styles stripped)
   * plus whether a known chat-widget vendor's script appears on the page.
   * `text: null` means the fetch itself failed — callers must never invent
   * findings in that case, only say honestly that the site couldn't be read.
   * Tries https first, then falls back to http — plenty of small business
   * sites have a broken/misconfigured cert on the bare domain (seen live: a
   * cert issued only for a "admin." subdomain) but still serve plain HTTP.
   *
   * If the plain fetch comes back suspiciously thin (typical of a JS-rendered
   * SPA with no server-side rendering), falls back to a real headless-browser
   * render before giving up — but only then by default, to keep the common
   * case (a normal server-rendered page) fast and cheap.
   *
   * `thorough: true` is for callers that aren't blocking a live chat turn
   * (owner explicitly adding a site to the knowledge base, or the background
   * provisioning job) — it always renders via the browser in addition to the
   * plain fetch and keeps whichever text is longer, since a cookie banner or
   * other boilerplate can make the plain fetch look non-thin even though the
   * real content is still JS-only. The live in-chat site check does NOT use
   * this — it stays on the fast, thin-text-only heuristic so a visitor never
   * waits an extra 20s on a headless render mid-conversation.
   */
  async analyzeSite(url: string, options?: { thorough?: boolean }): Promise<SiteAnalysisResult> {
    const thorough = options?.thorough ?? false;
    const host = url.replace(/^https?:\/\//i, '');
    const candidates = url.startsWith('http') ? [url] : [`https://${host}`, `http://${host}`];

    let bestResult: SiteAnalysisResult | null = null;
    for (const candidate of candidates) {
      const result = await this.attemptFetch(candidate);
      if (result && result.text && result.text.length >= THIN_TEXT_THRESHOLD && !thorough) return result;
      if (result && !bestResult) bestResult = result;
    }

    for (const candidate of candidates) {
      const rendered = await this.attemptBrowserRender(candidate, thorough);
      if (rendered && rendered.text) {
        const renderedIsLonger = !bestResult?.text || rendered.text.length > bestResult.text.length;
        return {
          text: renderedIsLonger ? rendered.text : bestResult!.text,
          hasChatWidget: bestResult?.hasChatWidget ?? rendered.hasChatWidget,
        };
      }
    }

    return bestResult ?? { text: null, hasChatWidget: false };
  }

  /**
   * Real headless-browser render for JS-only SPAs — queued (see browserQueue)
   * so at most one Chromium process runs at a time, launched fresh and closed
   * immediately after (no long-lived browser instance to leak memory across
   * requests). Any failure here just means "couldn't render", never invents
   * content.
   */
  private async attemptBrowserRender(rawUrl: string, thorough = false): Promise<SiteAnalysisResult | null> {
    const run = async () => {
      let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
      try {
        browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const type = req.resourceType();
          if (type === 'image' || type === 'font' || type === 'media') req.abort();
          else req.continue();
        });

        const timeout = thorough ? BROWSER_NAV_TIMEOUT_THOROUGH_MS : BROWSER_NAV_TIMEOUT_MS;
        await page.goto(rawUrl, { waitUntil: 'networkidle2', timeout });

        // Best-effort — a cookie banner sitting over the real content is the
        // most common reason a render still comes back thin. Never let a
        // failure here (button not found, page navigated away, etc.) break
        // the actual text extraction below.
        try {
          await this.clickFirstMatchingLabel(page, COOKIE_ACCEPT_PATTERNS);
          await new Promise((resolve) => setTimeout(resolve, 800));
        } catch {
          // Ignore — proceed to extraction with whatever's on the page.
        }

        // thorough only — a live in-chat turn can't pay the extra render
        // time, and this is already the "pay more to read more" path. Up to
        // 3 rounds because some reveals are themselves nested (a summary
        // opens a panel that has its own "expand all" inside it — seen live
        // on a real client's site: "что входит в стоимость базовой
        // комплектации" → modal → "развернуть все" → the actual spec list).
        // Each round clicks at most one new match (already-clicked elements
        // are marked so a re-scan can't just click the same thing again) and
        // stops the moment nothing more matches, so a page with no such
        // content costs nothing extra.
        if (thorough) {
          for (let round = 0; round < 3; round++) {
            let clicked = false;
            try {
              clicked = await this.clickFirstMatchingLabel(page, REVEAL_MORE_PATTERNS, UNSAFE_ACTION_SUBSTRINGS);
            } catch {
              break;
            }
            if (!clicked) break;
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
        }

        // A short scroll nudges IntersectionObserver-based lazy content to load.
        try {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await new Promise((resolve) => setTimeout(resolve, 600));
        } catch {
          // Ignore — same reasoning as above.
        }

        const html = await page.content();
        const text = await page.evaluate(() => document.body?.innerText ?? '');
        const hasChatWidget = CHAT_WIDGET_SIGNATURES.some((sig) => html.toLowerCase().includes(sig));

        const cleaned = text.replace(/\s+/g, ' ').trim();
        const cap = thorough ? MAX_TEXT_CHARS_THOROUGH : MAX_TEXT_CHARS;
        return { text: cleaned.slice(0, cap) || null, hasChatWidget };
      } catch (error) {
        this.logger.warn(`Headless render failed for ${rawUrl}: ${String(error)}`);
        return null;
      } finally {
        await browser?.close().catch(() => undefined);
      }
    };

    const queued = this.browserQueue.then(run, run);
    this.browserQueue = queued.catch(() => undefined);
    return queued;
  }

  /**
   * Finds the first not-yet-tried leaf-text element whose own label matches
   * one of `patterns` (case-insensitive) and none of `unsafe`, then clicks
   * the nearest clickable ancestor (button/link/role=button/onclick) within
   * a few levels — falling back to the leaf itself, since plenty of sites
   * build these as styled <div>s rather than real buttons (seen live: the
   * "что входит..." trigger on a real client's site was one). Marks
   * whichever leaf it matched so a later call in the same page (see the
   * multi-round reveal-content loop above) can't just click it again.
   */
  private async clickFirstMatchingLabel(page: PuppeteerPage, patterns: string[], unsafe: string[] = []): Promise<boolean> {
    return page.evaluate(
      (pats: string[], unsafePats: string[]) => {
        const MARK = 'data-sc-tried';
        const candidates = Array.from(document.querySelectorAll('body *'));
        const target = candidates.find((el) => {
          if (el.hasAttribute(MARK)) return false;
          if (el.children.length > 0) return false;
          const label = (el.textContent || '').trim().toLowerCase();
          // Cookie-accept labels are short ("Принять все"), but a real
          // reveal-content trigger reads more like a descriptive sentence
          // ("Что входит в стоимость базовой комплектации" — 43 chars, seen
          // live) — cut off well past that instead of at the old
          // cookie-button-sized 40, or every such label gets silently
          // skipped and nothing looks broken.
          if (!label || label.length >= 80) return false;
          if (unsafePats.some((u) => label.includes(u))) return false;
          return pats.some((p) => label.includes(p));
        });
        if (!target) return false;
        target.setAttribute(MARK, '1');

        let clickable: Element | null = target;
        for (let i = 0; i < 5 && clickable; i++) {
          if (
            clickable.tagName === 'BUTTON' ||
            clickable.tagName === 'A' ||
            clickable.getAttribute('role') === 'button' ||
            (clickable as HTMLElement).onclick
          ) {
            break;
          }
          clickable = clickable.parentElement;
        }
        ((clickable as HTMLElement | null) ?? (target as HTMLElement)).click();
        return true;
      },
      patterns,
      unsafe,
    );
  }

  private async attemptFetch(rawUrl: string): Promise<SiteAnalysisResult | null> {
    let normalizedUrl: string;
    try {
      normalizedUrl = new URL(rawUrl).toString();
    } catch {
      this.logger.warn(`Invalid site URL, skipping analysis: ${rawUrl}`);
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(normalizedUrl, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SmartchatBot/1.0)' },
      });
      if (!response.ok) {
        this.logger.warn(`Site fetch failed: ${normalizedUrl} -> ${response.status}`);
        return null;
      }

      const reader = response.body?.getReader();
      if (!reader) return null;

      let received = 0;
      const chunks: Uint8Array[] = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        chunks.push(value);
        if (received >= MAX_RESPONSE_BYTES) {
          await reader.cancel();
          break;
        }
      }
      const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
      const hasChatWidget = CHAT_WIDGET_SIGNATURES.some((sig) => html.toLowerCase().includes(sig));

      const $ = cheerio.load(html);
      $('script, style, nav, footer, noscript, svg').remove();
      const text = $('body').text().replace(/\s+/g, ' ').trim();

      return { text: text.slice(0, MAX_TEXT_CHARS) || null, hasChatWidget };
    } catch (error) {
      this.logger.warn(`Site analysis failed for ${normalizedUrl}: ${String(error)}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Thin wrapper for callers (provisioning, KB "add site") that only need the visible text. */
  async fetchVisibleText(url: string, options?: { thorough?: boolean }): Promise<string | null> {
    return (await this.analyzeSite(url, options)).text;
  }
}
