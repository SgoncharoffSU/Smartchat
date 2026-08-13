import { config } from './config';
import type { LeadRecord } from './leadStore';

/**
 * Интеграция с Битрикс24: передача лида в CRM методом crm.lead.add.
 *
 * Поддерживает два способа конфигурации через BITRIX24_WEBHOOK_URL:
 *   1. Полный URL входящего вебхука Битрикс24 (уже содержит crm.lead.add);
 *   2. Базовый REST-адрес вебхука (…/rest/<user>/<token>/), метод добавляется автоматически.
 *
 * Лид передаётся только после согласия на обработку ПД (проверка в leadStore).
 * При ошибке/таймауте лид остаётся в локальном data/leads.jsonl — потерь нет.
 */

const REQUEST_TIMEOUT_MS = 8000;

export function isBitrixConfigured(): boolean {
  return Boolean(config.bitrix.webhookUrl.trim());
}

function resolveLeadAddUrl(base: string): string {
  let url = base.trim();
  if (!url) return url;
  if (!/\/$/.test(url)) url += '/';
  if (!/crm\.lead\.add/i.test(url)) url += 'crm.lead.add/';
  return url;
}

function toBitrixFields(record: LeadRecord): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    TITLE: `Заявка на демо умного чата — ${record.name || record.company_activity || 'без названия'}`,
    STATUS_ID: 'NEW',
    SOURCE_ID: 'WEB',
    SOURCE_DESCRIPTION: 'Кнопка «Получить демо-доступ»',
    COMMENTS: buildComments(record),
  };

  if (record.name) {
    const parts = record.name.trim().split(/\s+/);
    fields.NAME = parts[0];
    if (parts.length > 1) fields.LAST_NAME = parts.slice(1).join(' ');
  }

  if (record.company_name || record.company_activity) {
    fields.COMPANY_TITLE = record.company_name || record.company_activity;
  }

  if (record.email) {
    fields.EMAIL = [{ VALUE: record.email, VALUE_TYPE: 'WORK' }];
  }

  if (record.phone) {
    fields.PHONE = [{ VALUE: record.phone, VALUE_TYPE: 'WORK' }];
  }

  if (record.website_url) {
    fields.WEB = [{ VALUE: record.website_url, VALUE_TYPE: 'WORK' }];
  }

  const assignedById = Number(config.bitrix.assignedById);
  if (Number.isFinite(assignedById) && assignedById > 0) {
    fields.ASSIGNED_BY_ID = assignedById;
  }

  const utmSource = record.source ? `Источник: ${record.source}.` : '';
  if (utmSource) {
    fields.SOURCE_DESCRIPTION = `${utmSource} ${fields.SOURCE_DESCRIPTION}`;
  }

  return fields;
}

function buildComments(record: LeadRecord): string {
  const lines: string[] = [];

  if (record.manager_brief) lines.push(record.manager_brief);

  lines.push(`Уровень квалификации: ${record.qualification_tier || 'не определён'}`);

  if (record.objections?.length) {
    lines.push(`Возражения: ${record.objections.join('; ')}`);
  }

  if (record.unanswered_questions?.length) {
    lines.push(`Вопросы без ответа: ${record.unanswered_questions.join('; ')}`);
  }

  if (record.transcript?.length) {
    const transcript = record.transcript
      .map((t) => `${t.role === 'bot' ? 'Бот' : 'Клиент'}: ${t.text}`)
      .join('\n');
    lines.push(`Стенограмма:\n${transcript}`);
  }

  return lines.filter((l) => l.trim()).join('\n\n');
}

/**
 * Отправляет лид в Битрикс24. Возвращает true при успешном создании,
 * false — если интеграция не настроена или запрос не удался.
 */
export async function pushLeadToBitrix(record: LeadRecord): Promise<boolean> {
  if (!isBitrixConfigured()) {
    return false;
  }

  const url = resolveLeadAddUrl(config.bitrix.webhookUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toBitrixFields(record) }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[bitrix24] crm.lead.add HTTP ${res.status}: ${await res.text()}`);
      return false;
    }

    const data = (await res.json()) as { result?: unknown; error?: string; error_description?: string };

    if (data.error) {
      console.error(`[bitrix24] crm.lead.add error: ${data.error} ${data.error_description || ''}`);
      return false;
    }

    if (data.result === undefined) {
      console.error('[bitrix24] crm.lead.add: нет result в ответе');
      return false;
    }

    console.log(`[bitrix24] Лид создан в Битрикс24: ${data.result}`);
    return true;
  } catch (err) {
    console.error('[bitrix24] Не удалось передать лид в Битрикс24:', err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}