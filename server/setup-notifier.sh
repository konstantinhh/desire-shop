#!/bin/bash
# Установка/обновление сервиса уведомлений DESIRE на сервере.
# Запуск:  bash ~/desire/shop/server/setup-notifier.sh
# Повторный запуск безопасен: токен бота спросит заново только если его ещё нет.
set -euo pipefail
D="$HOME/desire"; SB="$HOME/supabase"; ENVF="$D/notifier.env"

echo "1/4  Обновляем таблицы базы…"
PGPW="$(grep -E '^POSTGRES_PASSWORD=' "$SB/.env" | cut -d= -f2-)"
docker exec -i -e PGPASSWORD="$PGPW" supabase-db psql -h localhost -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
  < "$D/shop/db/supabase-setup.sql" 2>&1 | grep -v -E "NOTICE|already exists|does not exist, skipping" || true

echo "2/4  Настройки сервиса…"
if [ ! -f "$ENVF" ] || ! grep -q '^TG_TOKEN=.\+' "$ENVF"; then
  read -r -s -p "     Вставьте токен бота от @BotFather (символы не видны): " TOKEN; echo
  [[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || { echo "     Это не похоже на токен бота. Запустите скрипт ещё раз."; exit 1; }
else
  TOKEN="$(grep -E '^TG_TOKEN=' "$ENVF" | cut -d= -f2-)"
fi
PGPW_URL="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$PGPW")"
umask 077
cat > "$ENVF" <<EOF
DATABASE_URL=postgresql://postgres:${PGPW_URL}@supabase-db:5432/postgres
TG_TOKEN=${TOKEN}
SITE_URL=https://desire-store.ru
CONTACT_EMAIL=konstan1in@bk.ru
DEFAULT_TZ=Asia/Irkutsk
EOF
chmod 600 "$ENVF"; umask 022

echo "3/4  Обновляем docker-compose и автообновление…"
cat > "$D/docker-compose.yml" <<'EOF'
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./shop/site:/srv/site:ro
      - caddy_data:/data
    networks: [default, supabase]
  notifier:
    build: ./shop/server/notifier
    restart: unless-stopped
    env_file: ./notifier.env
    volumes: [notifier_data:/data]
    networks: [supabase]
networks:
  supabase:
    external: true
    name: supabase_default
volumes:
  caddy_data:
  notifier_data:
EOF
# Раз в 5 минут: забрать изменения с GitHub; сервис уведомлений пересобирается, только если его код изменился
( crontab -l 2>/dev/null | grep -v 'desire/shop' ; echo "*/5 * * * * cd $D/shop && git pull -q && cd $D && docker compose up -d --build notifier >/dev/null 2>&1" ) | crontab -

echo "4/4  Запускаем сервис уведомлений…"
cd "$D" && docker compose up -d --build notifier
sleep 12
docker compose logs --tail 15 notifier | sed -E 's/[0-9]+:[A-Za-z0-9_-]{30,}/<token>/g'
echo
echo "Готово. В логах выше должны быть строки «listening» и «bot @имя_бота»."
