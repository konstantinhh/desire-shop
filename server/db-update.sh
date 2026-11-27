#!/bin/bash
# Обновить базу магазина: таблицы и функции (supabase-setup.sql) + разовые патчи данных (db/patch-*.sql).
# Запуск на сервере: cd ~/desire/shop && git pull -q && bash server/db-update.sh
set -euo pipefail
D="$HOME/desire/shop/db"
PGPW="$(grep -E '^POSTGRES_PASSWORD=' "$HOME/supabase/.env" | cut -d= -f2-)"
psqlx() { docker exec -i -e PGPASSWORD="$PGPW" supabase-db psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
echo "Таблицы и функции…"
psqlx -q < "$D/supabase-setup.sql" 2>&1 | grep -v -E "NOTICE|already exists|does not exist, skipping" || true
for f in "$D"/patch-*.sql; do [ -e "$f" ] || continue; echo "Патч $(basename "$f")…"; psqlx -q < "$f"; done
echo "Готово."
