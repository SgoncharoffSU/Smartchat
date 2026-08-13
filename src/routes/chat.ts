import { Router } from 'express';
import { createSession, getOrCreateSession } from '../sessionStore';
import { handleTurn } from '../orchestrator';
import * as msg from '../messages';

export const chatRouter = Router();

const START_BUTTONS = [
  { label: 'Начнем', value: 'START' },
  { label: 'Сначала задать вопрос', value: 'ASK_FIRST' },
  { label: 'Подключить специалиста', value: 'REQUEST_SPECIALIST' },
];

/** Создаёт новую сессию и возвращает приветствие (раздел 9.1). */
chatRouter.post('/session', (_req, res) => {
  const session = createSession();
  session.transcript.push({ role: 'bot', text: msg.GREETING, at: new Date().toISOString() });
  res.json({ sessionId: session.sessionId, reply: msg.GREETING, buttons: START_BUTTONS });
});

chatRouter.post('/chat', async (req, res) => {
  const { sessionId, message, buttonValue } = req.body ?? {};

  if (typeof message !== 'string' && !buttonValue) {
    res.status(400).json({ error: 'message или buttonValue обязательны' });
    return;
  }

  const session = getOrCreateSession(typeof sessionId === 'string' ? sessionId : undefined);

  try {
    const result = await handleTurn(session, {
      text: typeof message === 'string' ? message : '',
      buttonValue: typeof buttonValue === 'string' ? buttonValue : undefined,
    });
    res.json({
      sessionId: session.sessionId,
      reply: result.reply,
      buttons: result.buttons,
      sessionEnded: result.sessionEnded,
    });
  } catch (err) {
    console.error('Chat turn failed', err);
    res.status(500).json({
      error: 'internal_error',
      reply: 'Произошла техническая ошибка. Попробуйте написать еще раз или обновите страницу.',
    });
  }
});
