#!/usr/bin/env bash
# Запуск MicroPIDE (как в PSBees): сборка при необходимости и старт сервера.
#   ./run.sh [порт]          — собрать (если нет dist) и запустить
#   ./run.sh --build [порт]  — пересобрать и запустить
#   ./run.sh --open [порт]   — ещё и открыть браузер, когда сервер поднимется
#                              (так запускается ярлык на рабочем столе)
set -e
cd "$(dirname "$0")"

PORT_ARG=""
BUILD=0
OPEN=0
for a in "$@"; do
  case "$a" in
    --build|-b) BUILD=1 ;;
    --open) OPEN=1 ;;
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

if [ "$OPEN" = 1 ] && command -v xdg-open >/dev/null 2>&1; then
  # В фоне ждём, пока порт начнёт отвечать, и открываем браузер.
  (
    for _ in $(seq 1 100); do
      if (exec 3<>"/dev/tcp/127.0.0.1/${PORT_ARG:-8080}") 2>/dev/null; then
        xdg-open "http://localhost:${PORT_ARG:-8080}" >/dev/null 2>&1
        break
      fi
      sleep 0.2
    done
  ) &
fi

exec env PORT="${PORT_ARG:-8080}" node server/server.mjs
