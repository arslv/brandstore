#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите версию LTS с https://nodejs.org и запустите этот файл снова."
  read -r -p "Нажмите Enter, чтобы закрыть окно"
  exit 1
fi
echo "Проверяю зависимости..."
if ! npm install --no-audit --no-fund; then
  echo "Не получилось установить зависимости. Пришлите текст ошибки выше."
  read -r -p "Нажмите Enter, чтобы закрыть окно"
  exit 1
fi
echo "Проверяю встроенный Chrome для цен по ссылке (первый раз скачается около 150 МБ)..."
npx playwright install --no-shell chromium || echo "Chrome не скачался — сайт работает, но цены с защищённых сайтов подставляться не будут. Повторите позже: npm run browser"
(sleep 3; open http://localhost:3000) &
echo
echo "Сайт: http://localhost:3000   Админка: http://localhost:3000/admin"
echo "Чтобы остановить сайт, закройте это окно или нажмите Ctrl+C."
echo
npm start
