"""Независимая реализация схемы шифрования — так же, как её делает робот MT5:
AES-256 по одному блоку (ECB) для счётчика CTR и HMAC-SHA256, собранный из SHA-256 вручную.

Пишет tests/vectors.js; tests/crypto_test.html сверяет с ними web/crypto.js байт в байт.
Запуск: .testenv/bin/python tests/crypto_reference.py
"""
import base64
import hashlib
import json
import pathlib

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def sha256(b):
    return hashlib.sha256(b).digest()


def hmac_manual(key, msg):
    """HMAC-SHA256 по RFC 2104 — как в MQL5, где готового HMAC нет."""
    if len(key) > 64:
        key = sha256(key)
    key = key.ljust(64, b"\0")
    ipad = bytes(k ^ 0x36 for k in key)
    opad = bytes(k ^ 0x5C for k in key)
    return sha256(opad + sha256(ipad + msg))


def aes_block(key, block):
    enc = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return enc.update(block) + enc.finalize()


def derive(key_str):
    """Подключи из ключа пользователя (tjk_) или ключа робота (tjr_) — схема одна."""
    master = bytes.fromhex(key_str[4:])
    return {label: hmac_manual(master, label.encode()) for label in ("tj-enc", "tj-mac", "tj-rid", "tj-nonce")}


def robot_key_for(master_key_str):
    return "tjr_" + hmac_manual(bytes.fromhex(master_key_str[4:]), b"tj-robot").hex()


def rid(keys, label):
    return hmac_manual(keys["tj-rid"], label.encode()).hex()[:32]


def pad(pt, block=256):
    """Дополняет пробелами до кратного 256 байт: JSON с пробелами в конце читается так же."""
    return pt + b" " * (-len(pt) % block)


def encrypt(keys, rid_hex, pt):
    pt = pad(pt)
    nonce = hmac_manual(keys["tj-nonce"], pt)[:12] + bytes(4)
    stream = b""
    i = 0
    while len(stream) < len(pt):
        stream += aes_block(keys["tj-enc"], nonce[:12] + i.to_bytes(4, "big"))
        i += 1
    ct = bytes(a ^ b for a, b in zip(pt, stream))
    tag = hmac_manual(keys["tj-mac"], rid_hex.encode() + b"\0" + nonce + ct)
    return base64.b64encode(nonce + ct + tag).decode()


# Самопроверки примитивов на официальных векторах
assert aes_block(bytes(range(32)), bytes.fromhex("00112233445566778899aabbccddeeff")).hex() \
    == "8ea2b7ca516745bfeafc49904b496089", "FIPS-197 AES-256"
assert hmac_manual(b"Jefe", b"what do ya want for nothing?").hex() \
    == "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", "RFC 4231 HMAC-SHA256"

if __name__ == "__main__":
    KEY = "tjk_" + "1f" * 16 + "a5" * 16
    ROBOT = robot_key_for(KEY)
    cases = []
    for key_type, obj in [
        ("main", {"t": "check", "v": 1}),
        ("robot", {"t": "mt5", "account": "12345678", "pos": 987654321, "symbol": "XAUUSD", "isLong": True,
                   "entry": 2650.15, "exit": 2661.4, "stop": 2640, "qty": 0.1, "profit": 112.5, "riskMoney": 101.5,
                   "date": "2026-11-03T10:15:20Z", "closeDate": "2026-11-03T12:01:00Z", "open": False}),
        ("main", {"t": "trade", "symbol": "BTCUSDT", "notes": "Заметка с кириллицей и \"кавычками\" " + "длинная " * 20}),
    ]:
        keys = derive(ROBOT if key_type == "robot" else KEY)
        pt = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        label = "mt5:12345678:987654321" if obj["t"] == "mt5" else obj["t"]
        r = rid(keys, label)
        cases.append({"keyType": key_type, "label": label, "rid": r, "obj": obj, "pt": pt,
                      "ct": encrypt(keys, r, pt.encode())})

    out = pathlib.Path(__file__).with_name("vectors.js")
    out.write_text("window.VECTORS = " + json.dumps({"key": KEY, "robotKey": ROBOT, "cases": cases},
                                                    ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")
    print(f"записано {len(cases)} векторов в {out.name}")
