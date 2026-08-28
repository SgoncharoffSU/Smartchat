import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { MessagesModule } from '../messages/messages.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { YandexGptModule } from '../yandex-gpt/yandex-gpt.module';
import { WidgetModule } from '../widget/widget.module';
import { DislikesService } from './dislikes.service';
import { DislikesController } from './dislikes.controller';

@Module({
  imports: [AuthModule, MessagesModule, KnowledgeModule, YandexGptModule, WidgetModule],
  controllers: [DislikesController],
  providers: [DislikesService, PrismaService],
})
export class DislikesModule {}
