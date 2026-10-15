#!/usr/bin/env bash
# ============================================================
# Единый установщик MicroPIDE (Linux / macOS).
# Скачивает и настраивает ВСЁ и запускает среду:
#   1. Node.js 18+ (через пакетный менеджер системы, иначе — официальный
#      архив в .data/node, без прав root);
#   2. зависимости npm и сборку фронтенда;
#   3. arduino-cli (с GitHub в .data/bin);
#   4. платформу Arduino AVR (платы Uno/Nano/Mega), если уже нет своей;
#   5. при --desktop — ярлык в меню приложений;
#   6. стартует сервер и печатает адрес.
#
# Использование:
#   ./install.sh                  # всё поставить и запустить на :8080
#   ./install.sh --port 3000      # другой порт
#   ./install.sh --no-avr         # не ставить платформу AVR
#   ./install.sh --no-run         # установить, но не запускать
#   ./install.sh --desktop        # добавить ярлык (Linux)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

PORT="8080"
WITH_AVR=1
DO_RUN=1
DESKTOP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port)    PORT="${2:?нужен номер порта}"; shift 2 ;;
    --no-avr)  WITH_AVR=0; shift ;;
    --no-run)  DO_RUN=0; shift ;;
    --desktop) DESKTOP=1; shift ;;
    *) echo "Неизвестный ключ: $1 (есть --port N, --no-avr, --no-run, --desktop)"; exit 2 ;;
  esac
done

step() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;31m  ! %s\033[0m\n' "$*"; }

SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

# ---------------------------------------------------------------- 1. Node.js
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "${major:-0}" -ge 18 ]
}

install_node_pkg() {
  # через пакетный менеджер системы; 1 — удалось
  if command -v apt-get >/dev/null 2>&1; then
    step "Ставлю Node.js 20 через apt (NodeSource)"
    export DEBIAN_FRONTEND=noninteractive
    $SUDO apt-get update -y || true
    $SUDO apt-get install -y curl ca-certificates gnupg || true
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - || return 1
    $SUDO apt-get install -y nodejs || return 1
  elif command -v dnf >/dev/null 2>&1; then
    step "Ставлю Node.js через dnf"
    $SUDO dnf install -y nodejs npm || return 1
  elif command -v pacman >/dev/null 2>&1; then
    step "Ставлю Node.js через pacman"
    $SUDO pacman -Sy --noconfirm nodejs npm || return 1
  elif command -v zypper >/dev/null 2>&1; then
    step "Ставлю Node.js через zypper"
    $SUDO zypper install -y nodejs20 || $SUDO zypper install -y nodejs || return 1
  elif command -v brew >/dev/null 2>&1; then
    step "Ставлю Node.js через Homebrew"
    brew install node || return 1
  else
    return 1
  fi
  node_ok
}

install_node_tarball() {
  # официальный архив Node.js в .data/node — без прав root
  step "Ставлю Node.js в $ROOT/.data/node (без системных прав)"
  local arch ver="20.18.1" tar_arch
  case "$(uname -m)" in
    x86_64)  tar_arch="x64" ;;
    aarch64|arm64) tar_arch="arm64" ;;
    armv7l)  tar_arch="armv7l" ;;
    *) warn "Неизвестная архитектура $(uname -m)"; return 1 ;;
  esac
  local os="linux"; [ "$(uname)" = "Darwin" ] && os="darwin"
  local url="https://nodejs.org/dist/v${ver}/node-v${ver}-${os}-${tar_arch}.tar.gz"
  mkdir -p .data
  curl -fL --retry 3 -o .data/node.tar.gz "$url"
  rm -rf .data/node
  mkdir -p .data/node
  tar -xzf .data/node.tar.gz -C .data/node --strip-components=1
  rm -f .data/node.tar.gz
  export PATH="$ROOT/.data/node/bin:$PATH"
  node_ok
}

step "Проверяю Node.js"
if node_ok; then
  ok "Node.js $(node -v) уже установлен"
else
  install_node_pkg || install_node_tarball || {
    warn "Не удалось установить Node.js автоматически."
    warn "Поставьте Node.js 18+ с https://nodejs.org и запустите установщик снова."
    exit 1
  }
  ok "Node.js $(node -v) готов"
fi
command -v npm >/dev/null 2>&1 || { warn "npm не найден рядом с node"; exit 1; }

# ---------------------------------------------------------------- 2. зависимости и сборка
step "Ставлю зависимости (npm)"
if [ -d node_modules ] && [ -z "${MICRO_PIDE_FORCE_DEPS:-}" ]; then
  ok "node_modules на месте"
else
  npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
  ok "зависимости установлены"
fi

step "Собираю фронтенд"
npm run build >/dev/null
ok "сборка готова (dist/)"

# ---------------------------------------------------------------- 3. arduino-cli
step "Проверяю arduino-cli"
CLI_BIN=".data/bin/arduino-cli"
if command -v arduino-cli >/dev/null 2>&1; then
  ok "системный arduino-cli: $(command -v arduino-cli)"
elif [ -x "$CLI_BIN" ]; then
  ok "уже скачан: $ROOT/$CLI_BIN"
else
  if node scripts/install-cli.mjs; then
    ok "arduino-cli установлен в .data/bin"
  else
    warn "arduino-cli не скачался (нет сети?). Компиляцию можно будет поставить позже кнопкой в UI."
  fi
fi

# ---------------------------------------------------------------- 4. платформа AVR
if [ "$WITH_AVR" = "1" ]; then
  step "Проверяю платформу Arduino AVR (Uno, Nano, Mega)"
  if [ -d "$HOME/.arduino15/packages/arduino/hardware/avr" ] \
     || [ -d "$HOME/Library/Arduino15/packages/arduino/hardware/avr" ] \
     || [ -d "$LOCALAPPDATA/Arduino15/packages/arduino/hardware/avr" ] 2>/dev/null \
     || [ -d ".data/arduino15/packages/arduino/hardware/avr" ]; then
    ok "платформа AVR уже есть (своя или из Arduino IDE)"
  else
    if node scripts/install-core.mjs arduino:avr; then
      ok "платформа AVR установлена"
    else
      warn "AVR не поставился (нет сети?). Поставится позже через «Платы» в UI."
    fi
  fi
fi

# ---------------------------------------------------------------- 5. права на порты (Linux)
if [ "$(uname)" = "Linux" ] && command -v groups >/dev/null 2>&1; then
  case ":$groups:" in
    *:dialout:*|*:uucp:*) : ;;
    *) warn "Для доступа к /dev/ttyUSB0 и /dev/ttyACM0 добавьте себя в группу dialout:"
       warn "  sudo usermod -aG dialout \$USER   (затем перелогиньтесь)" ;;
  esac
fi

# ---------------------------------------------------------------- 6. ярлык
if [ "$DESKTOP" = "1" ] && [ "$(uname)" = "Linux" ]; then
  APPDIR="$HOME/.local/share/applications"
  mkdir -p "$APPDIR"
  cat > "$APPDIR/micropide.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=MicroPIDE
Comment=Среда разработки Arduino
Exec=$ROOT/run.sh $PORT
Icon=$ROOT/public/icon.svg
Terminal=false
Categories=Development;Electronics;
EOF
  ok "ярлык создан: $APPDIR/micropide.desktop"
fi

# ---------------------------------------------------------------- 7. запуск
if [ "$DO_RUN" = "1" ]; then
  step "Запускаю MicroPIDE на http://localhost:$PORT"
  exec env PORT="$PORT" node server/server.mjs
else
  echo
  ok "Установка завершена. Запуск: ./run.sh $PORT"
fi
