import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { ProvisioningService } from './provisioning.service';
import { CabinetService } from '../cabinet/cabinet.service';

// The site-based counterpart to the chat's self-sell provisioning flow (see
// WidgetService/ProvisioningService.getOrProvision) — a visitor who'd rather
// fill out a form than have a conversation with the demo bot had no way in
// at all before this. Provisions a company+bot from the submitted business
// description, then immediately registers the account against it — same
// two-step shape as the chat flow (provision, then CabinetService.register),
// collapsed into one request since there's no separate "click the link in
// the conversation" moment here; the visitor is already filling out a form.
@Controller('api/provisioning')
export class ProvisioningController {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly cabinet: CabinetService,
  ) {}

  @Post('signup')
  async signup(
    @Body()
    body: {
      businessDescription: string;
      website?: string;
      email: string;
      password: string;
      name: string;
      consent?: boolean;
    },
    @Req() req: Request,
  ) {
    if (!body.businessDescription || !body.businessDescription.trim()) {
      throw new BadRequestException('Расскажите коротко, чем занимается ваш бизнес');
    }
    const visitorIp = (req.headers['x-real-ip'] as string) || req.ip;
    const provisioned = await this.provisioning.provisionStandalone(
      { businessDescription: body.businessDescription, website: body.website },
      visitorIp,
    );
    if (!provisioned.ok) {
      throw new BadRequestException('Слишком много попыток регистрации подряд — попробуйте немного позже.');
    }
    const token = new URL(provisioned.registrationUrl).searchParams.get('token');
    if (!token) {
      throw new BadRequestException('Не получилось создать аккаунт, попробуйте ещё раз');
    }
    const result = await this.cabinet.register(token, body.email, body.password, body.name, body.consent === true);
    return { ok: true, pendingConfirmation: true, email: result.email };
  }
}
