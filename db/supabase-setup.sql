-- DESIRE: база для тестового магазина.
-- Вставьте весь файл в Supabase → SQL Editor → New query → Run. Повторный запуск безопасен.

-- Таблицы: товары, промокоды, акции, настройки, заказы
create table if not exists public.products  (id text primary key, data jsonb not null, updated_at timestamptz default now());
create table if not exists public.promos    (id text primary key, data jsonb not null);
create table if not exists public.campaigns (id text primary key, data jsonb not null);
create table if not exists public.settings  (id int primary key default 1, data jsonb not null);
create sequence if not exists public.order_no start 1001;
create table if not exists public.orders (
  id text primary key,
  token uuid not null default gen_random_uuid() unique,
  data jsonb not null,
  status text not null default 'awaiting',
  paid_claimed boolean not null default false,
  created_at timestamptz not null default now()
);

-- Доступ: покупатели только читают витрину; сотрудники (вошедшие по email) меняют всё
alter table public.products  enable row level security;
alter table public.promos    enable row level security;
alter table public.campaigns enable row level security;
alter table public.settings  enable row level security;
alter table public.orders    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['products','promos','campaigns','settings'] loop
    execute format('drop policy if exists "read all" on public.%I', t);
    execute format('create policy "read all" on public.%I for select to anon, authenticated using (true)', t);
    execute format('drop policy if exists "staff write" on public.%I', t);
    execute format('create policy "staff write" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
drop policy if exists "staff orders" on public.orders;
create policy "staff orders" on public.orders for all to authenticated using (true) with check (true);

grant usage on schema public to anon, authenticated;
grant select on public.products, public.promos, public.campaigns, public.settings to anon, authenticated;
grant all on public.products, public.promos, public.campaigns, public.settings, public.orders to authenticated;
grant usage on sequence public.order_no to authenticated;

-- Бонусы: сколько начислено и сколько списано по каждому заказу
alter table public.orders add column if not exists bonus_spent int not null default 0;
alter table public.orders add column if not exists bonus_earned int not null default 0;
alter table public.orders add column if not exists bonus_src uuid[] not null default '{}';  -- с каких заказов списаны бонусы

-- Баланс бонусов покупателя: по секретным токенам его заказов
create or replace function public.my_bonus(p_tokens uuid[])
returns int language sql security definer set search_path = public as $$
  select ((select coalesce(sum(bonus_earned), 0) from orders where token = any(p_tokens) and status = 'done')
        - (select coalesce(sum(bonus_spent), 0) from orders where bonus_src && p_tokens and status <> 'cancelled'))::int;
$$;

-- Начисление бонусов, когда сотрудник ставит статус «Получен»
create or replace function public.orders_bonus() returns trigger language plpgsql set search_path = public as $$
declare st jsonb; pct numeric; ok boolean;
begin
  if new.status = 'done' and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    select data->'bonus' into st from settings where id = 1;
    ok := coalesce((st->>'on')::boolean, true); pct := coalesce((st->>'earnPct')::numeric, 5);
    new.bonus_earned := case when ok then floor(greatest(0, coalesce((new.data->>'subtotal')::numeric, 0) - coalesce((new.data->>'discount')::numeric, 0) - new.bonus_spent) * pct / 100) else 0 end;
  elsif new.status <> 'done' then
    new.bonus_earned := 0;
  end if;
  return new;
end $$;
drop trigger if exists orders_bonus on public.orders;
create trigger orders_bonus before update of status on public.orders for each row execute function public.orders_bonus();

-- Оформление заказа: проверяет остатки и бонусы, списывает остатки, создаёт заказ. Покупатель не видит чужие заказы.
drop function if exists public.place_order(jsonb);
create or replace function public.place_order(p_order jsonb, p_tokens uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it jsonb; cur int; k text; q int; new_id text; tok uuid; v_spend int; v_pct numeric;
begin
  if jsonb_array_length(coalesce(p_order->'items', '[]'::jsonb)) = 0 then
    raise exception 'EMPTY_ORDER';
  end if;
  v_spend := greatest(0, coalesce((p_order->>'bonusSpent')::int, 0));
  if v_spend > 0 then
    perform pg_advisory_xact_lock(hashtext('desire_bonus'));  -- два заказа с бонусами не пройдут одновременно
    select coalesce((data->'bonus'->>'maxSpendPct')::numeric, 30) into v_pct from settings where id = 1;
    if v_spend > public.my_bonus(p_tokens)
       or v_spend > floor(coalesce((p_order->>'subtotal')::numeric, 0) * coalesce(v_pct, 30) / 100) then
      raise exception 'BONUS';
    end if;
  end if;
  for it in select * from jsonb_array_elements(p_order->'items') loop
    k := (it->>'color') || '|' || (it->>'size');
    q := (it->>'qty')::int;
    cur := null;
    select coalesce((data->'stock'->>k)::int, 0) into cur from products where id = it->>'pid' for update;
    if cur is null or q < 1 or cur < q then
      raise exception 'OUT_OF_STOCK:%', it->>'name';
    end if;
    update products set data = jsonb_set(data, array['stock', k], to_jsonb(cur - q)), updated_at = now()
      where id = it->>'pid';
  end loop;
  new_id := 'D-' || nextval('order_no');
  insert into orders (id, data, status, bonus_spent, bonus_src)
    values (new_id, p_order || jsonb_build_object('id', new_id, 'status', 'awaiting'), 'awaiting', v_spend,
            case when v_spend > 0 then p_tokens else '{}'::uuid[] end)
    returning token into tok;
  return jsonb_build_object('id', new_id, 'token', tok);
end $$;

-- Покупатель нажал «Я оплатил»
create or replace function public.claim_paid(p_token uuid)
returns void language sql security definer set search_path = public as $$
  update orders set paid_claimed = true where token = p_token;
$$;

-- Покупатель видит только свои заказы (по секретным токенам из своего браузера)
drop function if exists public.my_orders(uuid[]);
create or replace function public.my_orders(p_tokens uuid[])
returns table (id text, data jsonb, status text, paid_claimed boolean, created_at timestamptz, bonus_spent int, bonus_earned int)
language sql security definer set search_path = public as $$
  select o.id, o.data, o.status, o.paid_claimed, o.created_at, o.bonus_spent, o.bonus_earned from orders o
  where o.token = any(p_tokens) order by o.created_at desc limit 50;
$$;

-- Отзывы: покупатель оставляет отзыв только на полученный заказ; на сайте видны после проверки
create table if not exists public.reviews (
  id text primary key default gen_random_uuid()::text,
  pid text not null,
  order_id text,
  data jsonb not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  unique (order_id, pid)
);
alter table public.reviews enable row level security;
drop policy if exists "read published" on public.reviews;
create policy "read published" on public.reviews for select to anon using (status = 'published');
drop policy if exists "staff reviews" on public.reviews;
create policy "staff reviews" on public.reviews for all to authenticated using (true) with check (true);
grant select on public.reviews to anon;
grant all on public.reviews to authenticated;

create or replace function public.add_review(p_token uuid, p_pid text, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare o record; v_photos jsonb;
begin
  select * into o from orders where token = p_token;
  if not found or o.status <> 'done' then raise exception 'NOT_ALLOWED'; end if;
  if not exists (select 1 from jsonb_array_elements(o.data->'items') it where it->>'pid' = p_pid) then raise exception 'NOT_ALLOWED'; end if;
  if length(p_data::text) > 900000 then raise exception 'TOO_BIG'; end if;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_photos from (
    select x from jsonb_array_elements(coalesce(p_data->'photos', '[]'::jsonb)) x
    where jsonb_typeof(x) = 'string' and (x #>> '{}') like 'data:image/jpeg;base64,%' limit 3) s;
  insert into reviews (pid, order_id, data) values (p_pid, o.id, jsonb_build_object(
    'name', left(coalesce(nullif(trim(p_data->>'name'), ''), 'Покупатель'), 40),
    'rating', greatest(1, least(5, coalesce((p_data->>'rating')::int, 5))),
    'text', left(coalesce(p_data->>'text', ''), 2000),
    'color', left(coalesce(p_data->>'color', ''), 60),
    'size', left(coalesce(p_data->>'size', ''), 30),
    'photos', v_photos,
    'date', floor(extract(epoch from now()) * 1000)))
  on conflict (order_id, pid) do nothing;
  if not found then raise exception 'DUPLICATE'; end if;
end $$;

revoke all on function public.place_order(jsonb, uuid[]), public.claim_paid(uuid), public.my_orders(uuid[]), public.my_bonus(uuid[]), public.add_review(uuid, text, jsonb) from public;
grant execute on function public.place_order(jsonb, uuid[]), public.claim_paid(uuid), public.my_orders(uuid[]), public.my_bonus(uuid[]), public.add_review(uuid, text, jsonb) to anon, authenticated;

-- Хранилище фото товаров: смотреть может любой, загружать — только сотрудники
insert into storage.buckets (id, name, public) values ('photos', 'photos', true) on conflict (id) do nothing;
drop policy if exists "staff upload photos" on storage.objects;
create policy "staff upload photos" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
drop policy if exists "staff delete photos" on storage.objects;
create policy "staff delete photos" on storage.objects for delete to authenticated using (bucket_id = 'photos');

-- ===== v1.8: статистика (анонимные события) и «Сообщить о поступлении» =====
create table if not exists public.events (
  id bigserial primary key,
  ts timestamptz not null default now(),
  sid text not null, type text not null,
  src text, pid text, color text, size text, q text, val numeric, meta jsonb
);
create index if not exists events_ts on public.events (ts);
alter table public.events enable row level security;
drop policy if exists "staff events" on public.events;
create policy "staff events" on public.events for select to authenticated using (true);
drop policy if exists "staff events delete" on public.events;
create policy "staff events delete" on public.events for delete to authenticated using (true);

-- Покупатели только добавляют события через эту функцию: ≤50 за раз, только известные типы, длины обрезаются
create or replace function public.track(p_events jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 50 then raise exception 'BAD'; end if;
  insert into events (ts, sid, type, src, pid, color, size, q, val, meta)
  select case when jsonb_typeof(e->'ts') = 'number' then to_timestamp(least(greatest((e->>'ts')::double precision / 1000, extract(epoch from now()) - 86400), extract(epoch from now()))) else now() end,
         left(e->>'sid', 40), e->>'type', left(e->>'src', 40), left(e->>'pid', 40), left(e->>'color', 60), left(e->>'size', 30),
         left(lower(e->>'q'), 80), case when jsonb_typeof(e->'val') = 'number' then (e->>'val')::numeric end,
         case when jsonb_typeof(e->'meta') = 'object' and length((e->'meta')::text) < 600 then e->'meta' end
  from jsonb_array_elements(p_events) e
  where jsonb_typeof(e) = 'object' and coalesce(e->>'sid', '') <> ''
    and e->>'type' in ('visit','catalog','product','select','oos','cart_add','cart_view','checkout','contacts','delivery','pay','paid','fav','search','install','wish_open','wish','notify','pay_bank','params');
end $$;

create table if not exists public.wishes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  sid text, pid text not null, color text, size text, contact text not null,
  status text not null default 'new'
);
alter table public.wishes enable row level security;
drop policy if exists "staff wishes" on public.wishes;
create policy "staff wishes" on public.wishes for all to authenticated using (true) with check (true);

create or replace function public.add_wish(p_sid text, p_pid text, p_color text, p_size text, p_contact text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if length(regexp_replace(coalesce(p_contact, ''), '[^0-9A-Za-z]', '', 'g')) < 4 then raise exception 'BAD_CONTACT'; end if;
  if not exists (select 1 from products where id = p_pid) then raise exception 'NO_PRODUCT'; end if;
  if (select count(*) from wishes where created_at > now() - interval '1 hour' and sid = p_sid) >= 10 then raise exception 'TOO_MANY'; end if;
  -- одна подписка на вариант с одного контакта
  if exists (select 1 from wishes where pid = p_pid and color is not distinct from p_color and size is not distinct from p_size
             and contact = left(trim(p_contact), 60) and status = 'new') then return; end if;
  insert into wishes (sid, pid, color, size, contact) values (left(p_sid, 40), p_pid, left(p_color, 60), left(p_size, 30), left(trim(p_contact), 60));
end $$;

revoke all on public.events, public.wishes from anon;
grant select, delete on public.events to authenticated;
grant all on public.wishes to authenticated;

revoke all on function public.track(jsonb), public.add_wish(text, text, text, text, text) from public;
grant execute on function public.track(jsonb), public.add_wish(text, text, text, text, text) to anon, authenticated;

-- ===== v2.0: уведомления (push и Telegram), брошенные корзины, рассылки =====
-- dev — постоянный анонимный номер устройства покупателя (хранится в его браузере)
create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  dev text not null,
  kind text not null check (kind in ('push', 'tg')),
  push jsonb,                    -- подписка браузера (endpoint и ключи)
  tg_chat bigint,                -- чат в Telegram
  news boolean not null default true,     -- согласие на новинки и акции
  tokens uuid[] not null default '{}',    -- секретные токены заказов этого покупателя
  fails int not null default 0,
  created_at timestamptz not null default now(),
  unique (dev, kind)
);
create table if not exists public.tg_links (
  code text primary key, dev text, tokens uuid[] not null default '{}', news boolean not null default true,
  staff boolean not null default false, created_at timestamptz not null default now()
);
create table if not exists public.staff_chats (chat_id bigint primary key, name text, created_at timestamptz not null default now());
create table if not exists public.carts (
  dev text primary key, items jsonb not null, tz text, updated_at timestamptz not null default now(),
  r1 timestamptz, r2 timestamptz        -- когда отправлены 1-е и 2-е напоминания
);
create table if not exists public.broadcasts (
  id bigserial primary key, created_at timestamptz not null default now(),
  title text not null, body text not null, url text, status text not null default 'new', sent int not null default 0, failed int not null default 0
);
create table if not exists public.notif_log (
  id bigserial primary key, ts timestamptz not null default now(), kind text not null, channel text, ok boolean not null, info text
);
create index if not exists notif_log_ts on public.notif_log (ts);
create table if not exists public.notifier_info (id int primary key default 1, vapid text, bot text, seen_at timestamptz);
alter table public.wishes add column if not exists dev text;

alter table public.subscribers enable row level security;
alter table public.tg_links enable row level security;
alter table public.staff_chats enable row level security;
alter table public.carts enable row level security;
alter table public.broadcasts enable row level security;
alter table public.notif_log enable row level security;
alter table public.notifier_info enable row level security;
do $$
declare t text;
begin
  foreach t in array array['subscribers','staff_chats','carts','broadcasts','notif_log'] loop
    execute format('drop policy if exists "staff" on public.%I', t);
    execute format('create policy "staff" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
drop policy if exists "read all" on public.notifier_info;
create policy "read all" on public.notifier_info for select to anon, authenticated using (true);
revoke all on public.subscribers, public.tg_links, public.staff_chats, public.carts, public.broadcasts, public.notif_log from anon;
grant select, delete on public.subscribers, public.staff_chats, public.carts, public.notif_log to authenticated;
grant select, insert, delete on public.broadcasts to authenticated;
grant usage on sequence public.broadcasts_id_seq to authenticated;
grant select on public.notifier_info to anon, authenticated;

-- Подписка браузера на push
create or replace function public.subscribe_push(p_dev text, p_sub jsonb, p_tokens uuid[] default '{}', p_news boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if length(coalesce(p_dev, '')) not between 8 and 40 or coalesce(p_sub->>'endpoint', '') !~ '^https://' or length(p_sub::text) > 2000 then raise exception 'BAD'; end if;
  insert into subscribers (dev, kind, push, news, tokens) values (p_dev, 'push', p_sub, p_news, coalesce(p_tokens[1:50], '{}'))
  on conflict (dev, kind) do update set push = excluded.push, news = excluded.news, fails = 0,
    tokens = (select coalesce(array_agg(distinct t), '{}') from unnest(subscribers.tokens || excluded.tokens) t);
end $$;

-- Код для привязки Telegram: покупатель открывает t.me/бот?start=код
create or replace function public.tg_link(p_dev text, p_tokens uuid[] default '{}', p_news boolean default true) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if length(coalesce(p_dev, '')) not between 8 and 40 then raise exception 'BAD'; end if;
  if (select count(*) from tg_links where dev = p_dev and created_at > now() - interval '1 hour') >= 10 then raise exception 'TOO_MANY'; end if;
  delete from tg_links where created_at < now() - interval '1 day';
  c := replace(gen_random_uuid()::text, '-', '');
  insert into tg_links (code, dev, tokens, news) values (c, p_dev, coalesce(p_tokens[1:50], '{}'), p_news);
  return c;
end $$;

-- Код для сотрудника (только после входа в панель)
create or replace function public.staff_tg_code() returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if auth.role() <> 'authenticated' then raise exception 'FORBIDDEN'; end if;
  c := 'staff' || replace(gen_random_uuid()::text, '-', '');
  insert into tg_links (code, staff) values (c, true);
  return c;
end $$;

create or replace function public.notif_status(p_dev text) returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'push', exists (select 1 from subscribers where dev = p_dev and kind = 'push'),
    'tg', exists (select 1 from subscribers where dev = p_dev and kind = 'tg'),
    'news', coalesce((select bool_or(news) from subscribers where dev = p_dev), true));
$$;

create or replace function public.notif_update(p_dev text, p_news boolean, p_tokens uuid[] default '{}') returns void
language sql security definer set search_path = public as $$
  update subscribers set news = coalesce(p_news, news),
    tokens = (select coalesce(array_agg(distinct t), '{}') from unnest(tokens || coalesce(p_tokens[1:50], '{}')) t)
  where dev = p_dev;
$$;

create or replace function public.notif_off(p_dev text, p_kind text) returns void
language sql security definer set search_path = public as $$
  delete from subscribers where dev = p_dev and kind = p_kind;
$$;

-- Корзина устройства — нужна только для напоминаний о брошенной корзине
create or replace function public.save_cart(p_dev text, p_items jsonb, p_tz text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if length(coalesce(p_dev, '')) not between 8 and 40 then raise exception 'BAD'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then delete from carts where dev = p_dev; return; end if;
  if jsonb_array_length(p_items) > 30 or length(p_items::text) > 4000 then raise exception 'BAD'; end if;
  insert into carts (dev, items, tz) values (p_dev, p_items, left(p_tz, 40))
  on conflict (dev) do update set items = excluded.items, tz = excluded.tz, updated_at = now(), r1 = null, r2 = null
    where carts.items is distinct from excluded.items;
end $$;

revoke all on function public.subscribe_push(text, jsonb, uuid[], boolean), public.tg_link(text, uuid[], boolean), public.notif_status(text),
  public.notif_update(text, boolean, uuid[]), public.notif_off(text, text), public.save_cart(text, jsonb, text), public.staff_tg_code() from public;
grant execute on function public.subscribe_push(text, jsonb, uuid[], boolean), public.tg_link(text, uuid[], boolean), public.notif_status(text),
  public.notif_update(text, boolean, uuid[]), public.notif_off(text, text), public.save_cart(text, jsonb, text) to anon, authenticated;
grant execute on function public.staff_tg_code() to authenticated;

drop function if exists public.add_wish(text, text, text, text, text);
-- «Сообщить о поступлении» запоминает устройство, чтобы сервис мог написать автоматически
create or replace function public.add_wish(p_sid text, p_pid text, p_color text, p_size text, p_contact text, p_dev text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if length(regexp_replace(coalesce(p_contact, ''), '[^0-9A-Za-z]', '', 'g')) < 4 then raise exception 'BAD_CONTACT'; end if;
  if not exists (select 1 from products where id = p_pid) then raise exception 'NO_PRODUCT'; end if;
  if (select count(*) from wishes where created_at > now() - interval '1 hour' and sid = p_sid) >= 10 then raise exception 'TOO_MANY'; end if;
  if exists (select 1 from wishes where pid = p_pid and color is not distinct from p_color and size is not distinct from p_size
             and contact = left(trim(p_contact), 60) and status = 'new') then return; end if;
  insert into wishes (sid, pid, color, size, contact, dev) values (left(p_sid, 40), p_pid, left(p_color, 60), left(p_size, 30), left(trim(p_contact), 60), left(p_dev, 40));
end $$;
revoke all on function public.add_wish(text, text, text, text, text, text) from public;
grant execute on function public.add_wish(text, text, text, text, text, text) to anon, authenticated;

-- Сигналы для сервиса уведомлений
create or replace function public.notify_desire() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'orders' then
    if tg_op = 'INSERT' then perform pg_notify('desire', json_build_object('t', 'order_new', 'id', new.id)::text);
    else
      if new.status is distinct from old.status then perform pg_notify('desire', json_build_object('t', 'order_status', 'id', new.id, 'status', new.status)::text); end if;
      if new.paid_claimed and not old.paid_claimed then perform pg_notify('desire', json_build_object('t', 'order_paid', 'id', new.id)::text); end if;
    end if;
  elsif tg_table_name = 'products' then perform pg_notify('desire', json_build_object('t', 'product', 'id', new.id)::text);
  elsif tg_table_name = 'broadcasts' then perform pg_notify('desire', json_build_object('t', 'broadcast', 'id', new.id)::text);
  end if;
  return new;
end $$;
drop trigger if exists notify_desire on public.orders;
create trigger notify_desire after insert or update on public.orders for each row execute function public.notify_desire();
drop trigger if exists notify_desire on public.products;
create trigger notify_desire after insert or update on public.products for each row execute function public.notify_desire();
drop trigger if exists notify_desire on public.broadcasts;
create trigger notify_desire after insert on public.broadcasts for each row execute function public.notify_desire();
