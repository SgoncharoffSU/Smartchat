import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { TelegramService } from '../telegram/telegram.service';
import { EmailService } from '../email/email.service';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://chat.glavinstrument.com';

@Injectable()
export class SupportTicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly email: EmailService,
  ) {}

  // ---- Client side (scoped to the caller's own company) ----

  async listForCompany(companyId: string) {
    return this.prisma.supportTicket.findMany({
      where: { companyId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getTicketForClient(companyId: string, ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!ticket || ticket.companyId !== companyId) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async createTicket(companyId: string, userId: string, subject: string, message: string) {
    const trimmedSubject = subject.trim();
    const trimmedMessage = message.trim();
    if (!trimmedSubject || !trimmedMessage) throw new BadRequestException('Subject and message are both required');

    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const ticket = await this.prisma.supportTicket.create({
      data: {
        companyId,
        createdByUserId: userId,
        subject: trimmedSubject,
        messages: { create: { senderRole: 'client', content: trimmedMessage } },
      },
    });

    this.telegram
      .alertPlatformAdmin(
        `Новое обращение в поддержку от «${company?.name ?? companyId}»: «${trimmedSubject}»\n\n${trimmedMessage}`,
      )
      .catch(() => {});

    return ticket;
  }

  async replyAsClient(companyId: string, ticketId: string, content: string) {
    const trimmed = content.trim();
    if (!trimmed) throw new BadRequestException('Message cannot be empty');

    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket || ticket.companyId !== companyId) throw new NotFoundException('Ticket not found');

    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    await this.prisma.supportTicketMessage.create({ data: { ticketId, senderRole: 'client', content: trimmed } });
    await this.prisma.supportTicket.update({ where: { id: ticketId }, data: { updatedAt: new Date() } });

    this.telegram
      .alertPlatformAdmin(`Новое сообщение в обращении «${ticket.subject}» от «${company?.name ?? companyId}»:\n\n${trimmed}`)
      .catch(() => {});

    return { ok: true };
  }

  // ---- Support side (across every company — SupportGuard-protected routes only) ----

  async listAllForSupport() {
    const tickets = await this.prisma.supportTicket.findMany({
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      include: { company: { select: { name: true } } },
    });
    return tickets.map((t) => ({
      id: t.id,
      companyId: t.companyId,
      companyName: t.company.name,
      subject: t.subject,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      resolvedAt: t.resolvedAt,
    }));
  }

  async getTicketForSupport(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { messages: { orderBy: { createdAt: 'asc' } }, company: { select: { name: true } } },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async replyAsSupport(ticketId: string, content: string) {
    const trimmed = content.trim();
    if (!trimmed) throw new BadRequestException('Message cannot be empty');

    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    await this.prisma.supportTicketMessage.create({ data: { ticketId, senderRole: 'support', content: trimmed } });
    await this.prisma.supportTicket.update({ where: { id: ticketId }, data: { updatedAt: new Date() } });
    return { ok: true };
  }

  /**
   * Requires a real report — enforced here, not just in the UI, since the
   * whole point is the client always gets a visible answer for what was
   * done, never just a silent status flip. The report is posted as a
   * regular support message too (so it reads naturally in the thread) as
   * well as stored on resolutionReport (so it's easy to show as a distinct
   * "resolved" summary in the ticket list without opening the thread).
   */
  async resolveTicket(ticketId: string, report: string) {
    const trimmedReport = report.trim();
    if (!trimmedReport) throw new BadRequestException('A completion report is required to resolve a ticket');

    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException('Ticket not found');

    await this.prisma.supportTicketMessage.create({ data: { ticketId, senderRole: 'support', content: trimmedReport } });
    await this.prisma.supportTicket.update({
      where: { id: ticketId },
      data: { status: 'resolved', resolutionReport: trimmedReport, resolvedAt: new Date(), updatedAt: new Date() },
    });

    const creator = await this.prisma.user.findUnique({ where: { id: ticket.createdByUserId } });
    if (creator) {
      this.email
        .sendTicketResolvedEmail(
          creator.email,
          creator.name ?? '',
          ticket.subject,
          trimmedReport,
          `${PUBLIC_BASE_URL}/cabinet/index.html`,
        )
        .catch(() => {});
    }

    return { ok: true };
  }
}
