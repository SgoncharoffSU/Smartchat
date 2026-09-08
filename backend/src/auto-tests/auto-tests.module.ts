import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { WidgetModule } from '../widget/widget.module';
import { YandexGptModule } from '../yandex-gpt/yandex-gpt.module';
import { AutoTestsService } from './auto-tests.service';
import { AutoTestsController } from './auto-tests.controller';

@Module({
  imports: [AuthModule, WidgetModule, YandexGptModule],
  controllers: [AutoTestsController],
  providers: [AutoTestsService, PrismaService],
})
export class AutoTestsModule {}
