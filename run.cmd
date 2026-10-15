@echo off
rem Запуск MicroPIDE на Windows: сборка при необходимости и старт сервера.
cd /d "%~dp0"
if not exist node_modules (
  echo MicroPIDE: ставлю зависимости...
  call npm install --no-audit --no-fund
)
if not exist dist\index.html (
  echo MicroPIDE: собираю фронтенд...
  call npm run build
)
echo MicroPIDE: http://localhost:8080
set PORT=8080
node server/server.mjs
