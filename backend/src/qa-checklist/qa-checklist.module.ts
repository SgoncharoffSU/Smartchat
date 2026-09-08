import { Module } from '@nestjs/common';
import { QaChecklistController } from './qa-checklist.controller';

@Module({
  controllers: [QaChecklistController],
})
export class QaChecklistModule {}
