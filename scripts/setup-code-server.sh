#!/usr/bin/env bash
# =============================================================================
# Smartchat — установка code-server на Ubuntu/Debian VPS
# -----------------------------------------------------------------------------
# Что делает:
#   1. Обновляет apt и ставит git, curl, nodejs 20, npm, tmux, rsync.
#   2. Устанавливает code-server официальным скриптом code-server.dev.
#   3. Настраивает systemd-сервис code-server для текущего пользователя.
#   4. Создаёт ~/.config/code-server/config.yaml:
#        bind-addr: 127.0.0.1:8080
#        auth: password
#        пароль генерируется НАДЁЖНО и печатается ОДИН раз в конце.
#   5. Печатает инструкцию по безопасному доступу (SSH-туннель / Tailscale).
#
# Идемпотентен: повторный запуск не дублирует установку и не перезаписывает уже
# сгенерированный пароль (конфиг сохраняется, если пароль уже задан).
#
# Запуск (на сервере):
#   bash scripts/setup-code-server.sh
# -----------------------------------------------------------------------------

set -euo pipefail

CODE_SERVER_PORT="${CODE_SERVER_PORT:-8080}"
CODE_SERVER_USER="${SUDO_USER:-${USER:-$(id -un)}}"
CONFIG_DIR="/home/${CODE_SERVER_USER}/.config/code-server"
CONFIG_FILE="${CONFIG_DIR}/config.yaml"
CODESERVER_BIN="$(command -v code-server || true)"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
err() { printf '\n\033[1;31m[ОШИБКА]\033[0m %s\n' "$*" >&2; }

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    err "Запускайте от root: sudo bash scripts/setup-code-server.sh"
    exit 1
  fi
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  log "Обновляю apt и устанавливаю базовые пакеты"
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg tmux rsync

  # git
  if ! command -v git >/dev/null 2>&1; then
    apt-get install -y git
  else
    log "git уже установлен: $(git --version)"
  fi

  # Node.js 20 + npm (NodeSource)
  if ! command -v node >/dev/null 2>&1; then
    log "Устанавливаю Node.js 20 LTS (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    log "Node.js уже установлен: $(node -v)"
  fi
  node -v || true
  npm -v || true
}

install_code_server() {
  log "Устанавливаю code-server"
  if [[ -z "${CODESERVER_BIN}" ]]; then
    curl -fsSL https://code-server.dev/install.sh | sh
    CODESERVER_BIN="$(command -v code-server || true)"
  else
    log "code-server уже установлен: $(code-server --version | head -1)"
  fi
  if [[ -z "${CODESERVER_BIN}" ]]; then
    err "Не удалось определить путь к code-server после установки."
    exit 1
  fi
}

create_config() {
  log "Создаю конфиг code-server: ${CONFIG_FILE}"
  [[ -d "${CONFIG_DIR}" ]] || mkdir -p "${CONFIG_DIR}"

  # Не перезаписываем уже существующий пароль — иначе он потеряется при повторном
  # запуске и мы не сможем показать его пользователю.
  local existing_password=""
  if [[ -f "${CONFIG_FILE}" ]]; then
    existing_password="$(awk '/^password:/ {print $2}' "${CONFIG_FILE}" || true)"
  fi

  local password="${CODE_SERVER_PASSWORD:-${existing_password}}"
  if [[ -z "${password}" ]]; then
    password="$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"
  fi

  cat > "${CONFIG_FILE}" <<EOF
bind-addr: 127.0.0.1:${CODE_SERVER_PORT}
auth: password
password: ${password}
cert: false
EOF

  chown -R "${CODE_SERVER_USER}:${CODE_SERVER_USER}" "${CONFIG_DIR}"
  # Ограничиваем доступ к файлу с паролем
  chmod 600 "${CONFIG_FILE}"

  # Сохраняем в переменную для печати в конце
  CODE_SERVER_PASSWORD="${password}"
}

setup_systemd() {
  log "Создаю systemd-юнит code-server для пользователя ${CODE_SERVER_USER}"
  cat > /etc/systemd/system/code-server.service <<EOF
[Unit]
Description=code-server (Smartchat dev environment)
After=network.target

[Service]
Type=simple
User=${CODE_SERVER_USER}
ExecStart=${CODESERVER_BIN} --config ${CONFIG_FILE}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now code-server
  log "code-server запущен: 127.0.0.1:${CODE_SERVER_PORT} (systemd: $(systemctl is-active code-server))"
}

print_summary() {
  echo
  echo "============================================================================"
  log "УСТАНОВКА ЗАВЕРШЕНА"
  echo "   Пароль code-server (печатается ОДИН раз):"
  echo "       ${CODE_SERVER_PASSWORD}"
  echo "   Сохранён в: ${CONFIG_FILE}"
  echo "============================================================================"
  echo
  log "Безопасный доступ с планшета"
  echo "1. SSH-туннель (с локальной машины, порт 8080):"
  echo "   ssh -N -L 8080:localhost:8080 ${CODE_SERVER_USER}@<IP-сервера>"
  echo "   затем откройте в браузере: http://localhost:8080"
  echo
  echo "2. Через Tailscale (если оба устройства в tailnet):"
  echo "   откройте http://<tailscale-ip-сервера>:8080"
  echo
  echo "3. Порт 8080 слушается только на 127.0.0.1 — недоступен извне напрямую."
  echo "   Не открывайте его наружу без HTTPS-прокси (nginx + cert)."
  echo
  echo "Сменить пароль: nano ${CONFIG_FILE} && sudo systemctl restart code-server"
  echo
}

require_root
install_packages
install_code_server
create_config
setup_systemd
print_summary