# AGENTS.md — контекст для ИИ-агентов (MicroPIDE)

Этот файл читают AI-агенты для кода (Cursor, Copilot, Claude Code, Aider и др.).
Он описывает проект, чтобы агент мог работать вместо разработчика.

## Проект

MicroPIDE — веб-среда разработки для Arduino (редактор скетчей, компиляция,
прошивка, монитор порта, графики). Node.js + React (Vite) + arduino-cli.

## Структура

- `server/server.mjs` — HTTP-сервер: статика `dist/`, API, обновление.
- `server/arduino.mjs` — обёртка arduino-cli.
- `server/serialbridge.mjs` — серийный мост.
- `server/updater.mjs` — автообновление (схема PSBees).
- `server/sketches.mjs` — скетчбук на диске.
- `scripts/` — install-cli, install-core, write-version.
- `src/App.tsx` — весь интерфейс.
- `src/ui/` — дизайн-система PSBees.
- `src/ide/` — специфика IDE.
- `test/` — смоук-тесты.

## Команды

- Установка + запуск: `./install.sh` (Linux/macOS) / `install.cmd` (Windows).
- Запуск: `./run.sh [порт]`, `./run.sh --build`.
- Разработка: `npm run dev` (vite, :5173) + `npm run server` (:8080).
- Сборка: `npm run build`.
- Тесты: `npm test` (highlight + server smoke).

## Переменные окружения

- `PORT` — порт сервера (по умолчанию 8080).
- `MICRO_PIDE_DATA` — каталог данных (по умолчанию `.data`).
- `MICRO_PIDE_SKETCHBOOK` — каталог скетчбука.
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` — ключ ИИ-агента.

## Правила для агента

- Не коммить секреты/ключи.
- Перед изменениями запускать `npm test`.
- Стиль кода: ES modules, React 18, TypeScript.
- Сервер на Node 18+.
- ИИ-агент отключён без ключа — не выполнять действия от его имени.

## ИИ-агент

Скрипт `scripts/agent.mjs` (запуск `./agent.sh "задача"`): берёт ключ из
окружения, отправляет задачу модели с контекстом проекта, выводит план/команды.
Выполнение деструктивных действий — только с подтверждением пользователя.
