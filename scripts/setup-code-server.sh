#!/usr/bin/env bash
# =============================================================================
# Smartchat — настройка среды разработки code-server на VPS (Ubuntu/Debian)
# -----------------------------------------------------------------------------
# Что делает:
#   1. Обновляет систему и ставит базовые пакеты (curl, git, build-essential).
#   2. Устанавливает Node.js 20 LTS из официального репозитория NodeSource.
#   3. Устанавливает code-server (браузерная VS Code) из официального скрипта.
#   4. Создаёт systemd-юнит code-server для автозапуска.
#   5. Клонирует репозиторий Smartchat в ~/Smartchat и ставит зависимости.
#
# Запуск (на сервере):
#   bash scripts/setup-code-server.sh
# -----------------------------------------------------------------------------

set -euo pipefail

# --- Конфигурация (можно переопределить окружением) -------------------------
CODE_SERVER_PORT="${CODE_SERVER_PORT:-8080}"
CODE_SERVER_PASSWORD="${CODE_SERVER_PASSWORD:-}"
GIT_REPO="${GIT_REPO:-https://github.com/SgoncharoffSU/Smartchat.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
err() { printf '\n\033[1;31m[ОШИБКА]\033[0m %s\n' "$*" >&2; }

# --- Проверка прав ----------------------------------------------------------
if [[ "$(id -u)" -ne 0 ]]; then
  err "Запускайте от root: sudo bash scripts/setup-code-server.sh"
  exit 1
fi

# --- 1. Базовые пакеты ------------------------------------------------------
log "Обновляю систему и ставлю базовые пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl wget git build-essential ca-certificates gnupg

# --- 2. Node.js 20 LTS ------------------------------------------------------
log "Устанавливаю Node.js 20 LTS (NodeSource)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  log "Node.js уже установлен: $(node -v)"
fi
node -v
npm -v

# --- 3. code-server ---------------------------------------------------------
log "Устанавливаю code-server"
if ! command -v code-server >/dev/null 2>&1; then
  curl -fsSL https://code-server.dev/install.sh | sh
else
  log "code-server уже установлен: $(code-server --version | head -1)"
fi

# --- 4. systemd-юнит --------------------------------------------------------
log "Создаю systemd-юнит code-server"
CODE_SERVER_BIN="$(command -v code-server)"

cat > /etc/systemd/system/code-server.service <<EOF
[Unit]
Description=code-server (Smartchat dev environment)
After=network.target

[Service]
Type=simple
User=${SUDO_USER:-root}
Environment=PASSWORD=${CODE_SERVER_PASSWORD}
ExecStart=${CODE_SERVER_BIN} --bind-addr 0.0.0.0:${CODE_SERVER_PORT} --auth password
Restart=always
RestartSec=3
# Директория проекта (workspace)
WorkingDirectory=/home/${SUDO_USER:-root}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now code-server
log "code-server запущен на порту ${CODE_SERVER_PORT}"

# --- 5. Клонирование и установка зависимостей ------------------------------
TARGET_DIR="${TARGET_DIR:-/home/${SUDO_USER:-root}/Smartchat}"
log "Клонирую репозиторий в ${TARGET_DIR}"
if [[ ! -d "${TARGET_DIR}/.git" ]]; then
  git clone --branch "${GIT_BRANCH}" "${GIT_REPO}" "${TARGET_DIR}"
fi

log "Устанавливаю npm-зависимости и собираю проект"
cd "${TARGET_DIR}"
npm install
npm run build

# --- 6. Итоговые инструкции -------------------------------------------------
echo
log "Готово. Дальнейшие шаги:"
echo "  1. Откройте в браузере: http://<IP-сервера>:${CODE_SERVER_PORT}"
if [[ -n "${CODE_SERVER_PASSWORD}" ]]; then
  echo "     Пароль: задан через CODE_SERVER_PASSWORD"
else
  echo "     Пароль: смотрите в ~/.config/code-server/config.yaml"
fi
echo "  2. Откройте папку ${TARGET_DIR}"
echo "  3. Создайте .env: cp .env.example .env  (секреты в Git НЕ коммитить)"
echo "  4. Проверьте: npm run dev  (или npm start после npm run build)"