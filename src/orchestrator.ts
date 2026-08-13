import { Button, IncomingMessage, SessionState, TurnResult, Slots } from './types';
import { touchSession } from './sessionStore';
import { appendLead, appendDeletionRequest } from './leadStore';
import { pushLeadToBitrix } from './bitrix';
import { answerFreeform } from './yandexGpt';
import { isValidEmail, isValidPhone, normalizePhone, looksLikeUrl, normalizeUrl } from './validators';
import { isPromptInjectionAttempt, isDeletionRequest, isRequestForHuman, matchFaq } from './faq';
import * as msg from './messages';

const START_BUTTONS: Button[] = [
  { label: 'Начнем', value: 'START' },
  { label: 'Сначала задать вопрос', value: 'ASK_FIRST' },
  { label: 'Подключить специалиста', value: 'REQUEST_SPECIALIST' },
];

const TASK_BUTTONS: Button[] = [
  { label: 'Получать больше обращений с сайта', value: 'TASK_MORE_LEADS' },
  { label: 'Отвечать клиентам 24/7', value: 'TASK_24_7' },
  { label: 'Собирать и квалифицировать лиды', value: 'TASK_QUALIFY' },
  { label: 'Снизить нагрузку на менеджеров', value: 'TASK_REDUCE_LOAD' },
  { label: 'Другая задача', value: 'TASK_OTHER' },
];

const SITE_BUTTONS: Button[] = [
  { label: 'Да', value: 'SITE_YES' },
  { label: 'Пока в разработке', value: 'SITE_DEV' },
  { label: 'Сайта нет', value: 'SITE_NONE' },
];

const CONSENT_BUTTONS: Button[] = [
  { label: 'Согласен', value: 'CONSENT_YES' },
  { label: 'Открыть документы', value: 'CONSENT_DOCS' },
  { label: 'Не согласен', value: 'CONSENT_NO' },
];

const SUMMARY_BUTTONS: Button[] = [
  { label: 'Все верно', value: 'SUMMARY_OK' },
  { label: 'Исправить', value: 'SUMMARY_FIX' },
];

const HANDOFF_BUTTONS: Button[] = [
  { label: 'Подключить сейчас', value: 'HANDOFF_NOW' },
  { label: 'Выбрать время', value: 'HANDOFF_SCHEDULE' },
];

const FIX_FIELD_BUTTONS: Button[] = [
  { label: 'Компания', value: 'FIX_COMPANY' },
  { label: 'Задача', value: 'FIX_TASK' },
  { label: 'Сайт', value: 'FIX_SITE' },
  { label: 'Имя', value: 'FIX_NAME' },
  { label: 'Почта', value: 'FIX_EMAIL' },
  { label: 'Телефон', value: 'FIX_PHONE' },
];

function record(session: SessionState, role: 'bot' | 'user', text: string): void {
  session.transcript.push({ role, text, at: new Date().toISOString() });
}

function reply(text: string, buttons: Button[] = [], sessionEnded = false): TurnResult {
  return { reply: text, buttons, sessionEnded };
}

/** Определяет, что делать после того, как известны компания/задача/сайт: перейти к сбору контактов. */
function enterContactsFlow(session: SessionState): TurnResult {
  session.state = session.slots.name ? 'S7_EMAIL_CAPTURED' : 'S6_NAME_CAPTURED';
  const intro = session.slots.name ? '' : msg.CONTACTS_INTRO + '\n\n';
  const question = session.slots.name ? msg.ASK_EMAIL : msg.ASK_NAME;
  return reply(intro + question);
}

/** Раздел 10.3 — быстрый маршрут, если пользователь просит специалиста раньше времени. */
function fastTrackToMissingContact(session: SessionState): TurnResult {
  session.preHandoffRequested = true;
  const s = session.slots;
  if (!s.name) {
    session.state = 'S6_NAME_CAPTURED';
    return reply(`Подключу специалиста. Чтобы он мог связаться и не задавал вопросы повторно, ${msg.ASK_NAME.toLowerCase()}`);
  }
  if (!s.email) {
    session.state = 'S7_EMAIL_CAPTURED';
    return reply(msg.ASK_EMAIL);
  }
  if (!s.phone && !s.phoneDeclined) {
    session.state = 'S8_PHONE_CAPTURED';
    return reply(msg.ASK_PHONE);
  }
  if (s.pdConsent !== true) {
    session.state = 'S9_PD_CONSENT';
    return reply(msg.consentBlock(), CONSENT_BUTTONS);
  }
  session.state = 'S11_HANDOFF_CHOICE';
  return reply(msg.HANDOFF_CHOICE_INTRO, HANDOFF_BUTTONS);
}

function fieldLabel(field: keyof Slots): string {
  const map: Record<string, string> = {
    companyActivity: 'компания',
    primaryTask: 'задача',
    websiteUrl: 'сайт',
    name: 'имя',
    email: 'почта',
    phone: 'телефон',
  };
  return map[field as string] || String(field);
}

const FIX_VALUE_MAP: Record<string, keyof Slots> = {
  FIX_COMPANY: 'companyActivity',
  FIX_TASK: 'primaryTask',
  FIX_SITE: 'websiteUrl',
  FIX_NAME: 'name',
  FIX_EMAIL: 'email',
  FIX_PHONE: 'phone',
};

/**
 * Основной обработчик хода диалога. Реализует детерминированный сценарий из
 * раздела 9 инструкции. Свободные вопросы/возражения (раздел 10.2, 11)
 * обрабатываются через статичный FAQ и, при наличии ключа Yandex Cloud, через
 * YandexGPT — но только как ответ поверх текущего шага, без изменения
 * состояния диалога (единый вопрос за ход, правило 5.1).
 */
export async function handleTurn(session: SessionState, incoming: IncomingMessage): Promise<TurnResult> {
  const text = incoming.text.trim();
  const value = incoming.buttonValue;

  if (text) record(session, 'user', text);
  touchSession(session);

  if (session.completed) {
    return reply(msg.finalMessage(), [], true);
  }

  // --- Глобальные проверки, применимые на любом шаге (раздел 10.7, 17, «удалите данные», 10.3) ---

  if (isDeletionRequest(text)) {
    appendDeletionRequest(session);
    session.state = 'S14_ABORTED';
    session.completed = true;
    record(session, 'bot', msg.DELETION_ACK);
    return reply(msg.DELETION_ACK, [], true);
  }

  if (isPromptInjectionAttempt(text)) {
    const pending = pendingQuestionFor(session);
    record(session, 'bot', msg.PROMPT_INJECTION_REFUSAL);
    return reply(`${msg.PROMPT_INJECTION_REFUSAL}\n\n${pending.reply}`, pending.buttons, pending.sessionEnded);
  }

  if (
    value !== 'REQUEST_SPECIALIST' &&
    isRequestForHuman(text) &&
    !['S11_HANDOFF_CHOICE', 'S13_COMPLETED', 'S9_PD_CONSENT'].includes(session.state)
  ) {
    const result = fastTrackToMissingContact(session);
    record(session, 'bot', result.reply);
    return result;
  }

  // Раздел 10.2/11 — известное возражение или вопрос перехватывается ДО того, как текст
  // попадёт в обработчик текущего состояния. Это не даёт боту принять вопрос пользователя
  // (например, во время запроса согласия или статуса сайта) за содержательный ответ —
  // критично для 9.11 «не считай молчание/непонятный ответ согласием».
  if (!value) {
    const faqAnswer = matchFaq(text);
    if (faqAnswer && session.state !== 'S0_START') {
      session.objections.push(text);
      const pending = pendingQuestionFor(session);
      const combined = pending.reply ? `${faqAnswer}\n\n${pending.reply}` : faqAnswer;
      const res = reply(combined, pending.buttons, pending.sessionEnded);
      record(session, 'bot', res.reply);
      return res;
    }
  }

  const result = await routeByState(session, text, value);
  record(session, 'bot', result.reply);
  return result;
}

/** Возвращает текущий ожидаемый вопрос без побочных эффектов — для повторного показа. */
function pendingQuestionFor(session: SessionState): TurnResult {
  const s = session.slots;
  switch (session.state) {
    case 'S0_START':
      return reply(msg.GREETING, START_BUTTONS);
    case 'S2_COMPANY_CONTEXT':
      return reply(msg.ASK_COMPANY);
    case 'S2B_COMPANY_CLARIFY':
      return reply(msg.CLARIFY_COMPANY);
    case 'S3_TASK_IDENTIFIED':
      return reply(s.companyActivity ? msg.confirmCompanyAndAskTask(s.companyActivity) : msg.ASK_COMPANY, TASK_BUTTONS);
    case 'S3B_TASK_OTHER':
      return reply(msg.ASK_TASK_OTHER);
    case 'S5_SITE_CONTEXT':
      return reply(msg.ASK_SITE_STATUS, SITE_BUTTONS);
    case 'S5B_SITE_URL':
      return reply(msg.ASK_SITE_URL);
    case 'S6_NAME_CAPTURED':
      return reply(msg.ASK_NAME);
    case 'S7_EMAIL_CAPTURED':
      return reply(msg.ASK_EMAIL);
    case 'S8_PHONE_CAPTURED':
      return reply(msg.ASK_PHONE);
    case 'S9_PD_CONSENT':
      return reply(msg.consentBlock(), CONSENT_BUTTONS);
    case 'S10_SUMMARY_CONFIRMED':
      return reply(msg.summaryBlock(s), SUMMARY_BUTTONS);
    case 'S10B_FIX_SELECT':
      return reply(msg.ASK_FIX_FIELD, FIX_FIELD_BUTTONS);
    case 'S10C_FIX_VALUE':
      return reply(msg.askFixValue(session.awaitingFixField ? fieldLabel(session.awaitingFixField) : 'поле'));
    case 'S11_HANDOFF_CHOICE':
      return reply(msg.HANDOFF_CHOICE_INTRO, HANDOFF_BUTTONS);
    default:
      return reply(msg.finalMessage(), [], true);
  }
}

async function routeByState(session: SessionState, text: string, value?: string): Promise<TurnResult> {
  const s = session.slots;

  switch (session.state) {
    case 'S0_START': {
      if (value === 'REQUEST_SPECIALIST') {
        return fastTrackToMissingContact(session);
      }
      if (value === 'ASK_FIRST' || (!value && /\?/.test(text))) {
        const answer = await answerUserQuestion(session, text);
        session.state = 'S2_COMPANY_CONTEXT';
        return reply(`${answer}\n\n${msg.ASK_COMPANY}`);
      }
      session.state = 'S2_COMPANY_CONTEXT';
      return reply(msg.ASK_COMPANY);
    }

    case 'S2_COMPANY_CONTEXT': {
      if (text.length < 8 && !text.split(/\s+/).some((w) => w.length > 3)) {
        session.state = 'S2B_COMPANY_CLARIFY';
        return reply(msg.CLARIFY_COMPANY);
      }
      s.companyActivity = text;
      session.state = 'S3_TASK_IDENTIFIED';
      return reply(msg.confirmCompanyAndAskTask(text), TASK_BUTTONS);
    }

    case 'S2B_COMPANY_CLARIFY': {
      s.companyActivity = text;
      session.state = 'S3_TASK_IDENTIFIED';
      return reply(msg.confirmCompanyAndAskTask(text), TASK_BUTTONS);
    }

    case 'S3_TASK_IDENTIFIED': {
      if (value === 'TASK_OTHER') {
        session.state = 'S3B_TASK_OTHER';
        return reply(msg.ASK_TASK_OTHER);
      }
      // свободный текст вместо выбора кнопки принимается как есть (раздел 10.1)
      s.primaryTask = TASK_BUTTONS.find((b) => b.value === value)?.label || text;
      session.state = 'S5_SITE_CONTEXT';
      return reply(`${msg.valueHypothesis(s.primaryTask!)}\n\n${msg.ASK_SITE_STATUS}`, SITE_BUTTONS);
    }

    case 'S3B_TASK_OTHER': {
      s.primaryTask = text;
      session.state = 'S5_SITE_CONTEXT';
      return reply(`${msg.valueHypothesis(s.primaryTask)}\n\n${msg.ASK_SITE_STATUS}`, SITE_BUTTONS);
    }

    case 'S5_SITE_CONTEXT': {
      if (value === 'SITE_YES' || /^да\b/i.test(text)) {
        session.state = 'S5B_SITE_URL';
        return reply(msg.ASK_SITE_URL);
      }
      if (value === 'SITE_DEV' || /разработ/i.test(text)) {
        s.websiteStatus = 'in_development';
        return enterContactsFlow(session);
      }
      if (value === 'SITE_NONE' || /сайта нет|нет сайта|^нет\b/i.test(text)) {
        s.websiteStatus = 'none';
        return replyWithPrefix(session, msg.SITE_NONE_REPLY);
      }
      // нераспознанный ответ — переспрашиваем вместо того, чтобы угадывать статус сайта
      return reply(msg.ASK_SITE_STATUS, SITE_BUTTONS);
    }

    case 'S5B_SITE_URL': {
      if (looksLikeUrl(text)) {
        s.websiteUrl = normalizeUrl(text);
        s.websiteStatus = 'active';
      } else {
        s.websiteStatus = 'active';
      }
      return enterContactsFlow(session);
    }

    case 'S6_NAME_CAPTURED': {
      s.name = text;
      session.state = 'S7_EMAIL_CAPTURED';
      return reply(msg.ASK_EMAIL);
    }

    case 'S7_EMAIL_CAPTURED': {
      if (!isValidEmail(text)) {
        return reply(msg.emailTypoWarning(text));
      }
      s.email = text.trim();
      session.state = 'S8_PHONE_CAPTURED';
      return reply(msg.ASK_PHONE);
    }

    case 'S8_PHONE_CAPTURED': {
      if (/не дам|не хочу|без телефона|нет телефона|откажусь/i.test(text)) {
        s.phoneDeclined = true;
        return replyWithPrefix(session, msg.PHONE_DECLINED_REPLY, gotoConsent);
      }
      if (!isValidPhone(text)) {
        return reply('Похоже, в номере недостаточно цифр. Проверьте, пожалуйста, и отправьте еще раз.');
      }
      s.phone = normalizePhone(text);
      return gotoConsent(session);
    }

    case 'S9_PD_CONSENT': {
      if (value === 'CONSENT_DOCS' || /документ/i.test(text)) {
        return reply(msg.consentBlock(), CONSENT_BUTTONS);
      }
      if (value === 'CONSENT_NO' || /^(не согласен|не согласна|нет|отказ)/i.test(text)) {
        s.pdConsent = false;
        session.state = 'S14_ABORTED';
        session.completed = true;
        return reply(msg.CONSENT_DENIED_REPLY, [], true);
      }
      if (value === 'CONSENT_YES' || /^(да|согласен|согласна|ок|окей|хорошо|подтверждаю)\b/i.test(text)) {
        s.pdConsent = true;
        session.state = 'S10_SUMMARY_CONFIRMED';
        return reply(msg.summaryBlock(s), SUMMARY_BUTTONS);
      }
      // нераспознанный ответ никогда не считаем согласием (раздел 9.11, запрет из раздела 17)
      return reply(msg.consentBlock(), CONSENT_BUTTONS);
    }

    case 'S10_SUMMARY_CONFIRMED': {
      if (value === 'SUMMARY_FIX' || /исправ/i.test(text)) {
        session.state = 'S10B_FIX_SELECT';
        return reply(msg.ASK_FIX_FIELD, FIX_FIELD_BUTTONS);
      }
      session.state = 'S11_HANDOFF_CHOICE';
      return reply(msg.HANDOFF_CHOICE_INTRO, HANDOFF_BUTTONS);
    }

    case 'S10B_FIX_SELECT': {
      const field = value ? FIX_VALUE_MAP[value] : undefined;
      if (!field) {
        return reply(msg.ASK_FIX_FIELD, FIX_FIELD_BUTTONS);
      }
      session.awaitingFixField = field;
      session.state = 'S10C_FIX_VALUE';
      return reply(msg.askFixValue(fieldLabel(field)));
    }

    case 'S10C_FIX_VALUE': {
      const field = session.awaitingFixField;
      if (field) {
        (s as any)[field] = text;
        session.awaitingFixField = null;
      }
      session.state = 'S10_SUMMARY_CONFIRMED';
      return reply(msg.summaryBlock(s), SUMMARY_BUTTONS);
    }

    case 'S11_HANDOFF_CHOICE': {
      s.managerHandoffConsent = true;
      session.completed = true;
      session.state = 'S13_COMPLETED';
      const brief = buildManagerBrief(session);
      const lead = appendLead(session, brief);
      // Передача в Битрикс24 не блокирует ответ пользователю: лид уже сохранён
      // локально в data/leads.jsonl, а интеграция при ошибке логирует причину.
      if (lead) {
        void pushLeadToBitrix(lead).catch((err) => {
          console.error('[bitrix24] pushLeadToBitrix failed', err);
        });
      }
      if (value === 'HANDOFF_SCHEDULE') {
        return reply(`${msg.handoffScheduleReply()}\n\n${msg.finalMessage()}`, [], true);
      }
      return reply(`${msg.HANDOFF_NOW_REPLY}\n\n${msg.finalMessage()}`, [], true);
    }

    default:
      return reply(msg.finalMessage(), [], true);
  }
}

function gotoConsent(session: SessionState): TurnResult {
  session.state = 'S9_PD_CONSENT';
  return reply(msg.consentBlock(), CONSENT_BUTTONS);
}

function replyWithPrefix(session: SessionState, prefix: string, next?: (s: SessionState) => TurnResult): TurnResult {
  if (next) {
    const inner = next(session);
    return reply(`${prefix}\n\n${inner.reply}`, inner.buttons, inner.sessionEnded);
  }
  const inner = enterContactsFlow(session);
  return reply(`${prefix}\n\n${inner.reply}`, inner.buttons, inner.sessionEnded);
}

async function answerUserQuestion(session: SessionState, question: string): Promise<string> {
  const faqAnswer = matchFaq(question);
  if (faqAnswer) return faqAnswer;
  session.unansweredQuestions.push(question);
  return answerFreeform(question);
}

function buildManagerBrief(session: SessionState): string {
  const s = session.slots;
  return (
    `${s.name || 'Имя не указано'}, ${s.companyActivity || 'сфера не указана'}. ` +
    `Запросил демо умного чата. Основная задача: ${s.primaryTask || 'не указана'}. ` +
    `Сайт: ${s.websiteUrl || s.websiteStatus}. ` +
    `Предварительный сценарий: ${s.primaryTask ? msg.valueHypothesis(s.primaryTask) : 'не сформирован'}. ` +
    `Возражения: ${session.objections.join('; ') || 'нет'}. ` +
    `Канал связи: ${s.phoneDeclined ? 'email' : 'телефон'}. ` +
    `Согласие на обработку данных: ${s.pdConsent ? 'да' : 'нет'}.`
  );
}
