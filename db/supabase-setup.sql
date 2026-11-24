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

-- Оформление заказа: проверяет и списывает остатки, создаёт заказ. Покупатель не видит чужие заказы.
create or replace function public.place_order(p_order jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  it jsonb; cur int; k text; q int; new_id text; tok uuid;
begin
  if jsonb_array_length(coalesce(p_order->'items', '[]'::jsonb)) = 0 then
    raise exception 'EMPTY_ORDER';
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
  insert into orders (id, data, status)
    values (new_id, p_order || jsonb_build_object('id', new_id, 'status', 'awaiting'), 'awaiting')
    returning token into tok;
  return jsonb_build_object('id', new_id, 'token', tok);
end $$;

-- Покупатель нажал «Я оплатил»
create or replace function public.claim_paid(p_token uuid)
returns void language sql security definer set search_path = public as $$
  update orders set paid_claimed = true where token = p_token;
$$;

-- Покупатель видит только свои заказы (по секретным токенам из своего браузера)
create or replace function public.my_orders(p_tokens uuid[])
returns table (id text, data jsonb, status text, paid_claimed boolean, created_at timestamptz)
language sql security definer set search_path = public as $$
  select o.id, o.data, o.status, o.paid_claimed, o.created_at from orders o
  where o.token = any(p_tokens) order by o.created_at desc limit 50;
$$;

revoke all on function public.place_order(jsonb), public.claim_paid(uuid), public.my_orders(uuid[]) from public;
grant execute on function public.place_order(jsonb), public.claim_paid(uuid), public.my_orders(uuid[]) to anon, authenticated;

-- Хранилище фото товаров: смотреть может любой, загружать — только сотрудники
insert into storage.buckets (id, name, public) values ('photos', 'photos', true) on conflict (id) do nothing;
drop policy if exists "staff upload photos" on storage.objects;
create policy "staff upload photos" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
drop policy if exists "staff delete photos" on storage.objects;
create policy "staff delete photos" on storage.objects for delete to authenticated using (bucket_id = 'photos');
