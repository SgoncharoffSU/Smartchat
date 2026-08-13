import { config, isMockMode } from './config';
import { loadSystemPrompt } from './promptLoader';

interface YandexMessage {
  role: 'system' | 'user' | 'assistant';
  text: string;
}

interface YandexCompletionResponse {
  result?: {
    alternatives?: Array<{ message?: { text?: string } }>;
  };
}

const FALLBACK_ANSWER =
  'Не хочу вводить вас в заблуждение. Этого условия у меня нет в актуальной базе. Передам вопрос специалисту по внедрению.';

/**
 * Отвечает на свободный вопрос пользователя (раздел 10.2), опираясь только
 * на системную инструкцию как базу знаний. Используется как fallback для
 * вопросов, не покрытых статичным FAQ (см. faq.ts).
 * В mock-режиме (нет ключа Yandex Cloud) всегда возвращает безопасный ответ,
 * а не выдумывает факты — это соответствует правилу 5.10 инструкции.
 */
export async function answerFreeform(userQuestion: string): Promise<string> {
  if (isMockMode) {
    return FALLBACK_ANSWER;
  }

  const messages: YandexMessage[] = [
    { role: 'system', text: loadSystemPrompt() },
    {
      role: 'user',
      text:
        'Пользователь задал свободный вопрос в процессе онбординга: ' +
        `"${userQuestion}". Ответь одним-двумя короткими предложениями строго на основе ` +
        'системной инструкции. Если ответа нет в инструкции — используй формулировку из ' +
        'раздела 5.10 про отсутствие данных в базе. Не добавляй приветствие и не задавай вопрос.',
    },
  ];

  try {
    const res = await fetch(config.yandex.completionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Api-Key ${config.yandex.apiKey}`,
        'x-folder-id': config.yandex.folderId,
      },
      body: JSON.stringify({
        modelUri: `gpt://${config.yandex.folderId}/${config.yandex.model}/latest`,
        completionOptions: { stream: false, temperature: 0.2, maxTokens: '300' },
        messages,
      }),
    });

    if (!res.ok) {
      return FALLBACK_ANSWER;
    }

    const data = (await res.json()) as YandexCompletionResponse;
    const text = data.result?.alternatives?.[0]?.message?.text?.trim();
    return text || FALLBACK_ANSWER;
  } catch {
    return FALLBACK_ANSWER;
  }
}
