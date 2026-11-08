"""Локальный Postgres с заглушками того, что есть в Supabase (auth.users, auth.uid(), роли anon/authenticated),
и настоящей схемой supabase/schema.sql. Используется тестами и локальным макетом сервера."""
import pathlib

import pgserver
import psycopg

SCHEMA = pathlib.Path(__file__).resolve().parent.parent / "supabase" / "schema.sql"

STUBS = """
create schema if not exists extensions;
create schema if not exists auth;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth, extensions, public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated;
-- в локальном Postgres нет pgcrypto: те же сигнатуры на встроенных функциях (только для теста)
create or replace function extensions.digest(t text, alg text) returns bytea language sql immutable as
  $$ select sha256(convert_to(t, 'UTF8')) $$;
create or replace function extensions.gen_random_bytes(n int) returns bytea language sql volatile as
  $$ select substring(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')) from 1 for n) $$;
"""


def start(datadir):
    """Запускает сервер, накатывает заглушки и схему. Возвращает (server, conn)."""
    srv = pgserver.get_server(datadir, cleanup_mode="stop")
    conn = psycopg.connect(srv.get_uri(), autocommit=True)
    conn.execute(STUBS)
    conn.execute(SCHEMA.read_text().replace("create extension if not exists pgcrypto with schema extensions;", ""))
    return srv, conn


def as_role(cur, role, sub=None):
    cur.execute("reset role")
    cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (sub or "",))
    cur.execute(f"set role {role}")
