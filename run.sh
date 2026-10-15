#!/usr/bin/env bash
# Запуск MicroPIDE (как в PSBees): сборка при необходимости и старт сервера.
#   ./run.sh [порт]          — собрать (если нет dist) и запустить
#   ./run.sh --build [порт]  — пересобрать и запустить
set -e
cd "$(dirname "$0")"

PORT_ARG=""
BUILD=0
for a in "$@"; do
  case "$a" in
    --build|-b) BUILD=1 ;;
    ''|*[!0-9]*) : ;;
    *) PORT_ARG="$a" ;;
  esac
done

if [ ! -d node_modules ]; then
  echo "MicroPIDE: ставлю зависимости…"
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund
fi

if [ "$BUILD" = 1 ] || [ ! -f dist/index.html ]; then
  echo "MicroPIDE: собираю фронтенд…"
  npm run build
fi

echo "MicroPIDE: http://localhost:${PORT_ARG:-8080}"
exec env PORT="${PORT_ARG:-8080}" node server/server.mjs
