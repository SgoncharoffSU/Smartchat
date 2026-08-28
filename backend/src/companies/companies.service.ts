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
    const companies = await this.prisma.company.findMany({
      orderBy: { createdAt: 'desc' },
      include: { bots: { select: { id: true, name: true, widgetToken: true, sourceWebsite: true }, orderBy: { createdAt: 'asc' } } },
    });
    return companies.map((c) => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
      trialEndsAt: c.trialEndsAt,
      subscriptionActive: c.subscriptionActive,
      bots: c.bots,
    }));
  }
}
