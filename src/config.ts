import 'dotenv/config';

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  port: Number(env('PORT', '3000')),

  yandex: {
    apiKey: env('YANDEX_API_KEY'),
    folderId: env('YANDEX_FOLDER_ID'),
    model: env('YANDEX_GPT_MODEL', 'yandexgpt-lite'),
    completionUrl: env(
      'YANDEX_COMPLETION_URL',
      'https://llm.api.cloud.yandex.net/foundationModels/v1/completion'
    ),
  },

  // Опциональная интеграция с Битрикс24 (crm.lead.add).
  // Пустой webhookUrl — интеграция отключена, лид пишется только в data/leads.jsonl.
  bitrix: {
    webhookUrl: env('BITRIX24_WEBHOOK_URL'),
    assignedById: env('BITRIX24_ASSIGNED_BY_ID', ''),
  },

  // Значения для переменных из раздела 0 системной инструкции.
  // Пустая строка означает «не заполнено» — бот обязан подставлять
  // нейтральную формулировку и не выдумывать значение.
  productVars: {
    BOT_NAME: env('BOT_NAME', 'ИИ-консультант ГлавИнструмента'),
    PRODUCT_NAME: env('PRODUCT_NAME', 'Умный чат для сайта'),
    COMPANY_LEGAL_NAME: env('COMPANY_LEGAL_NAME'),
    PRIVACY_POLICY_URL: env('PRIVACY_POLICY_URL'),
    PD_CONSENT_URL: env('PD_CONSENT_URL'),
    DEMO_DURATION: env('DEMO_DURATION'),
    DEMO_LIMITS: env('DEMO_LIMITS'),
    CURRENT_PRICE_DATA: env('CURRENT_PRICE_DATA'),
    MANAGER_WORKING_HOURS: env('MANAGER_WORKING_HOURS'),
    MANAGER_RESPONSE_SLA: env('MANAGER_RESPONSE_SLA'),
    CALENDAR_URL: env('CALENDAR_URL'),
    SUPPORT_CHANNEL: env('SUPPORT_CHANNEL'),
    PUBLIC_DEMO_URL: env('PUBLIC_DEMO_URL'),
  },
};

export const isMockMode = !config.yandex.apiKey || !config.yandex.folderId;
