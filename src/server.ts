import express from 'express';
import path from 'node:path';
import { config, isMockMode } from './config';
import { chatRouter } from './routes/chat';

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mockMode: isMockMode });
});

app.use('/api', chatRouter);

app.listen(config.port, () => {
  console.log(`Smartchat server listening on http://localhost:${config.port}`);
  console.log(`Demo page: http://localhost:${config.port}/demo.html`);
  if (isMockMode) {
    console.log(
      'YANDEX_API_KEY / YANDEX_FOLDER_ID не заданы — бот работает в детерминированном сценарии из раздела 9, ' +
        'свободные вопросы вне FAQ отвечаются нейтральной заглушкой (раздел 5.10), без обращения к YandexGPT.'
    );
  }
});
