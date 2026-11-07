#!/usr/bin/env bash
# Подключение домена к QLIC на сервере, где уже работают другие проекты (запуск от root):
#   curl -fsSL https://raw.githubusercontent.com/arslv/brandstore/main/deploy/domain.sh | bash -s -- qlic.store
#   (можно добавить почту для писем Let's Encrypt о продлении: … | bash -s -- qlic.store you@example.com)
#
# Что делает:
#   1) проверяет, что домен уже указывает на этот сервер (A-записи в reg.ru);
#   2) проверяет, кто занимает порты 80/443: если не nginx (например, Docker другого проекта) — ничего не меняет и останавливается;
#   3) добавляет в nginx ОТДЕЛЬНЫЙ сайт только для этого домена (чужие сайты и настройки не трогает) → сайт QLIC на его порту;
#   4) получает бесплатный HTTPS-сертификат Let's Encrypt (certbot, продлевается сам) и включает переход http → https;
#   5) пишет SITE_URL=https://домен в /opt/brandstore/.env и перезапускает сайт.
# Повторный запуск безопасен.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP=/opt/brandstore

[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
[ -n "$DOMAIN" ] || { echo "Укажите домен: curl … | bash -s -- qlic.store"; exit 1; }
[ -f "$APP/.env" ] || { echo "Сайт ещё не установлен: сначала deploy/install.sh"; exit 1; }
PORT=$(grep '^PORT=' "$APP/.env" | cut -d= -f2)
[ -n "$PORT" ] || { echo "В $APP/.env нет PORT"; exit 1; }

echo "== Домен смотрит на этот сервер?"
IP=$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
resolve() { getent ahostsv4 "$1" | awk '{print $1}' | sort -u | tr '\n' ' '; }
for h in "$DOMAIN" "www.$DOMAIN"; do echo "  $h → $(resolve "$h" || true)"; done
echo "  этот сервер: $IP"
if ! resolve "$DOMAIN" | grep -qw "$IP"; then
  echo
  echo "Домен $DOMAIN пока не указывает на $IP."
  echo "В reg.ru: «DNS-серверы и управление зоной» → A-записи @ и www → $IP. Обновление занимает 15–60 минут, потом запустите команду ещё раз."
  exit 1
fi
NAMES="$DOMAIN"
if resolve "www.$DOMAIN" | grep -qw "$IP"; then NAMES="$DOMAIN www.$DOMAIN"; else echo "  www.$DOMAIN пока не указывает сюда — подключаю без www"; fi

echo "== Кто занимает порты 80 и 443"
ss -ltnp '( sport = :80 or sport = :443 )' || true
if ss -ltnpH '( sport = :80 or sport = :443 )' | grep -v '"nginx"' | grep -q .; then
  echo
  echo "Порты 80/443 занимает не nginx (см. выше) — скорее всего, другой проект. Ничего не меняю, чтобы его не сломать."
  echo "Пришлите этот вывод — подключим домен через то, что уже стоит."
  exit 1
fi

echo "== nginx и certbot (только добавляются)"
need=()
for p in nginx certbot python3-certbot-nginx; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
if [ ${#need[@]} -gt 0 ]; then apt-get update -q && apt-get install -y -q "${need[@]}"; fi
systemctl enable -q --now nginx

echo "== Сайт $DOMAIN в nginx (отдельный файл, другие сайты не трогаются)"
if [ -d /etc/nginx/sites-available ]; then
  CONF=/etc/nginx/sites-available/qlic-$DOMAIN.conf
  LINK=/etc/nginx/sites-enabled/qlic-$DOMAIN.conf
else
  CONF=/etc/nginx/conf.d/qlic-$DOMAIN.conf
  LINK=""
fi
cat > "$CONF" <<EOF
# QLIC: $NAMES → сайт на порту $PORT. Создано deploy/domain.sh; HTTPS дописывает certbot.
server {
    listen 80;
    server_name $NAMES;

    client_max_body_size 10m;   # загрузка фото (до 8 МБ)

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;   # цена по ссылке может искаться до ~20 с
    }
}
EOF
[ -n "$LINK" ] && ln -sf "$CONF" "$LINK"
if ! nginx -t; then
  echo "nginx не принял настройку — убираю её, другие сайты не затронуты."
  rm -f "$CONF" ${LINK:+"$LINK"}
  exit 1
fi
systemctl reload nginx

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "== Брандмауэр: открываю 80 и 443"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

echo "== HTTPS-сертификат Let's Encrypt"
args=(--nginx --non-interactive --agree-tos --redirect --keep-until-expiring)
for n in $NAMES; do args+=(-d "$n"); done
if [ -n "$EMAIL" ]; then args+=(-m "$EMAIL"); else args+=(--register-unsafely-without-email); fi
certbot "${args[@]}"

echo "== Адрес сайта: https://$DOMAIN"
if grep -q '^SITE_URL=' "$APP/.env"; then
  sed -i "s#^SITE_URL=.*#SITE_URL=https://$DOMAIN#" "$APP/.env"
else
  echo "SITE_URL=https://$DOMAIN" >> "$APP/.env"
fi
systemctl restart brandstore

echo "== Проверка"
for i in $(seq 1 15); do curl -fsS -o /dev/null "https://$DOMAIN/" && break; sleep 1; done
if curl -fsS -o /dev/null "https://$DOMAIN/"; then
  echo
  echo "Готово! Сайт: https://$DOMAIN   админка: https://$DOMAIN/admin"
  echo "Сертификат продлевается сам. Входите теперь только через https://$DOMAIN (по IP вход работать не будет)."
else
  echo "Сайт по https пока не открылся. Пришлите: journalctl -u brandstore -n 30 --no-pager и nginx -t"
  exit 1
fi
