import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { MessagesService } from './messages.service';

@Module({
  providers: [MessagesService, PrismaService],
  exports: [MessagesService],
})
export class MessagesModule {}
