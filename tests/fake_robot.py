"""Имитация робота MT5: шифрует позиции независимой реализацией и отправляет их в ingest — как робот.

Запуск: .testenv/bin/python tests/fake_robot.py <адрес> <токен> <ключ>
"""
import json
import sys
import urllib.request

from crypto_reference import derive, encrypt, rid

url, token, key = sys.argv[1:4]
keys = derive(key)
ACCOUNT = "50112233"
positions = [
    {"t": "mt5", "account": ACCOUNT, "pos": 1001, "symbol": "XAUUSD", "isLong": True, "entry": 2650.15, "exit": 2661.4,
     "stop": 2640, "qty": 0.1, "profit": 112.5, "riskMoney": 101.5, "date": "2026-11-04T10:15:20Z",
     "closeDate": "2026-11-04T12:01:00Z", "open": False},
    {"t": "mt5", "account": ACCOUNT, "pos": 1002, "symbol": "EURUSD", "isLong": False, "entry": 1.0812, "exit": None,
     "stop": 1.0840, "qty": 0.5, "profit": None, "riskMoney": 140.0, "date": "2026-11-05T08:00:00Z",
     "closeDate": None, "open": True},
]
items = []
for p in positions:
    r = rid(keys, f"mt5:{ACCOUNT}:{p['pos']}")
    items.append({"rid": r, "ct": encrypt(keys, r, json.dumps(p, ensure_ascii=False, separators=(",", ":")).encode())})

req = urllib.request.Request(
    url + "/rest/v1/rpc/ingest", method="POST",
    data=json.dumps({"p_token": token, "p_items": items}).encode(),
    headers={"Content-Type": "application/json", "apikey": "anon", "Authorization": "Bearer anon"})
try:
    with urllib.request.urlopen(req) as res:
        print("ответ сервера:", res.status, res.read().decode())
except urllib.error.HTTPError as e:
    print("ошибка:", e.code, e.read().decode())
    sys.exit(1)
