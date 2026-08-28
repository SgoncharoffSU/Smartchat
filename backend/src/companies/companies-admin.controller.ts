import { Controller, Get, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { CompaniesService } from './companies.service';
import { AuthService } from '../auth/auth.service';
import { SupportGuard } from '../auth/support.guard';

interface SupportRequest extends Request {
  userId: string;
}

/**
 * Support's "Компании" list + "enter this project" — lets a support agent
 * actually configure a real client's bot (base knowledge, funnel, etc.)
 * instead of only handling their support tickets. See SupportGuard for why
 * this is a separate guard from the regular cabinet's AuthGuard.
 */
@Controller('api/admin/companies')
@UseGuards(SupportGuard)
export class CompaniesAdminController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  list() {
    return this.companies.listAllForSupport();
  }

  // Mints a short-lived (4h) session scoped to the target company, with
  // userId still the support agent's own real id — see
  // AuthService.signImpersonationSession for why. Overwrites the agent's own
  // support-admin cookie for the duration; "Выйти из режима поддержки" in
  // the cabinet banner (or just logging back in) returns them to their own.
  @Post(':id/impersonate')
  async impersonate(@Param('id') id: string, @Req() req: SupportRequest, @Res({ passthrough: true }) res: Response) {
    const company = await this.companies.findById(id);
    if (!company) throw new NotFoundException('Company not found');

    const session = this.auth.signImpersonationSession({
      companyId: company.id,
      userId: req.userId,
      role: 'support',
    });
    res.cookie(this.auth.cookieName, session, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 4 * 60 * 60 * 1000,
      path: '/',
    });
    return { ok: true, companyName: company.name };
  }
}
