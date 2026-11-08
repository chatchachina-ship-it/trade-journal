// Шифрование на устройстве. Сервер хранит только результат encrypt(): без ключа это набор случайных байтов.
//
// Схема (её же повторяет робот MT5, см. mt5/TradeJournalSync.mq5):
//   ключ пользователя  tjk_ + 64 hex-символа (32 случайных байта) — только на устройствах пользователя
//   ключ робота        tjr_ + hex(HMAC-SHA256(ключ пользователя, "tj-robot")) — отдаётся в MT5;
//                      им шифруются только позиции из MetaTrader, ручные сделки и заметки он не открывает
//   подключи           HMAC-SHA256(ключ, "tj-enc" | "tj-mac" | "tj-rid" | "tj-nonce")
//   открытый текст     JSON, дополненный пробелами до кратного 256 байт (длина не выдаёт содержимое)
//   nonce (16 байт)    первые 12 байт HMAC(nonce-ключ, текст) + 4 нулевых байта (счётчик блоков)
//   шифр               AES-256-CTR(enc-ключ, nonce)
//   подпись            HMAC-SHA256(mac-ключ, rid || 0x00 || nonce || шифр)
//   запись             base64(nonce || шифр || подпись)
"use strict";

const TJCrypto = (() => {
  const te = new TextEncoder();
  const td = new TextDecoder();
  const subtle = crypto.subtle;
  const PAD = 256;

  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  const unhex = s => Uint8Array.from(s.match(/../g), h => parseInt(h, 16));
  const b64 = bytes => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const hmacKey = raw => subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const sign = async (key, data) => new Uint8Array(await subtle.sign("HMAC", key, data));

  const KEY_RE = /^tj[kr]_[0-9a-f]{64}$/;

  function newMasterKey() {
    return "tjk_" + hex(crypto.getRandomValues(new Uint8Array(32)));
  }

  /** Приводит ключ к виду tjk_… или tjr_…; бросает ошибку, если формат неверный. */
  function normalizeKey(s, prefix = "tjk_") {
    const k = String(s || "").trim().toLowerCase().replace(/\s+/g, "");
    if (!KEY_RE.test(k) || !k.startsWith(prefix))
      throw new Error(`Неверный формат ключа: должен начинаться с ${prefix} и содержать 64 символа после него`);
    return k;
  }

  /** Ключ робота MT5 из ключа пользователя. */
  async function robotKeyFor(masterKeyString) {
    const master = await hmacKey(unhex(normalizeKey(masterKeyString).slice(4)));
    return "tjr_" + hex(await sign(master, te.encode("tj-robot")));
  }

  async function deriveKeys(keyString) {
    const k = String(keyString || "").trim().toLowerCase();
    const master = await hmacKey(unhex(normalizeKey(k, k.startsWith("tjr_") ? "tjr_" : "tjk_").slice(4)));
    const [e, m, r, n] = await Promise.all(
      ["tj-enc", "tj-mac", "tj-rid", "tj-nonce"].map(label => sign(master, te.encode(label))));
    return {
      enc: await subtle.importKey("raw", e, { name: "AES-CTR" }, false, ["encrypt", "decrypt"]),
      mac: await hmacKey(m),
      rid: await hmacKey(r),
      nonce: await hmacKey(n),
    };
  }

  /** Непрозрачный id записи: по нему нельзя понять, что внутри. */
  async function rid(keys, label) {
    return hex(await sign(keys.rid, te.encode(label))).slice(0, 32);
  }

  function randomRid() {
    return hex(crypto.getRandomValues(new Uint8Array(16)));
  }

  const macInput = (ridHex, nonce, ct) => concat(te.encode(ridHex), new Uint8Array([0]), nonce, ct);

  function padded(obj) {
    const raw = te.encode(JSON.stringify(obj));
    const out = new Uint8Array(Math.ceil(raw.length / PAD) * PAD || PAD).fill(0x20);
    out.set(raw);
    return out;
  }

  async function encrypt(keys, ridHex, obj) {
    const pt = padded(obj);
    const nonce = concat((await sign(keys.nonce, pt)).slice(0, 12), new Uint8Array(4));
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CTR", counter: nonce, length: 32 }, keys.enc, pt));
    const tag = await sign(keys.mac, macInput(ridHex, nonce, ct));
    return b64(concat(nonce, ct, tag));
  }

  /** Бросает ошибку, если ключ не тот или запись подменена. */
  async function decrypt(keys, ridHex, data) {
    const raw = unb64(data);
    if (raw.length < 49) throw new Error("Слишком короткая запись");
    const nonce = raw.slice(0, 16);
    const ct = raw.slice(16, raw.length - 32);
    const tag = raw.slice(raw.length - 32);
    const ok = await subtle.verify("HMAC", keys.mac, tag, macInput(ridHex, nonce, ct));
    if (!ok) throw new Error("Подпись не сходится");
    const pt = await subtle.decrypt({ name: "AES-CTR", counter: nonce, length: 32 }, keys.enc, ct);
    return JSON.parse(td.decode(pt));
  }

  return { newMasterKey, normalizeKey, robotKeyFor, deriveKeys, rid, randomRid, encrypt, decrypt };
})();
