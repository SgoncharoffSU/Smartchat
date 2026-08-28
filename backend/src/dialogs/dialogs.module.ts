import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DialogsService } from './dialogs.service';

@Module({
  providers: [DialogsService, PrismaService],
  exports: [DialogsService],
})
export class DialogsModule {}
