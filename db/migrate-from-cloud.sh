#!/bin/bash
# Перенос магазина DESIRE из облачного Supabase на свой сервер.
# Запуск на сервере:  bash ~/desire/shop/db/migrate-from-cloud.sh
# Можно запускать повторно: данные в новой базе каждый раз заменяются свежими из облака.
set -euo pipefail

OLD_REF="txuiyqfvybqznypaisay"
OLD_PREFIX="https://${OLD_REF}.supabase.co/storage/v1/object/public/photos/"
NEW_URL="https://api.desire-store.ru"
NEW_PREFIX="${NEW_URL}/storage/v1/object/public/photos/"
SB_DIR="$HOME/supabase"
SQL_DIR="$(cd "$(dirname "$0")" && pwd)"

get_env() { grep -E "^$1=" "$SB_DIR/.env" | head -1 | cut -d= -f2-; }
PGPW_NEW="$(get_env POSTGRES_PASSWORD)"
SERVICE_KEY="$(get_env SERVICE_ROLE_KEY)"
newdb() { docker exec -i -e PGPASSWORD="$PGPW_NEW" supabase-db psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

docker ps --format '{{.Names}}' | grep -qx supabase-db || { echo "Ошибка: база supabase-db не запущена (cd ~/supabase && sh run.sh start)"; exit 1; }

echo "1/5  Создаём таблицы и функции магазина…"
newdb < "$SQL_DIR/supabase-setup.sql" 2>&1 | grep -v -E "NOTICE|already exists|does not exist, skipping" || true

echo
echo "2/5  Подключение к старой базе (облако Supabase)."
echo "     Вставьте строку Session pooler из Supabase → Connect (вместе с [YOUR-PASSWORD], как есть):"
read -r OLD_URI
OLD_URI="$(printf %s "$OLD_URI" | tr -d '[:space:]' | sed -E 's#:\[[^]]*\]@#@#')"   # убираем заглушку [YOUR-...PASSWORD]
read -r -s -p "     Пароль базы данных облачного Supabase (символы не видны при вводе): " OLD_PW; echo
docker exec -e PGPASSWORD="$OLD_PW" supabase-db psql "$OLD_URI" -Atqc "select 'Подключились, заказов в облаке: ' || count(*) from public.orders" \
  || { echo "Не удалось подключиться. Проверьте строку и пароль."; exit 1; }

echo "3/5  Копируем данные…"
DUMP=$(mktemp)
docker exec -e PGPASSWORD="$OLD_PW" supabase-db pg_dump "$OLD_URI" --data-only --schema=public --no-owner --no-privileges > "$DUMP"
{ echo "begin;"
  echo "truncate public.products, public.promos, public.campaigns, public.settings, public.orders, public.reviews, public.events, public.wishes;"
  grep -v -E "^SET transaction_timeout" "$DUMP"
  echo "commit;"; } | newdb
rm -f "$DUMP"

echo "4/5  Переносим фото товаров…"
TMP=$(mktemp -d); n=0; fail=0
while IFS= read -r path; do
  [ -z "$path" ] && continue
  if curl -fsS "${OLD_PREFIX}${path}" -o "$TMP/f" && \
     curl -fsS -X POST "${NEW_URL}/storage/v1/object/photos/${path}" -H "Authorization: Bearer ${SERVICE_KEY}" -H "apikey: ${SERVICE_KEY}" \
          -H "Content-Type: image/jpeg" -H "x-upsert: true" --data-binary "@$TMP/f" -o /dev/null; then n=$((n+1)); else fail=$((fail+1)); echo "     не получилось: $path"; fi
done < <(newdb -At -c "select distinct m[1] from public.products, regexp_matches(data::text, '$(printf %s "$OLD_PREFIX" | sed 's/[.]/\\./g')([^\"\\\\:]+)', 'g') m")
rm -rf "$TMP"
newdb -c "update public.products set data = replace(data::text, '${OLD_PREFIX}', '${NEW_PREFIX}')::jsonb where data::text like '%${OLD_REF}%'"
echo "     фото перенесено: $n, ошибок: $fail"

echo "5/5  Проверка — сколько записей в новой базе:"
newdb -c "select 'товары' as что, count(*) from products union all select 'заказы', count(*) from orders union all select 'отзывы', count(*) from reviews union all select 'промокоды', count(*) from promos union all select 'события статистики', count(*) from events union all select 'ждут поступления', count(*) from wishes union all select 'ссылок на старое облако', count(*) from products where data::text like '%${OLD_REF}%'"
echo "Готово."
