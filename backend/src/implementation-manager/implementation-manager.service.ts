import { Injectable, Logger } from '@nestjs/common';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { PrismaService } from '../prisma.service';
import { UPLOADS_DIR } from '../uploads-path';

/**
 * Singleton row (always exactly one — see ensureRow), same convention as
 * PaymentSettingsService/LlmProviderService. The "Статус внедрения" page's
 * onboarding manager (name + photo) — used to be a hardcoded demo name
 * ("Мария") no real account had ever met (found live: "должен быть
 * реальный менеджер"). One global manager for now, not per-company: the
 * account owner ("я пока один сотрудник") is presently the only one doing
 * this — a real assignment algorithm across several managers is a
 * deliberate follow-up for once there's more than one, not built
 * preemptively for a case that doesn't exist yet.
 */
@Injectable()
export class ImplementationManagerService {
  private readonly logger = new Logger(ImplementationManagerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async ensureRow() {
    const existing = await this.prisma.implementationManager.findFirst();
    if (existing) return existing;
    return this.prisma.implementationManager.create({ data: {} });
  }

  /** Cabinet-facing — every company sees the same one manager today. */
  async getPublic() {
    const row = await this.ensureRow();
    return { name: row.name || 'Команда Умного Чата', photoUrl: row.photoUrl };
  }

  /** Superadmin view — same shape as getPublic plus updatedAt, nothing sensitive to mask here. */
  async getForAdmin() {
    return this.ensureRow();
  }

  async updateName(name: string) {
    const trimmed = name.trim();
    const row = await this.ensureRow();
    return this.prisma.implementationManager.update({ where: { id: row.id }, data: { name: trimmed } });
  }

  async setPhoto(photoUrl: string) {
    const row = await this.ensureRow();
    const updated = await this.prisma.implementationManager.update({ where: { id: row.id }, data: { photoUrl } });
    // Old headshot is now unreferenced — same best-effort cleanup as
    // KnowledgeService's own unlink-on-replace for UPLOADS_DIR (a missing
    // or already-gone file here is fine, a crash on save is not).
    if (row.photoUrl && row.photoUrl !== photoUrl) {
      const oldFilename = row.photoUrl.split('/').pop();
      if (oldFilename) {
        unlink(join(UPLOADS_DIR, oldFilename)).catch((error) => {
          this.logger.warn(`Failed to delete old manager photo: ${String(error)}`);
        });
      }
    }
    return updated;
  }
}
