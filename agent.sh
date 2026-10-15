#!/usr/bin/env bash
# Запуск ИИ-агента MicroPIDE одной командой.
# Требуется один API-ключ в окружении:
#   export OPENAI_API_KEY=sk-...          (или ANTHROPIC_API_KEY / GEMINI_API_KEY)
# Использование:
#   ./agent.sh "собери и прошей Blink на Uno"
set -e
cd "$(dirname "$0")"
exec node scripts/agent.mjs "$@"
