"""Локальный макет Supabase для проверки приложения в браузере.

Отдаёт web/ и повторяет те адреса Supabase, которыми пользуется приложение и робот.
Все запросы к данным выполняются в настоящем Postgres под ролью anon/authenticated
со схемой supabase/schema.sql — то есть правила доступа работают по-настоящему.

Запуск: .testenv/bin/python tests/mock_supabase.py   → http://localhost:8790
Открытая регистрация выключена, как в настоящем проекте. Приглашение (вместо письма):
    curl "http://localhost:8790/__test/invite?email=a@test.ru"  → ссылка, которую открыть в браузере
"""
import hashlib
import json
import pathlib
import re
import secrets
import tempfile
import uuid
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import psycopg

from pgstub import as_role, start

PORT = 8790
WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
CONFIG_JS = f'window.TJ_CONFIG = {{ supabaseUrl: "http://localhost:{PORT}", supabaseAnonKey: "local-anon-key-for-testing-only" }};\n'

tmp = tempfile.TemporaryDirectory()
srv, conn = start(tmp.name)
conn.execute("insert into public.allowed_emails values ('a@test.ru'), ('b@test.ru')")
users = {}    # email -> {id, pw_hash}
tokens = {}   # access/refresh token -> user id


def pw_hash(pw):
    return hashlib.sha256(pw.encode()).hexdigest()


def email_of(uid):
    return next(e for e, v in users.items() if v["id"] == uid)


def issue(uid, email):
    access, refresh = "at-" + secrets.token_hex(16), "rt-" + secrets.token_hex(16)
    tokens[access] = tokens[refresh] = uid
    return {"access_token": access, "refresh_token": refresh, "expires_in": 3600, "user": {"id": uid, "email": email}}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(WEB), **k)

    def log_message(self, *a):
        pass

    # ---------------------------------------------------------------- ответы
    def reply(self, status, body=None, headers=None):
        data = b"" if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"null")

    def uid(self):
        auth = self.headers.get("Authorization", "")
        return tokens.get(auth.removeprefix("Bearer ")) if auth.startswith("Bearer ") else None

    def run(self, role, sub, sql, params=()):
        with conn.cursor() as cur:
            try:
                as_role(cur, role, sub)
                cur.execute(sql, params)
                return cur.fetchall() if cur.description else cur.rowcount
            finally:
                cur.execute("reset role")

    # ---------------------------------------------------------------- маршруты
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/config.js":
            data = CONFIG_JS.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/__test/invite":
            email = parse_qs(u.query).get("email", [""])[0].lower()
            try:
                if email not in users:
                    uid = str(uuid.uuid4())
                    conn.execute("insert into auth.users values (%s, %s)", (uid, email))   # триггер приглашений
                    users[email] = {"id": uid, "pw": None}
            except psycopg.Error as e:
                return self.reply(403, {"message": str(e).splitlines()[0]})
            t = issue(users[email]["id"], email)
            link = (f"http://localhost:{PORT}/#access_token={t['access_token']}&refresh_token={t['refresh_token']}"
                    f"&expires_in=3600&token_type=bearer&type=invite")
            return self.reply(200, {"link": link})
        if u.path == "/auth/v1/user":
            uid = self.uid()
            return self.reply(200, {"id": uid, "email": email_of(uid)}) if uid else self.reply(401, {"msg": "invalid JWT"})
        if not u.path.startswith("/rest/"):
            return super().do_GET()
        uid = self.uid()
        if not uid:
            return self.reply(401, {"message": "JWT required"})
        try:
            if u.path == "/rest/v1/records":
                a, b = map(int, (self.headers.get("Range") or "0-999").split("-"))
                rows = self.run("authenticated", uid, "select rid, ct from public.records order by rid offset %s limit %s", (a, b - a + 1))
                return self.reply(200, [{"rid": r, "ct": c} for r, c in rows])
            if u.path == "/rest/v1/sync_tokens":
                rows = self.run("authenticated", uid, "select id, label, created_at, last_used_at from public.sync_tokens order by created_at desc")
                return self.reply(200, [{"id": str(i), "label": l, "created_at": c.isoformat(),
                                         "last_used_at": lu.isoformat() if lu else None} for i, l, c, lu in rows])
        except psycopg.Error as e:
            return self.reply(403, {"message": str(e).splitlines()[0]})
        self.reply(404, {"message": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        body = self.body()
        try:
            if u.path == "/auth/v1/signup":
                return self.reply(422, {"msg": "Signups not allowed for this instance"})
            if u.path == "/auth/v1/recover":
                return self.reply(200, {})
            if u.path == "/auth/v1/token" and q.get("grant_type") == ["password"]:
                user = users.get(body["email"].lower())
                if not user or not user["pw"] or user["pw"] != pw_hash(body["password"]):
                    return self.reply(400, {"error_description": "Invalid login credentials"})
                return self.reply(200, issue(user["id"], body["email"].lower()))
            if u.path == "/auth/v1/token" and q.get("grant_type") == ["refresh_token"]:
                uid = tokens.pop(body.get("refresh_token"), None)
                if not uid:
                    return self.reply(400, {"error_description": "Invalid Refresh Token"})
                return self.reply(200, issue(uid, email_of(uid)))
            if u.path == "/auth/v1/logout":
                uid = tokens.pop(self.headers.get("Authorization", "").removeprefix("Bearer "), None)
                if uid and q.get("scope") == ["global"]:
                    for k in [k for k, v in tokens.items() if v == uid]:
                        tokens.pop(k)
                return self.reply(204)

            if u.path == "/rest/v1/rpc/ingest":
                n = self.run("anon", None, "select public.ingest(%s, %s::jsonb)", (body.get("p_token"), json.dumps(body.get("p_items"))))
                return self.reply(200, n[0][0])

            uid = self.uid()
            if not uid:
                return self.reply(401, {"message": "JWT required"})
            if u.path == "/rest/v1/rpc/create_sync_token":
                r = self.run("authenticated", uid, "select public.create_sync_token(%s)", (body.get("p_label", ""),))
                return self.reply(200, r[0][0])
            if u.path == "/functions/v1/analyst":
                return self.analyst(uid, body)
            if u.path == "/rest/v1/records":
                upsert = "merge-duplicates" in (self.headers.get("Prefer") or "")
                sql = ("insert into public.records (user_id, rid, ct) values (coalesce(%s::uuid, auth.uid()), %s, %s)"
                       + (" on conflict (user_id, rid) do update set ct = excluded.ct" if upsert else ""))
                with conn.transaction():
                    for item in body:
                        self.run("authenticated", uid, sql, (item.get("user_id"), item.get("rid"), item.get("ct")))
                return self.reply(201)
        except psycopg.errors.UniqueViolation as e:
            return self.reply(409, {"message": "duplicate key"})
        except psycopg.Error as e:
            return self.reply(400, {"message": str(e).splitlines()[0]})
        self.reply(404, {"message": "not found"})

    # Заглушка функции аналитика: без Claude, но с настоящим лимитом из базы.
    def analyst(self, uid, body):
        import time
        op = body.get("op")
        if op == "left":
            return self.reply(200, {"left": self.run("authenticated", uid, "select public.ai_left()")[0][0]})
        if op == "candles":
            now, start = time.time() * 1000, body["from"]
            # цена плавно растёт с 100: цель роста 103 достигается через несколько часов
            bars = [[start + i * 36e5, 100 + i * 0.6 + 0.3, 100 + i * 0.6 - 0.3, 100 + i * 0.6]
                    for i in range(int(body["hours"])) if start + i * 36e5 < now]
            return self.reply(200, {"bars": bars, "complete": now >= start + body["hours"] * 36e5})
        if op == "analyze":
            try:
                left = self.run("authenticated", uid, "select public.ai_consume()")[0][0]
            except psycopg.Error as e:
                return self.reply(429, {"message": str(e).splitlines()[0].removeprefix("ERROR:  ")})
            f = {"bias": "up", "summary": "Тестовый прогноз <b>без ИИ</b>: цена выше EMA50 на 4h, RSI 58.",
                 "up": {"probability": 50, "target": 103, "reason": "пробой high20"},
                 "down": {"probability": 30, "target": 97.5, "reason": "возврат к EMA200"},
                 "flat": {"probability": 20, "reason": "низкая волатильность"},
                 "levels": [{"price": 103, "kind": "resistance", "note": "high20 4h"}, {"price": 97.5, "kind": "support", "note": "EMA200"}],
                 "news": [{"title": "Пример новости", "url": "https://example.com/news", "impact": "bullish"}],
                 "risks": "Данные тестовые."}
            return self.reply(200, {"forecast": f, "price": 100, "move": 2, "label": body["symbol"].upper(), "market": body["market"],
                                    "horizon": body["horizon"], "hours": 24, "at": int(time.time() * 1000), "left": left})
        return self.reply(400, {"message": "bad op"})

    def do_PUT(self):
        u = urlparse(self.path)
        body = self.body()
        uid = self.uid()
        if u.path != "/auth/v1/user" or not uid:
            return self.reply(401, {"msg": "invalid JWT"})
        pw = body.get("password", "")
        if len(pw) < 10:
            return self.reply(422, {"msg": "Password should be at least 10 characters"})
        users[email_of(uid)]["pw"] = pw_hash(pw)
        return self.reply(200, {"id": uid, "email": email_of(uid)})

    def do_DELETE(self):
        u = urlparse(self.path)
        uid = self.uid()
        if not uid:
            return self.reply(401, {"message": "JWT required"})
        table = {"/rest/v1/records": ("records", "rid"), "/rest/v1/sync_tokens": ("sync_tokens", "id")}.get(u.path)
        if not table:
            return self.reply(404, {"message": "not found"})
        name, col = table
        q = parse_qs(u.query).get(col, [""])[0]
        if q == "not.is.null":
            self.run("authenticated", uid, f"delete from public.{name} where {col} is not null")
        elif m := re.fullmatch(r"eq\.([0-9a-f-]+)", q):
            self.run("authenticated", uid, f"delete from public.{name} where {col}::text = %s", (m[1],))
        else:
            return self.reply(400, {"message": "bad filter"})
        self.reply(204)


print(f"Макет Supabase: http://localhost:{PORT}")
HTTPServer(("localhost", PORT), Handler).serve_forever()
