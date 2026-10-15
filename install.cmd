@echo off
rem ============================================================
rem Единый установщик MicroPIDE (Windows).
rem Ставит Node.js (через winget, если нет), зависимости, собирает
rem фронтенд, скачивает arduino-cli и платформу AVR, запускает сервер.
rem
rem   install.cmd            — всё поставить и запустить на :8080
rem   install.cmd 3000       — другой порт
rem   install.cmd --no-avr   — без платформы AVR
rem ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set PORT=8080
set WITH_AVR=1
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--no-avr" ( set WITH_AVR=0 ) else ( set PORT=%~1 )
shift
goto parse
:parsed

echo ==^> Проверяю Node.js
set NODE_OK=0
where node >nul 2>nul && (
  for /f "tokens=* usebackq" %%v in (`node -v`) do set NODEV=%%v
  set NODE_OK=1
  echo   ✓ Node.js !NODEV! уже установлен
)
if !NODE_OK!==0 (
  echo ==^> Ставлю Node.js LTS через winget...
  where winget >nul 2>nul && (
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  )
  rem обновить PATH текущей сессии
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
  where node >nul 2>nul || (
    echo   ! Не удалось поставить Node.js автоматически.
    echo   ! Поставьте Node.js LTS с https://nodejs.org и запустите install.cmd снова.
    pause
    exit /b 1
  )
  for /f "tokens=* usebackq" %%v in (`node -v`) do set NODEV=%%v
  echo   ✓ Node.js !NODEV! установлен
)

echo ==^> Ставлю зависимости ^(npm^)
if not exist node_modules (
  call npm install --no-audit --no-fund || goto fail
) else (
  echo   ✓ node_modules на месте
)

echo ==^> Собираю фронтенд
call npm run build || goto fail

echo ==^> Проверяю arduino-cli
if exist ".data\bin\arduino-cli.exe" (
  echo   ✓ уже скачан: %CD%\.data\bin\arduino-cli.exe
) else (
  node scripts\install-cli.mjs || echo   ! arduino-cli не скачался — можно поставить позже кнопкой в UI
)

if %WITH_AVR%==1 (
  echo ==^> Проверяю платформу Arduino AVR ^(Uno, Nano, Mega^)
  if exist "%LOCALAPPDATA%\Arduino15\packages\arduino\hardware\avr" (
    echo   ✓ платформа AVR уже есть — из вашей Arduino IDE
  ) else if exist ".data\arduino15\packages\arduino\hardware\avr" (
    echo   ✓ платформа AVR уже установлена
  ) else (
    node scripts\install-core.mjs arduino:avr || echo   ! AVR не поставился — можно поставить позже через «Платы»
  )
)

echo.
echo ==^> Запускаю MicroPIDE: http://localhost:%PORT%
set PORT=%PORT%
start "" http://localhost:%PORT%
node server\server.mjs
exit /b 0

:fail
echo   ! Установка не удалась — проверьте сообщения выше.
pause
exit /b 1
