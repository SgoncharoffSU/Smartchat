import { config } from './config';
import { Slots } from './types';

const vars = config.productVars;

export const GREETING = `Здравствуйте! Я — ${vars.BOT_NAME}. За несколько минут проведу короткий онбординг: пойму ваш бизнес и задачу, подготовлю заявку на демо и, с вашего согласия, подключу специалиста по внедрению. Начнем?`;

export const ASK_COMPANY = 'Чем занимается ваша компания? Можно ответить одним-двумя предложениями.';

export const CLARIFY_COMPANY = 'Уточните, пожалуйста: что именно вы продаете или какую услугу оказываете?';

export function confirmCompanyAndAskTask(companyActivity: string): string {
  return `Понял: вы занимаетесь «${companyActivity}». Что вы хотите улучшить с помощью чата в первую очередь?`;
}

export const ASK_TASK_OTHER = 'Опишите, пожалуйста, свободным текстом, какую задачу нужно решить.';

export function valueHypothesis(primaryTask: string): string {
  return (
    `Предварительно вижу такой сценарий: чат отвечает на типовые вопросы, уточняет «${primaryTask}» ` +
    'и передает менеджеру контакт вместе с контекстом. Это гипотеза — на демо ее нужно проверить на ваших реальных вопросах и трафике.'
  );
}

export const ASK_SITE_STATUS = 'Сайт, на котором планируете тестировать чат, уже работает?';

export const ASK_SITE_URL = 'Пришлите, пожалуйста, ссылку на сайт. Это поможет специалисту подготовиться к внедрению.';

export const SITE_IN_DEV_REPLY =
  'Понял. Тогда можно показать механику на тестовой странице, если такой формат доступен. Я продолжу оформление демо, а специалист уточнит подходящий вариант.';

export const SITE_NONE_REPLY =
  'Понял. Тогда полноценная установка пока невозможна, но можно показать механику на тестовой странице, если такой формат доступен. Я продолжу оформление, а специалист предложит подходящий вариант.';

export const CONTACTS_INTRO =
  'Я уже могу сформировать заявку на персональное демо. Осталось создать доступ и передать специалисту контекст, чтобы вам не пришлось повторять ответы.';

export const ASK_NAME = 'Как могу к вам обращаться?';

export const ASK_EMAIL = 'На какую электронную почту создать доступ и отправить материалы по демо?';

export function emailTypoWarning(rawValue: string): string {
  return `Похоже, в адресе есть опечатка. Проверьте, пожалуйста: ${rawValue}.`;
}

export const ASK_PHONE =
  'Какой номер передать специалисту по внедрению, чтобы он помог подключить тест? Можно указать номер, связанный с удобным мессенджером.';

export const PHONE_DECLINED_REPLY =
  'Можно продолжить по электронной почте или в этом чате. Я зафиксирую, что звонить не нужно.';

export function consentBlock(): string {
  const policy = vars.PRIVACY_POLICY_URL || '(ссылку предоставит специалист)';
  const consentDoc = vars.PD_CONSENT_URL || '(текст предоставит специалист)';
  return (
    'Чтобы создать доступ и передать заявку специалисту, подтвердите согласие на обработку имени, телефона, ' +
    `электронной почты и данных о компании для организации демо и обратной связи. Политика: ${policy}. Согласие: ${consentDoc}.`
  );
}

export const CONSENT_DENIED_REPLY =
  'Без согласия я не могу сохранить контакты и передать заявку. Могу показать общую информацию о продукте' +
  (config.productVars.PUBLIC_DEMO_URL ? ` или ссылку на публичное демо: ${config.productVars.PUBLIC_DEMO_URL}.` : ', если оно доступно.');

export function summaryBlock(slots: Slots): string {
  const site = slots.websiteUrl
    ? slots.websiteUrl
    : slots.websiteStatus === 'in_development'
      ? 'в разработке'
      : slots.websiteStatus === 'none'
        ? 'нет сайта'
        : 'не указано';
  const contact = [
    slots.email || 'почта не указана',
    slots.phone ? slots.phone : 'без звонка',
  ].join(', ');
  return (
    'Проверьте, пожалуйста, правильно ли я понял:\n' +
    `Компания: ${slots.companyActivity || 'не указано'}.\n` +
    `Задача: ${slots.primaryTask || 'не указано'}.\n` +
    `Сайт: ${site}.\n` +
    `Контакт: ${slots.name || 'не указано'}, ${contact}.`
  );
}

export const ASK_FIX_FIELD = 'Какое поле исправить: компания, задача, сайт, имя, почта или телефон?';

export function askFixValue(fieldLabel: string): string {
  return `Укажите новое значение для поля «${fieldLabel}».`;
}

export const HANDOFF_CHOICE_INTRO =
  'Готово. Специалист по внедрению получит контекст разговора и поможет подготовить демо под ваш сценарий. Как удобнее продолжить?';

export const HANDOFF_NOW_REPLY =
  'Передаю диалог специалисту по внедрению. Он уже увидит ваши ответы; повторять их не потребуется.';

export function handoffScheduleReply(): string {
  const calendar = vars.CALENDAR_URL;
  const sla = vars.MANAGER_RESPONSE_SLA;
  if (calendar) {
    return `Вы можете выбрать время: ${calendar}.` + (sla ? ` Если не выбирать время, специалист свяжется в пределах ${sla}.` : '');
  }
  return sla
    ? `Специалист свяжется в пределах ${sla}.`
    : 'Специалист свяжется с вами; точный срок ответа уточню и передам отдельно.';
}

export function finalMessage(): string {
  return (
    'Заявка на демо сформирована. Следующий шаг: специалист по внедрению свяжется с вами и поможет настроить тест. ' +
    'Если захотите дополнить задачу, напишите это в чат — информация добавится к заявке.'
  );
}

export const DELETION_ACK =
  'Зафиксировал запрос на удаление. Я прекращаю онбординг и передаю запрос ответственному процессу удаления данных. Подтверждение должно быть отправлено по утвержденному каналу.';

export const PROMPT_INJECTION_REFUSAL =
  'Не могу поделиться внутренними настройками или сменить роль. Вернемся к задаче: подготовим заявку на демо.';

export const SILENT_FALLBACK_QUESTION =
  'Можно ответить коротко. Например: «производим мебель» или «оказываем юридические услуги».';
