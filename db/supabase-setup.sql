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
