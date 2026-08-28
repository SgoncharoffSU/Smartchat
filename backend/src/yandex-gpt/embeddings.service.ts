import { Injectable, Logger } from '@nestjs/common';

const YANDEX_EMBEDDING_URL = 'https://llm.api.cloud.yandex.net/foundationModels/v1/textEmbedding';

// Ballpark placeholder, NOT pulled from Yandex Cloud's billing API — update
// from the actual per-1000-token embedding rate in the Yandex Cloud console
// (Foundation Models pricing) once known. AiUsageEvent.tokens is the real,
// measured number from the API's own response; estimatedCostRub is only as
// good as this constant. Override via env without a redeploy if the real
// rate turns out different.
const RUB_PER_1K_TOKENS = Number(process.env.YANDEX_EMBEDDING_RUB_PER_1K_TOKENS ?? '0.02');

export interface EmbeddingResult {
  vector: number[];
  tokens: number;
}

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);
  private readonly apiKey = process.env.YANDEX_API_KEY ?? '';
  private readonly folderId = process.env.YANDEX_FOLDER_ID ?? '';

  /** For indexing KB entries (asymmetric doc/query model pair — see embedQuery). */
  embedDocument(text: string): Promise<EmbeddingResult | null> {
    return this.embed(text, 'text-search-doc');
  }

  /** For the visitor's live message at search time — paired with embedDocument for relevance. */
  embedQuery(text: string): Promise<EmbeddingResult | null> {
    return this.embed(text, 'text-search-query');
  }

  private async embed(text: string, model: 'text-search-doc' | 'text-search-query'): Promise<EmbeddingResult | null> {
    try {
      const response = await fetch(YANDEX_EMBEDDING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${this.apiKey}` },
        body: JSON.stringify({
          modelUri: `emb://${this.folderId}/${model}/latest`,
          text: text.slice(0, 2000),
        }),
      });
      if (!response.ok) {
        this.logger.warn(`Embedding request failed: ${response.status} ${await response.text()}`);
        return null;
      }
      const data = await response.json();
      const vector = Array.isArray(data?.embedding) ? (data.embedding as number[]) : null;
      const tokens = Number(data?.numTokens ?? 0);
      if (!vector) return null;
      return { vector, tokens };
    } catch (error) {
      this.logger.warn(`Embedding request crashed: ${String(error)}`);
      return null;
    }
  }

  estimateCostRub(tokens: number): number {
    return (tokens / 1000) * RUB_PER_1K_TOKENS;
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
