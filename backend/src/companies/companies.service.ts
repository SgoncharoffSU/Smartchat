import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.company.findUnique({ where: { id } });
  }

  /**
   * Support's "Компании" list — lets a support agent find a real client's
   * project to enter and help configure (see CompaniesAdminController's
   * impersonate route). Newest first, since a freshly-signed-up client is
   * the one most likely to need hands-on help right now.
   */
  async listAllForSupport() {
    // trialEndsAt/subscriptionActive moved from Company to Bot (one
    // subscription per bot now, see Bot's own schema comment) — each bot in
    // the list carries its own, instead of one shared company-level pair.
    const companies = await this.prisma.company.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        bots: {
          select: { id: true, name: true, widgetToken: true, sourceWebsite: true, trialEndsAt: true, subscriptionActive: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return companies.map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
      bots: c.bots,
    }));
  }
}
