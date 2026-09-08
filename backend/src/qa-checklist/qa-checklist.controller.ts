import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

// Backs the standalone QA checklist page (a plain static HTML file served
// from the landing site, NOT a cabinet feature — see landing/qa-checklist.html)
// used by the founder and two partners to jointly test the cabinet and log
// defects (see the checklist page's own "дефектовка" flow). One flat JSON
// file, sibling of UPLOADS_DIR (same reasoning: outside dist/, never wiped by
// a build, never inside a web-served static root) — this is a throwaway
// internal tool, not customer data, so a real DB table would be overkill.
// Per-item POST (not a whole-state PUT) so three people editing different
// rows at once never clobber each other's concurrent write.
const STATE_FILE = join(process.cwd(), '..', 'qa-checklist-state.json');

type ChecklistEntry = { status?: string; severity?: string; note?: string; updatedAt?: number };

@Controller('api/qa-checklist')
export class QaChecklistController {
  private async readState(): Promise<Record<string, ChecklistEntry>> {
    try {
      const raw = await readFile(STATE_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  @Get('state')
  async getState() {
    return this.readState();
  }

  @Post('item')
  async setItem(@Body() body: { key?: string; status?: string; severity?: string; note?: string }) {
    if (!body?.key || typeof body.key !== 'string') throw new BadRequestException('key is required');
    const state = await this.readState();
    const existing = state[body.key] ?? {};
    const merged: ChecklistEntry = { ...existing, updatedAt: Date.now() };
    if (body.status !== undefined) merged.status = body.status;
    if (body.severity !== undefined) merged.severity = body.severity;
    if (body.note !== undefined) merged.note = body.note;
    state[body.key] = merged;
    await writeFile(STATE_FILE, JSON.stringify(state));
    return merged;
  }
}
