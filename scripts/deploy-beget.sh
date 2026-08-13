#!/usr/bin/env bash
# =============================================================================
# Smartchat — деплой боевой версии на хостинг Beget
# -----------------------------------------------------------------------------
# Что делает:
#   1. Проверяет заполненность переменных подключения.
#   2. Собирает проект локально (npm run build).
#   3. Копирует на Beget: dist/, public/, prompts/, package*.json, .env.
#   4. На сервере: npm install --omit=dev, создаёт data/.
#
# Запуск (локально или из code-server):
#   bash scripts/deploy-beget.sh
#
# Переменные окружения (заполните перед запуском):
#   BEGET_HOST        — хост SSH Beget (например, username.beget.com)
#   BEGET_USER        — пользователь SSH
#   BEGET_PATH        — путь к папке проекта на хостинге (например, smartchat)
#   BEGET_PORT        — порт SSH (по умолчанию 22)
# -----------------------------------------------------------------------------

set -euo pipefail

# --- Конфигурация -----------------------------------------------------------
BEGET_HOST="${BEGET_HOST:-}"
BEGET_USER="${BEGET_USER:-}"
BEGET_PATH="${BEGET_PATH:-smartchat}"
BEGET_PORT="${BEGET_PORT:-22}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
err() { printf '\n\033[1;31m[ОШИБКА]\033[0m %s\n' "$*" >&2; }

# --- Проверка обязательных параметров --------------------------------------
if [[ -z "${BEGET_HOST}" || -z "${BEGET_USER}" ]]; then
  err "Задайте BEGET_HOST и BEGET_USER (см. инструкцию в начале скрипта)."
  exit 1
fi

REMOTE="${BEGET_USER}@${BEGET_HOST}"
SSH_RSH="ssh -p ${BEGET_PORT}"

# --- Локальная сборка -------------------------------------------------------
log "Собираю проект локально"
npm install
npm run build

# --- Проверка .env ----------------------------------------------------------
if [[ ! -f ".env" ]]; then
  err "Файл .env не найден. Создайте его по образцу .env.example и заполните секреты."
  exit 1
fi

# --- Подготовка каталога на сервере ----------------------------------------
log "Создаю структуру каталогов на ${REMOTE}:${BEGET_PATH}"
ssh -p "${BEGET_PORT}" "${REMOTE}" "mkdir -p ${BEGET_PATH}/dist ${BEGET_PATH}/public ${BEGET_PATH}/prompts ${BEGET_PATH}/data"

# --- Копирование артефактов ------------------------------------------------
log "Копирую артефакты сборки на Beget"
if command -v rsync >/dev/null 2>&1; then
  rsync -avz -e "${SSH_RSH}" \
    dist/        "${REMOTE}:${BEGET_PATH}/dist/" \
    public/      "${REMOTE}:${BEGET_PATH}/public/" \
    prompts/     "${REMOTE}:${BEGET_PATH}/prompts/"
else
  log "rsync не найден, использую scp"
  scp -P "${BEGET_PORT}" -r dist/* "${REMOTE}:${BEGET_PATH}/dist/"
  scp -P "${BEGET_PORT}" -r public/* "${REMOTE}:${BEGET_PATH}/public/"
  scp -P "${BEGET_PORT}" -r prompts/* "${REMOTE}:${BEGET_PATH}/prompts/"
fi

# --- Копирование манифестов и .env -----------------------------------------
log "Копирую package.json, package-lock.json и .env"
if command -v rsync >/dev/null 2>&1; then
  rsync -avz -e "${SSH_RSH}" package.json package-lock.json "${REMOTE}:${BEGET_PATH}/"
  rsync -avz -e "${SSH_RSH}" .env "${REMOTE}:${BEGET_PATH}/.env"
else
  scp -P "${BEGET_PORT}" package.json package-lock.json .env "${REMOTE}:${BEGET_PATH}/"
fi

# --- Установка зависимостей и финализация ----------------------------------
log "Устанавливаю production-зависимости на сервере"
ssh -p "${BEGET_PORT}" "${REMOTE}" "cd ${BEGET_PATH} && npm install --omit=dev && echo OK"

log "Деплой завершён. Перезапустите процесс Node на Beget:"
log "  cd ${BEGET_PATH} && npm start   (node dist/server.js)"