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
   * Used only to tell a genuinely NEW lead from a later turn that just adds
   * more fields to the same dialog's Lead row (dialogId is @unique — one
   * dialog, at most one Lead) — see widget.service.ts's chargeConfirmedLead
   * call, which must only fire once per lead, not once per turn.
   */
  async existsForDialog(dialogId: string): Promise<boolean> {
    const existing = await this.prisma.lead.findUnique({ where: { dialogId }, select: { id: true } });
    return existing !== null;
  }

  upsert(dialogId: string, leadData: LeadData) {
    return this.prisma.lead.upsert({
      where: { dialogId },
      create: {
        dialogId,
        name: leadData.name,
        phone: leadData.phone,
        email: leadData.email,
        rawCapture: leadData as object,
      },
      update: {
        name: leadData.name,
        phone: leadData.phone,
        email: leadData.email,
        rawCapture: leadData as object,
      },
    });
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
