#!/usr/bin/env bash
# Установка и обновление Brand Store на сервере, где уже работают другие проекты. Чужое не трогает:
#   свой Node.js в /opt/brandstore/.node (системный не меняется), свой свободный порт (от 3100),
#   своя служба brandstore; nginx, брандмауэр (кроме разрешения своего порта) и другие сайты не меняются.
#
# Запуск от root (и первый раз, и для обновления до последней версии с GitHub):
#   curl -fsSL https://raw.githubusercontent.com/arslv/brandstore/main/deploy/install.sh | bash
set -euo pipefail

APP=/opt/brandstore
REPO=https://github.com/arslv/brandstore.git
NODE_VERSION=22.19.0
export DEBIAN_FRONTEND=noninteractive

[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }

echo "== Нужные пакеты (только добавляются)"
need=()
for p in git curl xz-utils xvfb xauth; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
if [ ${#need[@]} -gt 0 ]; then apt-get update -q && apt-get install -y -q "${need[@]}"; fi

echo "== Google Chrome (для цен по ссылке)"
if ! command -v google-chrome >/dev/null; then
  if [ "$(dpkg --print-architecture)" = amd64 ]; then
    curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
      && apt-get install -y -q /tmp/chrome.deb || echo "Chrome не поставился — сайт будет работать, но без автоматических цен"
    rm -f /tmp/chrome.deb
  else
    echo "Не x86-сервер — Chrome пропускаю, цены по ссылке будут вручную"
  fi
fi

echo "== Код с GitHub"
if [ -d "$APP/.git" ]; then
  git -c safe.directory="$APP" -C "$APP" fetch -q origin main
  git -c safe.directory="$APP" -C "$APP" reset -q --hard origin/main   # .env, data/ и загруженные фото не в git — они остаются
else
  git clone -q "$REPO" "$APP"
fi
git -c safe.directory="$APP" -C "$APP" log -1 --format='Версия: %h %s'

echo "== Свой Node.js $NODE_VERSION (системный не трогаем)"
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) echo "Неизвестная архитектура $(uname -m)"; exit 1 ;; esac
if [ "$("$APP/.node/bin/node" -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  rm -rf "$APP/.node" && mkdir -p "$APP/.node"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.xz" | tar -xJ -C "$APP/.node" --strip-components=1
fi
export PATH="$APP/.node/bin:$PATH"
node -v

echo "== Пользователь brandstore"
id brandstore >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/brandstore --shell /usr/sbin/nologin brandstore
mkdir -p "$APP/data" "$APP/public/uploads"

echo "== Настройки (.env)"
if [ ! -f "$APP/.env" ]; then
  PORT=3100
  while ss -tln | awk '{print $4}' | grep -qE "[:.]$PORT\$"; do PORT=$((PORT + 1)); done
  IP=$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
  ADMIN_PASS=$(openssl rand -base64 12 | tr -d '/+=')
  CHANNEL=$(command -v google-chrome >/dev/null && echo chrome || echo '')
  cat > "$APP/.env" <<EOF
NODE_ENV=production
PORT=$PORT
SITE_URL=http://$IP:$PORT
SESSION_SECRET=$(openssl rand -hex 32)
# Админка создаётся при первом запуске с этим паролем; сменить: см. README
ADMIN_EMAIL=admin@brandstore.local
ADMIN_PASSWORD=$ADMIN_PASS

# Цена по ссылке: Google Chrome с окном на виртуальном экране
PARSER_BROWSER_CHANNEL=$CHANNEL
PARSER_BROWSER_WINDOW=on
# Прокси в ЕС, если магазины не пускают адрес сервера: http://логин:пароль@адрес:порт
PARSER_PROXY=
EOF
  FIRST=1
fi
chmod 600 "$APP/.env"
PORT=$(grep '^PORT=' "$APP/.env" | cut -d= -f2)

echo "== Зависимости"
chown -R brandstore:brandstore "$APP" /home/brandstore
cd "$APP"
sudo -u brandstore -H env PATH="$PATH" npm ci --omit=dev --no-audit --no-fund --loglevel=error

echo "== Автозапуск (служба brandstore)"
cat > /etc/systemd/system/brandstore.service <<EOF
[Unit]
Description=Brand Store (порт $PORT)
After=network.target

[Service]
User=brandstore
WorkingDirectory=$APP
Environment=PATH=$APP/.node/bin:/usr/local/bin:/usr/bin:/bin
# Виртуальный экран для браузера (цены по ссылке)
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1366x900x24 -nolisten tcp" $APP/.node/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q brandstore
systemctl restart brandstore

# Если включён брандмауэр ufw — открываем только свой порт
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "$PORT/tcp" >/dev/null; fi

echo "== Проверка"
for i in $(seq 1 15); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
  URL=$(grep '^SITE_URL=' "$APP/.env" | cut -d= -f2)
  echo
  echo "Готово! Сайт: $URL   админка: $URL/admin"
  if [ "${FIRST:-0}" = 1 ]; then
    echo "Вход в админку: admin@brandstore.local / $(grep '^ADMIN_PASSWORD=' "$APP/.env" | cut -d= -f2)"
  fi
  echo "Обновить до новой версии — запустить эту же команду ещё раз."
else
  echo "Сайт не ответил. Журнал:"
  journalctl -u brandstore -n 40 --no-pager
  exit 1
fi
