import { BadRequestException, Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

// Backs the standalone QA checklist page (a plain static HTML file served
// from the landing site, NOT a cabinet feature — see landing/qa-checklist.html)
// used by the founder and two partners to jointly test the cabinet and log
// defects (see the checklist page's own "дефектовка" flow). Two flat JSON
// files, sibling of UPLOADS_DIR (same reasoning: outside dist/, never wiped by
// a build, never inside a web-served static root) — this is a throwaway
// internal tool, not customer data, so a real DB table would be overkill.
// Per-item POST (not a whole-state PUT) so three people editing different
// rows at once never clobber each other's concurrent write.
const STATE_FILE = join(process.cwd(), '..', 'qa-checklist-state.json');
// Append-only, newest-first, capped — "кто нашёл дефект / кто отметил
// выполненным" per the founder's own ask ("логами сообщений о дефектах и
// выполнении"). Capped rather than unbounded: this is a short-lived testing
// pass by three people, not a growing audit trail meant to live forever.
const LOG_FILE = join(process.cwd(), '..', 'qa-checklist-log.json');
const LOG_CAP = 500;

type ChecklistEntry = { status?: string; severity?: string; note?: string; by?: string; foundBy?: string; updatedAt?: number };
type LogEntry = { at: number; by: string; key: string; section: string; title: string; status?: string; severity?: string; note?: string };

@Controller('api/qa-checklist')
export class QaChecklistController {
  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(file, 'utf-8'));
    } catch {
      return fallback;
    }
  }

  @Get('state')
  async getState() {
    return this.readJson<Record<string, ChecklistEntry>>(STATE_FILE, {});
  }

  @Get('log')
  async getLog() {
    return this.readJson<LogEntry[]>(LOG_FILE, []);
  }

  @Post('item')
  async setItem(
    @Body()
    body: { key?: string; status?: string; severity?: string; note?: string; by?: string; section?: string; title?: string },
  ) {
    if (!body?.key || typeof body.key !== 'string') throw new BadRequestException('key is required');
    const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'Без имени';

    const state = await this.readJson<Record<string, ChecklistEntry>>(STATE_FILE, {});
    const existing = state[body.key] ?? {};

    // "Пройдено ставит тот, кто нашёл баг" — the founder's own rule, so a
    // defect can't quietly get closed by someone other than whoever actually
    // reported it (no real confirmation that a fix was verified otherwise).
    // Only gates the fail->pass close; reporting a fresh defect or resetting
    // to "не проверено" is open to anyone.
    if (body.status === 'pass' && existing.status === 'fail' && existing.foundBy && existing.foundBy !== by) {
      throw new ForbiddenException(`Пройдено может поставить только ${existing.foundBy} — тот, кто нашёл этот дефект`);
    }

    const merged: ChecklistEntry = { ...existing, by, updatedAt: Date.now() };
    if (body.status !== undefined) {
      merged.status = body.status;
      // Fresh report (not just editing the note/severity on an existing
      // one) — whoever just clicked "Дефект" becomes its owner for the
      // close-out. Clearing on "untested" means the NEXT fail is a clean
      // slate, reported by whoever finds it.
      if (body.status === 'fail') merged.foundBy = by;
      else if (body.status === 'untested') merged.foundBy = undefined;
    }
    if (body.severity !== undefined) merged.severity = body.severity;
    if (body.note !== undefined) merged.note = body.note;
    state[body.key] = merged;
    await writeFile(STATE_FILE, JSON.stringify(state));

    // One log line per save — a note/severity edit while already "fail" still
    // logs (the founder's own "перепроверил и всё ещё дефект" flow needs a
    // trail too, not just the first time something flips to fail/pass).
    const log = await this.readJson<LogEntry[]>(LOG_FILE, []);
    log.unshift({
      at: Date.now(),
      by,
      key: body.key,
      section: body.section ?? '',
      title: body.title ?? '',
      status: merged.status,
      severity: merged.severity,
      note: merged.note,
    });
    await writeFile(LOG_FILE, JSON.stringify(log.slice(0, LOG_CAP)));

    return merged;
  }
}
