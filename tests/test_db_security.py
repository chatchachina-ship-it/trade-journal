"""Проверка правил доступа schema.sql на локальном Postgres с заглушками Supabase.

Запуск: .testenv/bin/python tests/test_db_security.py
"""
import json
import tempfile
import uuid

import psycopg

from pgstub import as_role, start

A, B = str(uuid.uuid4()), str(uuid.uuid4())
CT = "A" * 64

results = []


def check(name, ok):
    results.append((name, ok))
    print(("ПРОЙДЕН " if ok else "ПРОВАЛ  ") + name)


def fails(conn, sql, params=()):
    try:
        with conn.transaction():
            conn.execute(sql, params)
        return False
    except psycopg.Error:
        return True


with tempfile.TemporaryDirectory() as d:
    srv, conn = start(d)
    with conn:
        cur = conn.cursor()

        # приглашения
        cur.execute("insert into public.allowed_emails values ('a@x.ru'), ('b@x.ru')")
        check("Регистрация без приглашения запрещена",
              fails(conn, "insert into auth.users values (%s, 'stranger@x.ru')", (str(uuid.uuid4()),)))
        cur.execute("insert into auth.users values (%s, 'A@x.ru'), (%s, 'b@x.ru')", (A, B))
        check("Приглашённые зарегистрировались", True)

        # A пишет свою запись
        as_role(cur, "authenticated", A)
        cur.execute("insert into public.records (rid, ct) values (%s, %s)", ("a" * 32, CT))
        cur.execute("select count(*) from public.records")
        check("A видит свою запись", cur.fetchone()[0] == 1)

        # B не видит и не может трогать записи A
        as_role(cur, "authenticated", B)
        cur.execute("select count(*) from public.records")
        check("B не видит записи A", cur.fetchone()[0] == 0)
        cur.execute("update public.records set ct = %s", ("B" * 64,))
        check("B не может изменить записи A", cur.rowcount == 0)
        cur.execute("delete from public.records")
        check("B не может удалить записи A", cur.rowcount == 0)
        check("B не может записать строку от имени A",
              fails(conn, "insert into public.records (user_id, rid, ct) values (%s, %s, %s)", (A, "b" * 32, CT)))
        check("B не может перехватить запись A через upsert",
              fails(conn, "insert into public.records (user_id, rid, ct) values (%s, %s, %s) "
                          "on conflict (user_id, rid) do update set ct = excluded.ct", (A, "a" * 32, CT)))
        check("B не видит список приглашений", fails(conn, "select * from public.allowed_emails"))

        # без входа
        as_role(cur, "anon")
        check("Без входа записи не читаются", fails(conn, "select * from public.records"))
        check("Без входа токен не создать", fails(conn, "select public.create_sync_token('x')"))
        check("Без входа токены не читаются", fails(conn, "select * from public.sync_tokens"))

        # токен робота
        as_role(cur, "authenticated", A)
        cur.execute("select public.create_sync_token('Mac')")
        token = cur.fetchone()[0]
        check("Токен создан и имеет формат tjs_", token.startswith("tjs_") and len(token) == 68)
        check("Хэш токена не отдаётся клиенту", fails(conn, "select token_hash from public.sync_tokens"))
        cur.execute("select count(*) from public.sync_tokens")
        check("A видит свой токен", cur.fetchone()[0] == 1)
        as_role(cur, "authenticated", B)
        cur.execute("select count(*) from public.sync_tokens")
        check("B не видит токен A", cur.fetchone()[0] == 0)

        as_role(cur, "anon")
        items = json.dumps([{"rid": "c" * 32, "ct": CT}])
        cur.execute("select public.ingest(%s, %s::jsonb)", (token, items))
        check("Робот с токеном A добавил запись", cur.fetchone()[0] == 1)
        check("Чужой/выдуманный токен отклонён",
              fails(conn, "select public.ingest(%s, %s::jsonb)", ("tjs_" + "0" * 64, items)))
        check("Пакет мусора отклонён",
              fails(conn, "select public.ingest(%s, %s::jsonb)", (token, json.dumps([{"rid": "zz", "ct": "<script>"}]))))
        check("Робот не может читать записи", fails(conn, "select * from public.records"))

        as_role(cur, "authenticated", A)
        cur.execute("select count(*) from public.records")
        check("Запись робота попала только к A", cur.fetchone()[0] == 2)
        as_role(cur, "authenticated", B)
        cur.execute("select count(*) from public.records")
        check("У B по-прежнему ничего", cur.fetchone()[0] == 0)

        # отзыв токена
        as_role(cur, "authenticated", A)
        cur.execute("delete from public.sync_tokens")
        as_role(cur, "anon")
        check("Отозванный токен больше не работает", fails(conn, "select public.ingest(%s, %s::jsonb)", (token, items)))

        # ---- дополнительные атаки
        as_role(cur, "authenticated", A)
        check("A не может переписать свою строку на B (подбросить данные)",
              fails(conn, "update public.records set user_id = %s", (B,)))
        check("Пригласить себя самому нельзя", fails(conn, "insert into public.allowed_emails values ('evil@x.ru')"))
        check("Подложить свой токен напрямую в таблицу нельзя",
              fails(conn, "insert into public.sync_tokens (user_id, token_hash) values (%s, '\\x00')", (A,)))
        check("Подменить хэш токена нельзя", fails(conn, "update public.sync_tokens set token_hash = '\\x00'"))
        check("Служебную функцию проверки приглашений вызвать нельзя",
              fails(conn, "select public.check_allowed_email()"))
        check("Служебные функции учёта вызвать нельзя",
              fails(conn, "select public.records_usage()") and fails(conn, "select public.records_touch()"))
        check("Таблица лимитов недоступна", fails(conn, "select * from public.usage"))
        check("Вход в приложение не даёт вызвать ingest (только робот)",
              fails(conn, "select public.ingest(%s, %s::jsonb)", ("tjs_" + "0" * 64, items)))
        check("Неверный id записи отклоняется",
              fails(conn, "insert into public.records (rid, ct) values ('../etc', %s)", (CT,)))
        check("Мусор вместо шифра отклоняется",
              fails(conn, "insert into public.records (rid, ct) values (%s, '<script>')", ("d" * 32,)))
        made = 0
        for i in range(6):
            try:
                with conn.transaction():
                    conn.execute("select public.create_sync_token('t')")
                made += 1
            except psycopg.Error:
                pass
        check("Больше 5 токенов создать нельзя", made == 5)

        as_role(cur, "anon")
        check("Без входа таблица приглашений недоступна", fails(conn, "select * from public.allowed_emails"))
        check("Без входа записать строку нельзя",
              fails(conn, "insert into public.records (user_id, rid, ct) values (%s, %s, %s)", (A, "e" * 32, CT)))

        # ---- утёкший токен робота
        cur.execute("reset role")
        cur.execute("delete from public.sync_tokens")
        as_role(cur, "authenticated", A)
        cur.execute("select public.create_sync_token('t2')")
        tok = cur.fetchone()[0]
        cur.execute("insert into public.records (rid, ct) values (%s, %s)", ("0" * 32, "Q" * 64))
        as_role(cur, "anon")
        check("Токен не может перезаписать запись проверки ключа",
              fails(conn, "select public.ingest(%s, %s::jsonb)", (tok, json.dumps([{"rid": "0" * 32, "ct": CT}]))))
        check("Робот не может слать длинные записи (> 4096)",
              fails(conn, "select public.ingest(%s, %s::jsonb)", (tok, json.dumps([{"rid": "7" * 32, "ct": "A" * 4100}]))))
        check("Пакет больше 200 записей отклоняется",
              fails(conn, "select public.ingest(%s, %s::jsonb)", (tok, json.dumps([{"rid": "f" * 32, "ct": CT}] * 201))))
        ok_calls = 0
        for i in range(35):
            try:
                with conn.transaction():
                    conn.execute("select public.ingest(%s, %s::jsonb)", (tok, json.dumps([{"rid": "6" * 32, "ct": CT}])))
                ok_calls += 1
            except psycopg.Error:
                pass
        check("Не больше 30 отправок в минуту на токен", ok_calls == 30)
        cur.execute("reset role")
        cur.execute("select ct from public.records where user_id = %s and rid = %s", (A, "0" * 32))
        check("Запись проверки ключа не тронута", cur.fetchone()[0] == "Q" * 64)

        # робот, даже зная id ручной записи (утёкла копия), не может её перезаписать
        as_role(cur, "authenticated", A)
        cur.execute("insert into public.records (rid, ct) values (%s, %s)", ("5" * 32, "M" * 64))
        check("Пользователь не может пометить запись как робота",
              fails(conn, "update public.records set src = 'robot' where rid = %s", ("5" * 32,)))
        cur.execute("reset role")
        cur.execute("update public.sync_tokens set calls = 0")
        as_role(cur, "anon")
        cur.execute("select public.ingest(%s, %s::jsonb)", (tok, json.dumps([{"rid": "5" * 32, "ct": "Z" * 64}])))
        cur.execute("reset role")
        cur.execute("select ct from public.records where user_id = %s and rid = %s", (A, "5" * 32))
        check("Робот не может перезаписать ручную запись, даже зная её id", cur.fetchone()[0] == "M" * 64)

        # ИИ-аналитик: дневной лимит
        cur.execute("reset role")
        as_role(cur, "authenticated", B)
        left = []
        for _ in range(10):
            cur.execute("select public.ai_consume()"); left.append(cur.fetchone()[0])
        check("10 анализов в сутки проходят", left == list(range(9, -1, -1)))
        check("11-й анализ за сутки отклоняется", fails(conn, "select public.ai_consume()"))
        check("Пользователь не может вернуть себе лимит", fails(conn, "select public.ai_refund(%s)", (B,)))
        check("Таблица лимитов ИИ недоступна", fails(conn, "select * from public.ai_usage"))
        check("Нельзя накрутить лимит другому", fails(conn, "insert into public.ai_usage values (%s, current_date, 0)", (A,)))
        as_role(cur, "anon")
        check("Без входа анализ недоступен", fails(conn, "select public.ai_consume()"))
        as_role(cur, "service_role")
        cur.execute("select public.ai_refund(%s)", (B,))
        as_role(cur, "authenticated", B)
        cur.execute("select public.ai_left()")
        check("Возврат лимита сервером работает", cur.fetchone()[0] == 1)
        as_role(cur, "authenticated", A)
        cur.execute("select public.ai_left()")
        check("Лимит у каждого свой", cur.fetchone()[0] == 10)
        cur.execute("reset role")

        # ---- лимиты объёма на пользователя
        cur.execute("select rows, bytes from public.usage where user_id = %s", (A,))
        r, b = cur.fetchone()
        cur.execute("select count(*), sum(length(ct)) from public.records where user_id = %s", (A,))
        check("Учёт объёма сходится с фактом", (r, b) == tuple(cur.fetchone()))
        # доводим до 9 999 записей: одна новая ещё влезает, вторая — нет
        cur.execute("insert into public.records (user_id, rid, ct) "
                    "select %s, 'ab' || lpad(to_hex(g), 30, '0'), %s from generate_series(1, %s) g", (A, CT, 9999 - r))
        as_role(cur, "authenticated", A)
        check("Одна запись до лимита проходит", not fails(conn, "insert into public.records (rid, ct) values (%s, %s)", ("9" * 32, CT)))
        check("Лимит 10 000 записей: сверх лимита не записать",
              fails(conn, "insert into public.records (rid, ct) values (%s, %s)", ("8" * 32, CT)))
        check("На лимите обновлять свои записи можно (upsert)",
              not fails(conn, "insert into public.records (rid, ct) values (%s, %s) on conflict (user_id, rid) do update set ct = excluded.ct",
                        ("9" * 32, "B" * 80)))
        cur.execute("delete from public.records where rid like 'ab%%'")
        big = "A" * 16384
        check("Лимит 20 МБ на пользователя",
              fails(conn, "insert into public.records (rid, ct) select 'cd' || lpad(to_hex(g), 30, '0'), %s from generate_series(1, 1300) g", (big,)))
        cur.execute("reset role")
        cur.execute("delete from auth.users where id = %s", (A,))  # у A тысячи записей и строка usage
        check("Удаление аккаунта удаляет его данные без ошибок", True)
        cur.execute("reset role")

passed = sum(ok for _, ok in results)
print(f"\nИтого: {passed} из {len(results)} проверок пройдено")
raise SystemExit(0 if passed == len(results) else 1)
