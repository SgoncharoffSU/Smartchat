import { Module } from '@nestjs/common';
import { YandexGptService } from './yandex-gpt.service';
import { EmbeddingsService } from './embeddings.service';
import { LlmProviderModule } from '../llm-provider/llm-provider.module';

@Module({
  imports: [LlmProviderModule],
  providers: [YandexGptService, EmbeddingsService],
  exports: [YandexGptService, EmbeddingsService],
})
export class YandexGptModule {}
