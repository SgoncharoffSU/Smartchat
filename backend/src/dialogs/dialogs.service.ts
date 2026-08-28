import { Injectable } from '@nestjs/common';
import { DialogStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';

@Injectable()
export class DialogsService {
  constructor(private readonly prisma: PrismaService) {}

  async findOrCreate(botId: string, sessionId: string, isPreview = false) {
    const existing = await this.prisma.dialog.findUnique({
      where: { botId_sessionId: { botId, sessionId } },
    });
    if (existing) return existing;

    return this.prisma.dialog.create({
      data: { botId, sessionId, isPreview },
    });
  }

  findBySession(botId: string, sessionId: string) {
    return this.prisma.dialog.findUnique({
      where: { botId_sessionId: { botId, sessionId } },
    });
  }

  updateProgress(dialogId: string, currentStageId: string, status: DialogStatus) {
    return this.prisma.dialog.update({
      where: { id: dialogId },
      data: { currentStageId, status },
    });
  }

  setVisitorMeta(dialogId: string, visitorMeta: object) {
    return this.prisma.dialog.update({
      where: { id: dialogId },
      data: { visitorMeta },
    });
  }
}
