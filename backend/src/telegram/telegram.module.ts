import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { YandexGptModule } from '../yandex-gpt/yandex-gpt.module';
import { MessagesModule } from '../messages/messages.module';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';

@Module({
  imports: [YandexGptModule, MessagesModule],
  controllers: [TelegramController],
  providers: [TelegramService, PrismaService],
  exports: [TelegramService],
})
export class TelegramModule {}
