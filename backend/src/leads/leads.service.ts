import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

interface LeadData {
  name?: string;
  phone?: string;
  email?: string;
  [key: string]: unknown;
}

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upserts this dialog's Lead row AND reports whether that upsert actually
   * INSERTED a new row, atomically — see widget.service.ts's
   * chargeConfirmedLead call, which must fire exactly once per real lead,
   * never twice for one.
   *
   * Used to be a separate `existsForDialog` read-then-decide before the
   * upsert — that has a real race: two near-simultaneous turns for the same
   * dialog (a client retry, or two messages landing close together) could
   * both read "no lead yet" before either upsert committed, both charge.
   * Postgres serializes concurrent upserts on the same unique key
   * (dialogId) — only ONE concurrent call actually performs the INSERT; the
   * other blocks until it commits, then runs the UPDATE branch — so
   * `xmax = 0` in the same RETURNING (true only for a row this exact
   * statement inserted, never for one it updated) is a correct, DB-enforced
   * "was this truly new" check with no window for two callers to both see
   * "new".
   */
  async upsertAndCheckNew(dialogId: string, leadData: LeadData): Promise<{ id: string; isNew: boolean }> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; isNew: boolean }>>`
      INSERT INTO "leads" ("id", "dialog_id", "name", "phone", "email", "raw_capture", "created_at")
      VALUES (gen_random_uuid(), ${dialogId}, ${leadData.name ?? null}, ${leadData.phone ?? null}, ${leadData.email ?? null}, ${JSON.stringify(leadData)}::jsonb, now())
      ON CONFLICT ("dialog_id") DO UPDATE SET
        "name" = EXCLUDED."name",
        "phone" = EXCLUDED."phone",
        "email" = EXCLUDED."email",
        "raw_capture" = EXCLUDED."raw_capture"
      RETURNING "id", (xmax = 0) AS "isNew"
    `;
    return rows[0];
  }

  /**
   * Right to erasure (152-FZ): nulls out the PII fields on this dialog's Lead
   * row, if one exists, and stamps redactedAt as the audit trail — the row
   * itself no longer carries the data that was erased, so redactedAt is what
   * proves the request was actually acted on and when. No-op if no Lead was
   * ever created for this dialog (nothing to redact).
   */
  async redact(dialogId: string): Promise<void> {
    const existing = await this.prisma.lead.findUnique({ where: { dialogId } });
    if (!existing) return;
    await this.prisma.lead.update({
      where: { dialogId },
      data: { name: null, phone: null, email: null, rawCapture: Prisma.JsonNull, redactedAt: new Date() },
    });
  }
}
