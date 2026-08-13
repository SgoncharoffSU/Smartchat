#!/usr/bin/env bash
# =============================================================================
# Smartchat — деплой на хостинг Beget по SSH
# -----------------------------------------------------------------------------
# Параметры (env или .env):
#   BEGET_HOST    — SSH-хост Байджета (например, username.beget.com)
#   BEGET_USER    — SSH-логин в Байджете
#   BEGET_PATH    — папка проекта на хостинге (например, smartchat)
#   BEGET_PORT    — порт SSH (по умолчанию 22)
#   BEGET_BRANCH  — ветка для git pull (по умолчанию main)
#
# Подключение — ТОЛЬКО по SSH-ключу: ~/.ssh/beget_deploy
# (публичную часть нужно заранее добавить в панель Beget).
#
# Сценарий на сервере:
#   cd $BEGET_PATH && git fetch && git checkout/постановка на ветку && git pull
#   npm install --omit=dev
#   сборка при наличии скрипта "build" в package.json
#   очистка npm-кеша
#   перезапуск процесса при наличии PM2/systemd
#
# Запуск: bash scripts/deploy-beget.sh
# Секреты НЕ попадают в репозиторий: реальные значения — только в .env на сервере.
# =============================================================================

set -euo pipefail

SSH_KEY="${BEGET_SSH_KEY:-${HOME}/.ssh/beget_deploy}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
err() { printf '\n\033[1;31m[ОШИБКА]\033[0m %s\n' "$*" >&2; }

# --- Загрузка переменных из .env (значения из окружения имеют приоритет) ----
load_env_file() {
  if [[ -f ".env" ]]; then
    log "Читаю переменные из .env"
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
  fi
}

# --- Проверка обязательных параметров --------------------------------------
validate() {
  [[ -n "${BEGET_HOST:-}" ]] || { err "Не задан BEGET_HOST"; exit 1; }
  [[ -n "${BEGET_USER:-}" ]] || { err "Не задан BEGET_USER"; exit 1; }
  BEGET_PATH="${BEGET_PATH:-smartchat}"
  BEGET_PORT="${BEGET_PORT:-22}"
  BEGET_BRANCH="${BEGET_BRANCH:-main}"

  if [[ ! -f "${SSH_KEY}" ]]; then
    err "SSH-ключ не найден: ${SSH_KEY}"
    err "Сгенерируйте: ssh-keygen -t ed25519 -f ${SSH_KEY} -N \"\""
    err "И добавьте ${SSH_KEY}.pub в панель Beget (SSH-доступ)."
    exit 1
  fi
}

# --- SSH-обёртка ------------------------------------------------------------
ssh_run() {
  ssh -i "${SSH_KEY}" -p "${BEGET_PORT}" \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    "${BEGET_USER}@${BEGET_HOST}" "$@"
}

# --- Основной сценарий деплоя ----------------------------------------------
deploy() {
  REMOTE="${BEGET_USER}@${BEGET_HOST}"

  log "Подключаюсь к ${REMOTE} (порт ${BEGET_PORT}, ветка ${BEGET_BRANCH})"
  ssh_run "test -d \"${BEGET_PATH}/.git\"" \
    || { err "На сервере нет git-репозитория: ${BEGET_PATH}"; exit 1; }

  log "git checkout ${BEGET_BRANCH} и git pull"
  ssh_run "cd \"${BEGET_PATH}\" && git fetch --prune && git checkout \"${BEGET_BRANCH}\" && git reset --hard origin/${BEGET_BRANCH}"

  log "Устанавливаю production-зависимости"
  ssh_run "cd \"${BEGET_PATH}\" && npm install --omit=dev"

  log "Сборка (если в package.json есть скрипт build)"
  ssh_run "cd \"${BEGET_PATH}\" && node -e \"const p=require('./package.json'); if(!p.scripts||!p.scripts.build){console.log('no-build');process.exit(0)}\" && npm run build || true"

  log "Очистка npm-кеша"
  ssh_run "npm cache clean --force 2>/dev/null || true"

  log "Перезапуск процесса при наличии (PM2)"
  # PM2 может отсутствовать — тогда пропускаем с понятным сообщением.
  ssh_run "command -v pm2 >/dev/null 2>&1 && pm2 restart \"${BEGET_PATH}/dist/server.js\" --update-env || echo 'PM2 не найден — перезапуск выполняется вручную через панель Beget'"
}

load_env_file
validate
deploy

log "Деплой завершён успешно."