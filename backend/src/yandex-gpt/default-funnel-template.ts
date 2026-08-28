import { FunnelStage } from './yandex-gpt.types';

/**
 * Generic, business-agnostic funnel used for a freshly-provisioned client bot
 * until the async site-analysis job produces a tailored one (or forever, if
 * that job fails — provisioning must never leave a bot non-functional).
 */
export const DEFAULT_FUNNEL_TEMPLATE: FunnelStage[] = [
  {
    stageId: 'greeting',
    instructions:
      'Тепло поприветствуй посетителя сайта и коротко спроси, чем можешь помочь. Будь дружелюбным ' +
      'и естественным, без канцелярита.',
    suggestedButtons: ['Расскажите о продукте', 'Есть вопрос', 'Хочу узнать цену'],
  },
  {
    stageId: 'pain_discovery',
    instructions:
      'Выясни, что именно интересует посетителя и какая у него задача или потребность, прежде чем ' +
      'предлагать решение. Задавай короткие уточняющие вопросы.',
    suggestedButtons: [],
  },
  {
    stageId: 'value_pitch',
    instructions:
      'Опираясь на то, что рассказал посетитель, объясни просто, чем продукт/услуга компании ему ' +
      'подходит. Заверши конкретным вопросом о следующем шаге.',
    suggestedButtons: ['Сколько это стоит?', 'Как быстро можно начать?'],
  },
  {
    stageId: 'handoff',
    instructions:
      'Посетитель заинтересован — вежливо попроси имя и телефон или email, чтобы менеджер связался. ' +
      'Прежде чем отметить leadCaptured=true, проверь блок "Уже известно о собеседнике": если согласие ' +
      'на обработку данных там уже отмечено — сразу благодари, подтверди, что скоро свяжутся, отмечай ' +
      'leadCaptured=true и заполняй leadData. Если согласия там ещё нет — сначала одной короткой тёплой ' +
      'фразой предупреди, что для передачи контакта менеджеру нужно согласие на обработку данных, и ' +
      'предложи кнопками согласиться или уточнить, что это значит; в этой реплике НЕ отмечай ' +
      'leadCaptured=true. Как только получишь явное согласие — установи pdConsentGiven=true в этом же ' +
      'ответе и сразу продолжай: поблагодари, подтверди, что скоро свяжутся, отметь leadCaptured=true и ' +
      'заполни leadData.',
    suggestedButtons: [],
    exitCondition: 'handoff',
  },
  {
    stageId: 'closed',
    instructions: 'Посетитель пока не заинтересован. Вежливо заверши разговор без давления.',
    suggestedButtons: ['Спасибо, пока не актуально'],
    exitCondition: 'closed',
  },
];
