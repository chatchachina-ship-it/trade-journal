-- Дневник сделок: схема базы Supabase.
-- Выполнить целиком один раз: Supabase → SQL Editor → New query → вставить → Run.
--
-- Модель безопасности:
--  * Сервер хранит только зашифрованные записи (ct). Ключ шифрования есть только на устройствах пользователя.
--  * Каждый пользователь видит и меняет только свои строки (Row Level Security).
--  * Аккаунты создаются только по приглашению владельца; email должен быть в allowed_emails (второй рубеж).
--  * Робот MT5 работает по токену и может только ОТПРАВЛЯТЬ записи через функцию ingest — читать он ничего не может.
--    Id записей непрозрачные (HMAC), поэтому по одному токену нельзя попасть в чужие записи;
--    служебная запись проверки ключа роботу недоступна.
--  * Лимиты объёма и частоты не дают одному пользователю или утёкшему токену забить базу.

create extension if not exists pgcrypto with schema extensions;

-- Всё новое в public по умолчанию недоступно клиентам — права выдаём только явно.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
-- Право PUBLIC на функции встроено глобально: отзываем и его (для объектов, создаваемых этой ролью).
alter default privileges revoke execute on functions from public;

-- ---------------------------------------------------------------- приглашения

create table if not exists public.allowed_emails (
  email text primary key check (email = lower(email))
);
-- RLS включён и политик нет: клиентам таблица недоступна совсем. Заполняет только владелец в SQL Editor.
alter table public.allowed_emails enable row level security;
revoke all on public.allowed_emails from anon, authenticated;

create or replace function public.check_allowed_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null
     or not exists (select 1 from public.allowed_emails a where a.email = lower(new.email)) then
    raise exception 'Регистрация только по приглашению';
  end if;
  return new;
end;
$$;
revoke all on function public.check_allowed_email() from public, anon, authenticated;

drop trigger if exists only_invited on auth.users;
create trigger only_invited
  before insert on auth.users
  for each row execute function public.check_allowed_email();

-- ---------------------------------------------------------------- записи (только шифр)

create table if not exists public.records (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  rid        text not null check (rid ~ '^[0-9a-f]{32}$'),
  ct         text not null check (length(ct) between 64 and 16384 and ct ~ '^[A-Za-z0-9+/]+={0,2}$'),
  updated_at timestamptz not null default now(),
  src        text not null default 'user' check (src in ('user', 'robot')),   -- кто записал: приложение или робот
  primary key (user_id, rid)
);
alter table public.records add column if not exists src text not null default 'user' check (src in ('user', 'robot'));
alter table public.records enable row level security;

drop policy if exists records_select on public.records;
drop policy if exists records_insert on public.records;
drop policy if exists records_update on public.records;
drop policy if exists records_delete on public.records;
create policy records_select on public.records for select to authenticated
  using (user_id = (select auth.uid()));
create policy records_insert on public.records for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy records_update on public.records for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy records_delete on public.records for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.records from anon, authenticated;
-- Колонку src клиент менять не может: она всегда 'user' для записей из приложения.
grant select, delete on public.records to authenticated;
grant insert (user_id, rid, ct), update (user_id, rid, ct) on public.records to authenticated;

-- Время изменения ставит сервер.
create or replace function public.records_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.records_touch() from public, anon, authenticated;

drop trigger if exists records_guard on public.records;
drop function if exists public.records_guard();
drop trigger if exists records_touch on public.records;
create trigger records_touch
  before insert or update on public.records
  for each row execute function public.records_touch();

-- ---------------------------------------------------------------- лимиты на пользователя

-- Учёт объёма: строк и символов шифра. Клиентам таблица недоступна.
create table if not exists public.usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  rows    integer not null default 0,
  bytes   bigint  not null default 0
);
alter table public.usage enable row level security;
revoke all on public.usage from anon, authenticated;

-- Считается в AFTER-триггерах: при upsert срабатывает либо вставка, либо обновление — двойного счёта нет.
-- Блокировка строки usage делает проверку атомарной при параллельных запросах.
create or replace function public.records_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid;
  v_rows  integer;
  v_bytes bigint;
  d_rows  integer := 0;
  d_bytes bigint  := 0;
begin
  if tg_op = 'DELETE' then
    -- только уменьшаем: при удалении аккаунта строка usage удаляется каскадом вместе с записями
    update public.usage set rows = rows - 1, bytes = bytes - length(old.ct) where user_id = old.user_id;
    return null;
  end if;

  if tg_op = 'INSERT' then
    v_user := new.user_id; d_rows := 1; d_bytes := length(new.ct);
  else
    v_user := new.user_id; d_bytes := length(new.ct) - length(old.ct);
  end if;

  insert into public.usage as u (user_id, rows, bytes) values (v_user, d_rows, d_bytes)
  on conflict (user_id) do update set rows = u.rows + d_rows, bytes = u.bytes + d_bytes
  returning u.rows, u.bytes into v_rows, v_bytes;

  if v_rows > 10000 or v_bytes > 20000000 then
    raise exception 'Превышен лимит: не больше 10 000 записей и 20 МБ на пользователя';
  end if;
  return null;
end;
$$;
revoke all on function public.records_usage() from public, anon, authenticated;

drop trigger if exists records_usage on public.records;
create trigger records_usage
  after insert or update or delete on public.records
  for each row execute function public.records_usage();

-- Пересчёт для записей, которые уже были в базе до этой версии схемы.
insert into public.usage (user_id, rows, bytes)
select user_id, count(*), sum(length(ct)) from public.records group by user_id
on conflict (user_id) do update set rows = excluded.rows, bytes = excluded.bytes;

-- ---------------------------------------------------------------- токены робота MT5

create table if not exists public.sync_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  token_hash   bytea not null unique,          -- хранится только SHA-256, сам токен не хранится
  label        text not null default '' check (length(label) <= 60),
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  window_start timestamptz not null default now(),
  calls        integer not null default 0
);
alter table public.sync_tokens add column if not exists window_start timestamptz not null default now();
alter table public.sync_tokens add column if not exists calls integer not null default 0;
alter table public.sync_tokens enable row level security;

drop policy if exists tokens_select on public.sync_tokens;
drop policy if exists tokens_delete on public.sync_tokens;
create policy tokens_select on public.sync_tokens for select to authenticated
  using (user_id = (select auth.uid()));
create policy tokens_delete on public.sync_tokens for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.sync_tokens from anon, authenticated;
-- Хэш токена клиенту не отдаём: только безопасные колонки.
grant select (id, label, created_at, last_used_at), delete on public.sync_tokens to authenticated;

-- Создать токен (видно один раз). Не больше 5 токенов.
create or replace function public.create_sync_token(p_label text default '')
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_token text;
begin
  if v_user is null then
    raise exception 'Нужен вход';
  end if;
  if (select count(*) from public.sync_tokens t where t.user_id = v_user) >= 5 then
    raise exception 'Не больше 5 токенов: отзови старый';
  end if;
  v_token := 'tjs_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.sync_tokens (user_id, token_hash, label)
  values (v_user, extensions.digest(v_token, 'sha256'), left(coalesce(p_label, ''), 60));
  return v_token;
end;
$$;

-- Приём записей от робота: только запись в аккаунт владельца токена, ничего не возвращает, кроме числа.
create or replace function public.ingest(p_token text, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_user  uuid;
  v_calls integer;
  v_n     integer;
begin
  if p_token is null or p_token !~ '^tjs_[0-9a-f]{64}$' then
    raise exception 'Неверный токен';
  end if;

  -- Счётчик вызовов в минутном окне: не больше 30 запросов в минуту на токен.
  update public.sync_tokens t
     set calls        = case when t.window_start > now() - interval '1 minute' then t.calls + 1 else 1 end,
         window_start = case when t.window_start > now() - interval '1 minute' then t.window_start else now() end,
         last_used_at = now()
   where t.token_hash = extensions.digest(p_token, 'sha256')
  returning t.id, t.user_id, t.calls into v_id, v_user, v_calls;

  if v_user is null then
    raise exception 'Неверный токен';
  end if;
  if v_calls > 30 then
    raise exception 'Слишком часто: не больше 30 отправок в минуту';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 200 then
    raise exception 'Неверный пакет';
  end if;
  -- Робот шлёт только короткие записи позиций и не может трогать запись проверки ключа.
  if exists (select 1 from jsonb_array_elements(p_items) x
             where x->>'rid' = repeat('0', 32) or length(x->>'ct') > 4096) then
    raise exception 'Неверный пакет';
  end if;

  -- Робот обновляет только свои записи: ручные сделки и заметки он перезаписать не может, даже зная их id.
  insert into public.records (user_id, rid, ct, src)
  select v_user, x->>'rid', x->>'ct', 'robot'
  from jsonb_array_elements(p_items) as x
  on conflict (user_id, rid) do update set ct = excluded.ct where public.records.src = 'robot';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Права на функции: закрываем всё и открываем точечно.
revoke all on function public.create_sync_token(text) from public, anon, authenticated;
revoke all on function public.ingest(text, jsonb) from public, anon, authenticated;
grant execute on function public.create_sync_token(text) to authenticated;
grant execute on function public.ingest(text, jsonb) to anon;

-- ---------------------------------------------------------------- ИИ-аналитик: лимит запросов в день

-- Сколько анализов сделал пользователь за сутки (UTC). Ни тикеров, ни прогнозов здесь нет — только счётчик.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default (now() at time zone 'utc')::date,
  calls   integer not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;

-- Списать один анализ из дневного лимита. Вызывает функция analyst от имени пользователя.
create or replace function public.ai_consume()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_calls integer;
begin
  if v_user is null then
    raise exception 'Нужен вход';
  end if;
  insert into public.ai_usage as u (user_id, day, calls) values (v_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set calls = u.calls + 1
  returning u.calls into v_calls;
  if v_calls > 10 then
    raise exception 'Лимит: 10 анализов в сутки';
  end if;
  return 10 - v_calls;   -- сколько осталось
end;
$$;

-- Вернуть списанный анализ, если он не удался по вине сервера.
create or replace function public.ai_refund(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.ai_usage set calls = greatest(calls - 1, 0)
   where user_id = p_user and day = (now() at time zone 'utc')::date;
end;
$$;

-- Остаток на сегодня (для экрана).
create or replace function public.ai_left()
returns integer
language sql
security definer
set search_path = ''
stable
as $$
  select 10 - coalesce((select calls from public.ai_usage
                         where user_id = auth.uid() and day = (now() at time zone 'utc')::date), 0);
$$;

revoke all on function public.ai_consume() from public, anon, authenticated;
revoke all on function public.ai_refund(uuid) from public, anon, authenticated;
revoke all on function public.ai_left() from public, anon, authenticated;
grant execute on function public.ai_consume() to authenticated;
grant execute on function public.ai_left() to authenticated;
-- ai_refund вызывает только функция analyst ключом service_role: сам пользователь вернуть себе лимит не может.
grant execute on function public.ai_refund(uuid) to service_role;
