@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Brand Store
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите версию LTS с https://nodejs.org и запустите этот файл снова.
  pause
  exit /b 1
)
echo Проверяю зависимости...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo Не получилось установить зависимости. Пришлите текст ошибки выше.
  pause
  exit /b 1
)
echo Проверяю встроенный Chrome для цен по ссылке (первый раз скачается около 150 МБ)...
call npx playwright install --no-shell chromium
if errorlevel 1 echo Chrome не скачался - сайт работает, но цены с защищенных сайтов подставляться не будут. Повторите позже: npm run browser
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
echo.
echo Сайт: http://localhost:3000   Админка: http://localhost:3000/admin
echo Чтобы остановить сайт, закройте это окно.
echo.
call npm start
pause
