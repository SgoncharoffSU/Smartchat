import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly fromAddress = process.env.SMTP_USER ?? '';

  private readonly transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: Number(process.env.SMTP_PORT ?? 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  async sendConfirmationEmail(to: string, name: string, confirmUrl: string): Promise<void> {
    const greeting = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
    const html = `
      <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom: 20px;">
          <span style="display:inline-block; width:22px; height:22px; border-radius:6px; background:#4f46e5;"></span>
          <strong style="font-size:16px; color:#1a1a2e;">Умный<span style="color:#4f46e5;">Чат</span></strong>
        </div>
        <p style="font-size:15px; color:#1a1a2e;">${greeting}</p>
        <p style="font-size:14px; color:#4b5563; line-height:1.5;">
          Подтвердите регистрацию личного кабинета — нажмите на кнопку ниже.
        </p>
        <p style="margin: 28px 0;">
          <a href="${confirmUrl}" style="background:#4f46e5; color:#fff; text-decoration:none; padding:12px 24px; border-radius:9px; font-size:14px; font-weight:600; display:inline-block;">
            Подтвердить регистрацию
          </a>
        </p>
        <p style="font-size:12.5px; color:#9ca3af; line-height:1.5;">
          Если кнопка не работает, перейдите по ссылке: <a href="${confirmUrl}">${confirmUrl}</a><br/>
          Если вы не регистрировались в «Умный Чат» — просто проигнорируйте это письмо.
        </p>
      </div>
    `.trim();

    try {
      await this.transporter.sendMail({
        from: `"Умный Чат" <${this.fromAddress}>`,
        to,
        subject: 'Подтвердите регистрацию — Умный Чат',
        html,
      });
    } catch (error) {
      this.logger.error(`Failed to send confirmation email to ${to}: ${String(error)}`);
      throw error;
    }
  }

  async sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<void> {
    const greeting = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
    const html = `
      <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom: 20px;">
          <span style="display:inline-block; width:22px; height:22px; border-radius:6px; background:#4f46e5;"></span>
          <strong style="font-size:16px; color:#1a1a2e;">Умный<span style="color:#4f46e5;">Чат</span></strong>
        </div>
        <p style="font-size:15px; color:#1a1a2e;">${greeting}</p>
        <p style="font-size:14px; color:#4b5563; line-height:1.5;">
          Мы получили запрос на сброс пароля личного кабинета. Нажмите на кнопку ниже, чтобы задать новый пароль —
          ссылка действует 1 час.
        </p>
        <p style="margin: 28px 0;">
          <a href="${resetUrl}" style="background:#4f46e5; color:#fff; text-decoration:none; padding:12px 24px; border-radius:9px; font-size:14px; font-weight:600; display:inline-block;">
            Задать новый пароль
          </a>
        </p>
        <p style="font-size:12.5px; color:#9ca3af; line-height:1.5;">
          Если кнопка не работает, перейдите по ссылке: <a href="${resetUrl}">${resetUrl}</a><br/>
          Если вы не запрашивали сброс пароля — просто проигнорируйте это письмо, пароль останется прежним.
        </p>
      </div>
    `.trim();

    try {
      await this.transporter.sendMail({
        from: `"Умный Чат" <${this.fromAddress}>`,
        to,
        subject: 'Сброс пароля — Умный Чат',
        html,
      });
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${to}: ${String(error)}`);
      throw error;
    }
  }

  async sendTeamInviteEmail(to: string, companyName: string, acceptUrl: string): Promise<void> {
    const html = `
      <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom: 20px;">
          <span style="display:inline-block; width:22px; height:22px; border-radius:6px; background:#4f46e5;"></span>
          <strong style="font-size:16px; color:#1a1a2e;">Умный<span style="color:#4f46e5;">Чат</span></strong>
        </div>
        <p style="font-size:15px; color:#1a1a2e;">Здравствуйте!</p>
        <p style="font-size:14px; color:#4b5563; line-height:1.5;">
          Вас пригласили в CRM компании «${companyName}». Нажмите на кнопку ниже, чтобы задать пароль и начать работу.
        </p>
        <p style="margin: 28px 0;">
          <a href="${acceptUrl}" style="background:#4f46e5; color:#fff; text-decoration:none; padding:12px 24px; border-radius:9px; font-size:14px; font-weight:600; display:inline-block;">
            Принять приглашение
          </a>
        </p>
        <p style="font-size:12.5px; color:#9ca3af; line-height:1.5;">
          Если кнопка не работает, перейдите по ссылке: <a href="${acceptUrl}">${acceptUrl}</a>
        </p>
      </div>
    `.trim();

    try {
      await this.transporter.sendMail({
        from: `"Умный Чат" <${this.fromAddress}>`,
        to,
        subject: `Приглашение в CRM «${companyName}» — Умный Чат`,
        html,
      });
    } catch (error) {
      this.logger.error(`Failed to send team invite email to ${to}: ${String(error)}`);
      throw error;
    }
  }

  /**
   * The one support-ticket moment worth an email rather than just showing up
   * next time they open the cabinet — a plain reply doesn't get one (see
   * SupportTicketsService), but "this is actually done" is a closing moment
   * they might not otherwise notice for a while.
   */
  async sendTicketResolvedEmail(to: string, name: string, subject: string, report: string, ticketUrl: string): Promise<void> {
    const greeting = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
    const html = `
      <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom: 20px;">
          <span style="display:inline-block; width:22px; height:22px; border-radius:6px; background:#4f46e5;"></span>
          <strong style="font-size:16px; color:#1a1a2e;">Умный<span style="color:#4f46e5;">Чат</span></strong>
        </div>
        <p style="font-size:15px; color:#1a1a2e;">${greeting}</p>
        <p style="font-size:14px; color:#4b5563; line-height:1.5;">
          Ваше обращение «${subject}» решено. Вот что было сделано:
        </p>
        <p style="font-size:14px; color:#1a1a2e; line-height:1.5; background:#f9fafb; border-radius:9px; padding:14px 16px;">
          ${report}
        </p>
        <p style="margin: 28px 0;">
          <a href="${ticketUrl}" style="background:#4f46e5; color:#fff; text-decoration:none; padding:12px 24px; border-radius:9px; font-size:14px; font-weight:600; display:inline-block;">
            Открыть обращение
          </a>
        </p>
        <p style="font-size:12.5px; color:#9ca3af; line-height:1.5;">
          Если вопрос остался — просто ответьте в этом же обращении в личном кабинете.
        </p>
      </div>
    `.trim();

    try {
      await this.transporter.sendMail({
        from: `"Умный Чат" <${this.fromAddress}>`,
        to,
        subject: `Решено: ${subject} — Умный Чат`,
        html,
      });
    } catch (error) {
      this.logger.error(`Failed to send ticket-resolved email to ${to}: ${String(error)}`);
    }
  }

  // Fire-and-forget, same reasoning as the CRM push right next to its call
  // site (WidgetService) — a slow/misconfigured SMTP server must never delay
  // or fail the visitor's own turn, so this only logs, never throws.
  async sendLeadNotificationEmail(to: string, companyName: string, summary: string): Promise<void> {
    const summaryHtml = summary
      .split('\n')
      .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      .join('<br/>');
    const html = `
      <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom: 20px;">
          <span style="display:inline-block; width:22px; height:22px; border-radius:6px; background:#4f46e5;"></span>
          <strong style="font-size:16px; color:#1a1a2e;">Умный<span style="color:#4f46e5;">Чат</span></strong>
        </div>
        <p style="font-size:15px; color:#1a1a2e;">Новая заявка — ${companyName}</p>
        <p style="font-size:14px; color:#1a1a2e; line-height:1.6; background:#f9fafb; border-radius:9px; padding:14px 16px;">
          ${summaryHtml}
        </p>
      </div>
    `.trim();

    try {
      await this.transporter.sendMail({
        from: `"Умный Чат" <${this.fromAddress}>`,
        to,
        subject: `Новая заявка — ${companyName}`,
        html,
      });
    } catch (error) {
      this.logger.error(`Failed to send lead-notification email to ${to}: ${String(error)}`);
    }
  }
}
