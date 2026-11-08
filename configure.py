#!/usr/bin/env python3
"""Подключает приложение к своему проекту Supabase.

    python3 configure.py https://xxxx.supabase.co <публичный ключ>

Записывает адрес и ключ в web/config.js и сужает политику безопасности (CSP) в web/index.html
до этого адреса, чтобы страница не могла отправлять данные ни в какой другой проект.
Отказывается работать с секретным ключом service_role.
"""
import base64
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
CONFIG = ROOT / "web" / "config.js"
INDEX = ROOT / "web" / "index.html"


def is_secret(key):
    if key.startswith("sb_secret_"):
        return True
    parts = key.split(".")
    if len(parts) != 3:
        return False
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    except ValueError:
        return False
    return payload.get("role") == "service_role"


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    url, key = sys.argv[1].strip().rstrip("/").lower(), sys.argv[2].strip()
    if not re.fullmatch(r"https://[a-z0-9-]+\.supabase\.co", url):
        sys.exit("Адрес должен быть вида https://xxxx.supabase.co (Project Settings → API → Project URL)")
    if is_secret(key):
        sys.exit("Это СЕКРЕТНЫЙ ключ service_role — его нельзя класть в приложение. Нужен публичный: anon / publishable.")
    if len(key) < 20 or not re.fullmatch(r"[A-Za-z0-9_.\-]+", key):
        sys.exit("Ключ не похож на публичный ключ Supabase (anon / publishable)")

    CONFIG.write_text(
        "// Настройки подключения к базе. Записано командой configure.py.\n"
        "// Оба значения публичные по замыслу Supabase: защиту данных дают правила доступа в базе и шифрование.\n"
        f"window.TJ_CONFIG = {{\n  supabaseUrl: {json.dumps(url)},\n  supabaseAnonKey: {json.dumps(key)},\n}};\n",
        encoding="utf-8")

    html = INDEX.read_text(encoding="utf-8")
    html, n = re.subn(r"connect-src 'self'[^;]*;", f"connect-src 'self' {url};", html)
    if n != 1:
        sys.exit("Не нашёл строку connect-src в web/index.html")
    INDEX.write_text(html, encoding="utf-8")
    print(f"Готово: приложение подключено к {url}")


if __name__ == "__main__":
    main()
