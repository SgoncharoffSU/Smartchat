# Deployment — Smartchat

## Как устроен деплой сейчас (до Beget)

1. Локально (Windows / code-server на VPS): `npm install && npm run build` → `dist/`.
2. Продакшен-запуск: `npm start` → `node dist/server.js` (Express на порту `PORT`, по
   умолчанию 3000), раздаёт `public/`.
3. На VPS (code-server) проект склонирован в рабочую директорию пользователя,
   выполнен `npm install` и `npm run build` — это среда разработки, не боевой хостинг.
4. Боевой хостинг — Beget. Автоматизация деплоя — `scripts/deploy-beget.sh`.

## Сценарий деплоя на Beget (шаблон)

`scripts/deploy-beget.sh` (запускается локально или из code-server):
- подключается по SSH-ключу `~/.ssh/beget_deploy`;
- читает параметры из окружения или `.env`: `BEGET_HOST`, `BEGET_USER`,
  `BEGET_PATH`, `BEGET_PORT`, `BEGET_BRANCH`;
- выполняет `git pull` на сервере для заданной ветки;
- устанавливает зависимости (`npm install --omit=dev`);
- собирает проект при наличии `package.json` со скриптом `build`;
- очищает кеш (npm) и перезапускает процесс Node при наличии.

## Что нужно для деплоя на Beget (данные владельца)

- `BEGET_HOST` — SSH-хост Beget (например, `username.beget.com`).
- `BEGET_USER` — SSH-логин аккаунта Beget.
- `BEGET_PATH` — путь к папке проекта на хостинге (например, `smartchat`).
- SSH-ключ `~/.ssh/beget_deploy`: публичная часть добавлена в панель Beget
  (раздел SSH-доступ), приватная — локально, в Git не попадает.
- Доступ к панели Beget для управления process manager (перезапуск Node).

## Секреты, которые требуются (без значений)

Все реальные значения — только в `.env` на сервере, в Git не попадают:

| Переменная | Назначение |
|---|---|
| `YANDEX_API_KEY` | API-ключ Yandex Cloud для YandexGPT (пусто → mock). |
| `YANDEX_FOLDER_ID` | Идентификатор каталога Yandex Cloud. |
| `BITRIX24_WEBHOOK_URL` | Входящий вебхук Битрикс24 `crm.lead.add` (пусто → CRM off). |
| `PORT` | Порт приложения на хостинге. |
| `BEGET_HOST`, `BEGET_USER`, `BEGET_PATH`, `BEGET_PORT`, `BEGET_BRANCH` | Параметры доступа и деплоя на Beget (не ключи, но не публикуем). |

## Порядок первого деплоя на Beget

1. Сгенерировать ключ: `ssh-keygen -t ed25519 -f ~/.ssh/beget_deploy -N ""`.
2. Добавить `~/.ssh/beget_deploy.pub` в панель Beget (SSH-доступ).
3. Создать `.env` на сервере по образцу `.env.example`, заполнить секреты.
4. Заполнить в `.env` переменные `BEGET_*`.
5. Выполнить `bash scripts/deploy-beget.sh`.

## Инварианты

- `.env` и `data/` никогда не коммитим (в `.gitignore`).
- `dist/`, `node_modules/` не коммитим.
- Бизнес-логика и код в `src/`, `prompts/` не меняются скриптами деплоя —
  скрипты только доставляют артефакты и перезапускают процесс.