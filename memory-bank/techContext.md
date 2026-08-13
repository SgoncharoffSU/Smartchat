# Technical Context — Smartchat

## Версии и стек
| Компонент | Версия |
|---|---|
| Node.js | 20.x (рекомендуется LTS) |
| npm | 10.x |
| TypeScript | ^5.5.3 |
| Express | ^4.19.2 |
| dotenv | ^16.4.5 |
| ssh2 | ^1.17.0 |
| tsx (dev) | ^4.16.2 |
| @types/node | ^20.x |

## Требования к серверу
- Node.js 20 LTS (установка в `scripts/setup-code-server.sh`).
- Доступ в интернет для `npm install` (реестр npmjs) и, при включённой
  интеграции, к API Yandex Cloud и Битрикс24.
- Наличие `data/` для записи лидов (создаётся автоматически).
- Рекомендуемый менеджер процессов: на Beget — по инструкции хостинга;
  локально/dev — `npm run dev` (tsx watch).

## Окружение (`.env`)
Все переменные — в `.env` (в Git НЕ попадает, в репозитории только `.env.example`
с пустыми плейсхолдерами). Ключевые:
- `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` — YandexGPT; пустые → mock-режим.
- `BITRIX24_WEBHOOK_URL`, `BITRIX24_ASSIGNED_BY_ID` — Битрикс24; пустой URL → off.
- `PORT` — по умолчанию 3000.
- `BOT_NAME`, `PRODUCT_NAME` и другие `productVars` — подставляются в системную
  инструкцию; пустые значения = «не заполнено», бот не выдумывает данные.

## Сборка и запуск
```bash
npm install          # установка зависимостей
npm run build        # tsc → dist/
npm start            # node dist/server.js
npm run dev          # tsx watch src/server.ts (разработка)
```

## Точка входа
`src/server.ts` — Express на порту `PORT` (3000). Раздаёт статику `public/` и
монтирует API:
- `GET /api/health` — статус + признак mock-режима.
- `POST /api/session` — создать сессию, вернуть приветствие.
- `POST /api/chat` — ход диалога `{ sessionId, message, buttonValue }`.

## Интеграции
- **YandexGPT** (`src/yandexGpt.ts`): обращение к `https://llm.api.cloud.yandex.net/.../completion`.
  Только свободные вопросы вне FAQ. Ошибки сети не роняют ход диалога (mock-заглушка).
- **Битрикс24** (`src/bitrix.ts`): `crm.lead.add` через webhook. Вызывается
  асинхронно после сохранения лида в `data/leads.jsonl`; ошибка логируется, не блокирует ответ.
- **Хранилище сессий** (`src/sessionStore.ts`): в памяти (Map). Перезапуск сервера
  сбрасывает активные сессии — это допустимо для MVP.

## Перенос на code-server / Beget — учитывать
- Использовать Node 20 LTS, иначе `ssh2`/`tsx` могут вести себя иначе.
- После `npm install` обязательно `npm run build` (запуск через `npm start` ждёт `dist/`).
- `.env` на сервере создаётся вручную по образцу `.env.example` (секреты в Git не попадают).
- Переводы строк: в репозитории добавлен `.gitattributes` с `eol=lf` — на Linux
  (code-server, Beget) не будет CRLF.