# HANDOFF — Smartchat: перенос разработки на планшет (code-server)

> Целевое состояние: вести разработку Smartchat с планшета Huawei MatePad 11 через
> браузерную VS Code (code-server) на VPS. Деплой боевой версии — на хостинг Beget.

## 1. Где находится правда о проекте

| Файл | Назначение |
|---|---|
| `memory-bank/projectbrief.md` | Зачем проект, стек, архитектура. |
| `memory-bank/techContext.md` | Версии, сборка, API, переменные окружения. |
| `memory-bank/activeContext.md` | Текущее состояние и ближайшие задачи. |
| `memory-bank/progress.md` | Что сделано / что осталось. |
| `memory-bank/decisions.md` | Ключевые технические решения и их обоснование. |
| `memory-bank/deployment.md` | Схема деплоя на Beget и требуемые секреты. |
| `.clinerules` | Правила работы Cline в этом проекте. |
| `prompts/glavinstrument-consultant-v1.0.md` | Системная инструкция бота (источник формулировок). |

## 2. Репозиторий и ветка

- Remote: `https://github.com/SgoncharoffSU/Smartchat.git`
- Ветка: `main`
- Актуальный HEAD: `f83df5b` (память, правила, скрипты уже закоммичены).

## 3. Что уже готово

- Полный код диалогового бота (Express + TypeScript).
- Закоммичен и запушен в `origin/main`.
- `.gitignore` исключает `.env`, `data/`, `node_modules/`, `dist/`.
- `.gitattributes` фиксирует LF (важно для Linux/code-server).
- Memory-bank и правила Cline созданы.

## 4. Что нужно сделать на новом сервере (ручные шаги)

### 4.1. Среда разработки (code-server)
1. Склонировать репозиторий:
   ```bash
   git clone https://github.com/SgoncharoffSU/Smartchat.git
   cd Smartchat
   ```
2. Установить Node 20 LTS (см. `scripts/setup-code-server.sh` — он же ставит code-server).
3. `npm install && npm run build`.
4. Создать `.env` по образцу `.env.example`:
   ```bash
   cp .env.example .env
   # заполнить секреты, НЕ коммитить
   ```

### 4.2. Деплой боевой версии (Beget)
Данные SSH/панели Beget на момент хэндоффа не переданы владельцем.
Использовать `scripts/deploy-beget.sh` после заполнения в `.env`: `BEGET_HOST`,
`BEGET_USER`, `BEGET_PATH`, `BEGET_PORT`, `BEGET_BRANCH`. Скрипт подключается по
SSH-ключу `~/.ssh/beget_deploy`, делает `git pull` нужной ветки, `npm install`,
сборку, очистку кеша и перезапуск процесса. Подробнее — `memory-bank/deployment.md`.

## 5. Полезные команды

```bash
npm install
npm run build       # tsc -> dist/
npm start           # продакшен (node dist/server.js)
npm run dev         # разработка (tsx watch)
```

## 6. Ограничения, которые нужно помнить

- `.env` и `data/` — НИКОГДА не коммитить.
- Диалог — детерминированный автомат, не свободная нейросеть.
- Согласие на ПД — только явное.
- После изменений логики диалога обновлять и `prompts/glavinstrument-consultant-v1.0.md`.