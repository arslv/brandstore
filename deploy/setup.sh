#!/usr/bin/env bash
# Первичная настройка сервера Ubuntu 24.04 для Brand Store. Запускается из npm run deploy -- --setup
# (или вручную от root: bash /opt/brandstore/deploy/setup.sh). Повторный запуск безопасен.
set -euo pipefail

APP=/opt/brandstore
export DEBIAN_FRONTEND=noninteractive

echo "== Пакеты"
apt-get update -q
apt-get install -y -q curl ca-certificates nginx certbot python3-certbot-nginx xvfb sqlite3 ufw \
  fonts-liberation fonts-noto-color-emoji

echo "== Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node -v

echo "== Google Chrome (для цен по ссылке)"
if ! command -v google-chrome >/dev/null; then
  curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -q /tmp/chrome.deb
  rm -f /tmp/chrome.deb
fi
google-chrome --version

echo "== Подкачка 2 ГБ (браузеру нужна память)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Пользователь и папки"
id brandstore >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/brandstore --shell /usr/sbin/nologin brandstore
mkdir -p "$APP/data" "$APP/public/uploads"

echo "== Настройки (.env)"
if [ ! -f "$APP/.env" ]; then
  IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
  cat > "$APP/.env" <<EOF
NODE_ENV=production
PORT=3000
# После подключения домена: https://ваш-домен (это сделает npm run deploy -- --domain …)
SITE_URL=http://$IP
SESSION_SECRET=$(openssl rand -hex 32)

# Цена по ссылке: Google Chrome с окном на виртуальном экране (как Edge на компьютере владельца)
PARSER_BROWSER_CHANNEL=chrome
PARSER_BROWSER_WINDOW=on
# Прокси в ЕС — магазины не пускают российские адреса: http://логин:пароль@адрес:порт
PARSER_PROXY=
EOF
fi
chmod 600 "$APP/.env"
chown -R brandstore:brandstore "$APP" /home/brandstore

echo "== Автозапуск"
cp "$APP/deploy/brandstore-xvfb.service" "$APP/deploy/brandstore.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable brandstore-xvfb brandstore

echo "== nginx"
if [ ! -f /etc/nginx/sites-available/brandstore ]; then
  cp "$APP/deploy/nginx.conf" /etc/nginx/sites-available/brandstore
fi
ln -sf /etc/nginx/sites-available/brandstore /etc/nginx/sites-enabled/brandstore
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "== Резервная копия базы каждую ночь"
install -m 755 "$APP/deploy/backup.sh" /etc/cron.daily/brandstore-backup

echo "== Брандмауэр: только SSH, http, https"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

echo "== Готово"
