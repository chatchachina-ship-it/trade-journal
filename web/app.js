"use strict";

// Не работаем внутри чужого фрейма: иначе страницу можно накрыть обманным слоем.
if (window.top !== window.self) {
  document.documentElement.textContent = "";
  throw new Error("framed");
}

// ================================================================ настройки и состояние

const cfg = window.TJ_CONFIG || {};

/** Секретный ключ Supabase (service_role) никогда не должен попасть в приложение — он обходит все правила доступа. */
function isSecretKey(k) {
  if (/^sb_secret_/.test(k)) return true;
  const parts = String(k).split(".");
  if (parts.length !== 3) return false;
  try { return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "service_role"; } catch { return false; }
}
const secretKeyInConfig = typeof cfg.supabaseAnonKey === "string" && isSecretKey(cfg.supabaseAnonKey);
// Локальный адрес допускается, только когда само приложение открыто с localhost (проверка на компьютере).
const configured = !secretKeyInConfig
  && (/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.supabaseUrl || "")
    || (location.hostname === "localhost" && /^http:\/\/localhost:\d+$/.test(cfg.supabaseUrl || "")))
  && typeof cfg.supabaseAnonKey === "string" && cfg.supabaseAnonKey.length > 20;
const SESSION_MAX_DAYS = 30;   // после этого срока пароль нужно ввести заново

const $ = id => document.getElementById(id);
const view = $("view");
const EMOTIONS = ["Спокоен", "Страх", "Жадность", "FOMO", "Отыгрыш"];
const CHECK_RID = "0".repeat(32);      // запись-проверка ключа: по ней узнаём, что введён правильный ключ
const LEGACY_STORE = "trade-journal-v1"; // сделки из первой версии без входа
const RID_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f-]{36}$/;

const store = {
  get(k) { try { const v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* недоступно */ } },
};
const userKey = name => `tj-${name}:${session.user.id}`;

let session = store.get("tj-session");
let keys = null;          // { main, robot }: ключи пользователя и робота MT5
let robotKey = "";        // tjr_… — показывается в карточке робота вместо ключа пользователя
let rows = new Map();     // rid -> шифр (как на сервере); кэш для работы без сети
let records = new Map();  // rid -> расшифрованная запись
let outbox = new Map();   // rid -> шифр | null (удаление), ещё не отправлено на сервер

let screen = "loading";
let tab = "trades";
let period = "week";
let authMode = "in";      // in — вход, reset — сброс пароля, set — задать пароль по ссылке из письма
let authMsg = "";
let linkSession = null;   // сессия из ссылки приглашения/сброса до того, как задан пароль
let pendingKey = null;    // только что созданный ключ, который пользователь должен сохранить
let newToken = null;      // только что созданный токен робота (показывается один раз)
let tokens = null;        // список токенов для экрана настроек
let keyShown = false;
let editing = null;       // { rid, src } открытой в форме сделки
let formLong = true;
const sync = { busy: false, at: null, error: "", bad: 0 };

// ================================================================ форматирование

const nf = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const money = v => (v > 0 ? "+" : "") + nf.format(v) + " $";
const rFmt = v => (v > 0 ? "+" : "") + nf.format(v) + "R";
const cls = v => v > 0 ? "pos" : v < 0 ? "neg" : "muted";
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = s => {
  if (s == null || String(s).trim() === "") return null;
  const v = parseFloat(String(s).replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(v) ? v : null;
};

// ================================================================ проверка расшифрованных записей

const str = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
const fin = v => typeof v === "number" && Number.isFinite(v) ? v : null;
const isoDate = d => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString(); };
const emotionOf = e => EMOTIONS.includes(e) ? e : "Спокоен";

/** Приводит запись к ожидаемой форме: всё, что пришло с сервера, считаем недоверенным. */
function clean(o) {
  if (!o || typeof o !== "object") throw new Error("not an object");
  switch (o.t) {
    case "trade":
      return { t: "trade", symbol: str(o.symbol, 40), isLong: o.isLong !== false, entry: fin(o.entry), exit: fin(o.exit),
        stop: fin(o.stop), qty: fin(o.qty), fees: fin(o.fees) || 0, date: isoDate(o.date), setup: str(o.setup, 200),
        emotion: emotionOf(o.emotion), plan: o.plan !== false, notes: str(o.notes, 4000) };
    case "mt5":
      return { t: "mt5", account: str(String(o.account ?? ""), 20), pos: str(String(o.pos ?? ""), 30),
        symbol: str(o.symbol, 40), isLong: o.isLong !== false, entry: fin(o.entry), exit: fin(o.exit), stop: fin(o.stop),
        qty: fin(o.qty), profit: fin(o.profit), riskMoney: fin(o.riskMoney), date: isoDate(o.date),
        closeDate: o.closeDate ? isoDate(o.closeDate) : null, open: o.open === true };
    case "ann":
      return { t: "ann", ref: RID_RE.test(o.ref) ? o.ref : "", setup: str(o.setup, 200), emotion: emotionOf(o.emotion),
        plan: o.plan !== false, notes: str(o.notes, 4000), hidden: o.hidden === true };
    case "forecast":
      return cleanForecast(o);   // analyst.js
    default:
      throw new Error("unknown type");
  }
}

// ================================================================ формулы

/** Для сделок из MT5 результат берём у брокера (с учётом контракта, комиссий и свопов). */
const pnlOf = t => {
  if (t.exit == null) return null;
  if (t.profit != null) return t.profit;
  return (t.exit - t.entry) * t.qty * (t.isLong ? 1 : -1) - (t.fees || 0);
};
const riskOf = t => {
  if (t.src === "mt5") return t.riskMoney > 0 ? t.riskMoney : null;
  if (t.stop == null) return null;
  const r = Math.abs(t.entry - t.stop) * t.qty;
  return r > 0 ? r : null;
};
const rOf = t => { const p = pnlOf(t), r = riskOf(t); return p != null && r ? p / r : null; };
const stopWrongSide = (entry, stop, isLong) => isLong ? stop >= entry : stop <= entry;

function buildTrades() {
  const anns = new Map();
  for (const r of records.values()) if (r.t === "ann" && r.ref) anns.set(r.ref, r);
  const out = [];
  for (const [rid, r] of records) {
    if (r.t === "trade") out.push({ ...r, rid, src: "manual" });
    if (r.t === "mt5") {
      const a = anns.get(rid) || {};
      if (a.hidden) continue;
      out.push({ rid, src: "mt5", account: r.account, pos: r.pos, symbol: r.symbol, isLong: r.isLong,
        entry: r.entry, exit: r.open ? null : r.exit, stop: r.stop, qty: r.qty, fees: 0,
        profit: r.open ? null : r.profit, riskMoney: r.riskMoney, date: r.date,
        setup: a.setup || "", emotion: a.emotion || "Спокоен", plan: a.plan !== false, notes: a.notes || "" });
    }
  }
  return out.filter(t => t.entry != null);
}

function stats(list) {
  const closed = list.filter(t => pnlOf(t) != null).sort((a, b) => a.date.localeCompare(b.date));
  const pnls = closed.map(pnlOf);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const wins = pnls.filter(p => p > 0), losses = pnls.filter(p => p < 0);
  const rs = closed.map(rOf).filter(r => r != null);
  let total = 0, peak = 0, dd = 0;
  const equity = closed.map(t => { total += pnlOf(t); peak = Math.max(peak, total); dd = Math.min(dd, total - peak); return total; });
  const offPlan = closed.filter(t => !t.plan);
  const byEmotion = EMOTIONS.map(e => { const g = closed.filter(t => t.emotion === e); return { e, n: g.length, pnl: sum(g.map(pnlOf)) }; }).filter(x => x.n);
  const s = {
    count: closed.length, net: sum(pnls),
    winRate: closed.length ? wins.length / closed.length : null,
    avgWin: wins.length ? sum(wins) / wins.length : null,
    avgLoss: losses.length ? sum(losses) / losses.length : null,
    pf: losses.length ? sum(wins) / -sum(losses) : null,
    avgR: rs.length ? sum(rs) / rs.length : null,
    equity, maxDD: dd,
    noStop: closed.filter(t => t.stop == null).length,
    offPlanN: offPlan.length, offPlanPnl: sum(offPlan.map(pnlOf)), byEmotion,
  };
  const ins = [];
  if (s.noStop) ins.push(`${s.noStop} из ${s.count} сделок без стопа. Без стопа нельзя посчитать риск, и один неудачный вход может съесть неделю.`);
  if (s.offPlanN) ins.push(`Сделки не по плану (${s.offPlanN}) дали ${money(s.offPlanPnl)}.`);
  const emo = byEmotion.filter(x => x.e !== "Спокоен"), emoPnl = sum(emo.map(x => x.pnl));
  if (emo.length && emoPnl < 0) ins.push(`Сделки на эмоциях в сумме: ${money(emoPnl)}.`);
  if (s.pf != null && s.pf < 1) ins.push("Профит-фактор ниже 1: убытки перевешивают прибыль. Стоит сократить число сделок и оставить только лучший сетап.");
  if (s.avgWin != null && s.avgLoss != null && Math.abs(s.avgLoss) > s.avgWin) ins.push("Средний убыток больше средней прибыли: возможно, стопы двигаются или прибыль фиксируется слишком рано.");
  if (!ins.length && s.count) ins.push("Явных проблем с дисциплиной не видно. Продолжай записывать каждую сделку.");
  s.insights = ins;
  return s;
}

// ================================================================ сервер: вход

class AuthGone extends Error {}

async function authCall(path, body, token, method = "POST") {
  let res;
  try {
    res = await fetch(`${cfg.supabaseUrl}/auth/v1/${path}`, {
      method,
      headers: { apikey: cfg.supabaseAnonKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    });
  } catch { throw new Error("Нет связи с сервером"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(authError(data, res.status)); e.status = res.status; throw e; }
  return data;
}

function authError(d, status) {
  const m = String(d.msg || d.message || d.error_description || d.error || "");
  if (/invalid login credentials/i.test(m)) return "Неверный email или пароль";
  if (/email not confirmed/i.test(m)) return "Сначала прими приглашение по ссылке из письма";
  if (/same.*password|different from the old/i.test(m)) return "Новый пароль должен отличаться от старого";
  if (/password/i.test(m)) return "Пароль слишком простой: минимум 10 символов, буквы и цифры";
  if (status === 429 || /rate limit|too many/i.test(m)) return "Слишком много попыток. Подожди несколько минут";
  return "Не удалось выполнить. Попробуй ещё раз";
}

function saveSession(d, loginAt) {
  if (!d.access_token || !d.user || !d.user.id) throw new Error("Сервер не вернул сессию");
  session = {
    access_token: d.access_token, refresh_token: d.refresh_token,
    expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
    user: { id: d.user.id, email: d.user.email },
    login_at: loginAt || (session && session.login_at) || Date.now(),
  };
  store.set("tj-session", session);
}

let refreshing = null;
async function freshToken(force = false) {
  // Сессию могла обновить другая вкладка: берём свежую копию из хранилища.
  const stored = store.get("tj-session");
  if (session && stored && stored.user && stored.user.id === session.user.id && stored.expires_at > session.expires_at) session = stored;
  if (!session) throw new AuthGone();
  if (!session.login_at) { session.login_at = Date.now(); store.set("tj-session", session); }   // сессии старых версий
  if (Date.now() - session.login_at > SESSION_MAX_DAYS * 864e5) {
    sessionExpired(`Прошло больше ${SESSION_MAX_DAYS} дней — для безопасности войди снова`);
    throw new AuthGone();
  }
  if (!force && session.expires_at * 1000 - 60_000 > Date.now()) return session.access_token;
  const used = session.refresh_token;
  refreshing ||= authCall("token?grant_type=refresh_token", { refresh_token: used })
    .then(d => saveSession(d)).finally(() => { refreshing = null; });
  try { await refreshing; } catch (e) {
    const again = store.get("tj-session");
    if (again && again.refresh_token !== used && again.user && again.user.id === session.user.id) {
      session = again;           // другая вкладка успела обновить раньше нас
      return session.access_token;
    }
    if (e.status >= 400 && e.status < 500) { sessionExpired(); throw new AuthGone(); }
    throw e;
  }
  return session.access_token;
}

async function api(path, { method = "GET", body, headers = {} } = {}, retried = false) {
  const token = await freshToken(retried);
  let res;
  try {
    res = await fetch(cfg.supabaseUrl + path, {
      method,
      headers: { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new Error("Нет связи с сервером"); }
  if (res.status === 401) {
    if (!retried) return api(path, { method, body, headers }, true);   // одна попытка с обновлённым токеном
    sessionExpired();
    throw new AuthGone();
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
  if (!res.ok) {
    const e = new Error((data && typeof data.message === "string" && data.message.slice(0, 200)) || `Ошибка сервера (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

function sessionExpired(msg) {
  // Ключ и кэш (зашифрованный) остаются на устройстве: после повторного входа того же человека ключ вводить не нужно.
  session = null;
  keys = null;
  records = new Map();
  store.del("tj-session");
  screen = "auth";
  authMode = "in";
  authMsg = msg || "Сессия закончилась — войди снова";
  closeForm();
  render();
}

// ================================================================ сервер: записи

function loadLocal() {
  rows = new Map((store.get(userKey("rows")) || []).filter(([r, c]) => RID_RE.test(r) && typeof c === "string"));
  outbox = new Map((store.get(userKey("outbox")) || []).filter(([r]) => RID_RE.test(r)));
}

function saveLocal() {
  const ok = store.set(userKey("rows"), [...rows]) && store.set(userKey("outbox"), [...outbox]);
  if (!ok) sync.error = "Память браузера переполнена или недоступна — изменения хранятся только до закрытия страницы";
}

async function decryptAll() {
  const next = new Map();
  let bad = 0;
  await Promise.all([...rows].map(async ([rid, ct]) => {
    if (rid === CHECK_RID) return;
    try { next.set(rid, await decryptRecord(rid, ct)); } catch { bad++; }
  }));
  records = next;
  sync.bad = bad;
}

/** Ключ пользователя открывает всё, ключ робота — только позиции из MT5. */
async function decryptRecord(rid, ct) {
  try {
    return clean(await TJCrypto.decrypt(keys.main, rid, ct));
  } catch {
    const o = clean(await TJCrypto.decrypt(keys.robot, rid, ct));
    if (o.t !== "mt5") throw new Error("ключом робота можно шифровать только позиции MT5");
    return o;
  }
}

class KeyMismatch extends Error {}

/** Ключ на устройстве должен открывать запись-проверку на сервере. Ключ при несовпадении НЕ стирается. */
async function verifyKey() {
  const ct = rows.get(CHECK_RID);
  if (!ct) {
    // проверку удалили — молча восстанавливаем своим ключом (без перезаписи чужой, если она появится)
    const fresh = await TJCrypto.encrypt(keys.main, CHECK_RID, { t: "check", v: 2 });
    try {
      await api("/rest/v1/records", { method: "POST", headers: { Prefer: "return=minimal" }, body: [{ rid: CHECK_RID, ct: fresh }] });
      rows.set(CHECK_RID, fresh);
    } catch (e) { if (e instanceof AuthGone) throw e; }
    return;
  }
  try { await TJCrypto.decrypt(keys.main, CHECK_RID, ct); } catch { throw new KeyMismatch(); }
}

let keyConflict = false;

async function restoreCheck() {
  if (!confirm("Восстановить проверку ключа ключом этого устройства? Делай так, только если ты НЕ менял ключ на другом устройстве.")) return;
  const ct = await TJCrypto.encrypt(keys.main, CHECK_RID, { t: "check", v: 2 });
  await api("/rest/v1/records?on_conflict=user_id,rid", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: [{ user_id: session.user.id, rid: CHECK_RID, ct }] });
  keyConflict = false;
  sync.error = "";
  await syncNow();
}

function useNewKey() {
  store.set(userKey("key-prev"), store.get(userKey("key")));   // старый ключ не теряется
  store.del(userKey("key"));
  keys = null; records = new Map(); pendingKey = null; keyConflict = false;
  screen = "key";
  render();
}

async function pull() {
  const fresh = new Map();
  for (let from = 0; ; from += 1000) {
    const data = await api("/rest/v1/records?select=rid,ct&order=rid", { headers: { "Range-Unit": "items", Range: `${from}-${from + 999}` } });
    for (const r of data || []) if (RID_RE.test(r.rid) && typeof r.ct === "string") fresh.set(r.rid, r.ct);
    if (!data || data.length < 1000) break;
  }
  for (const [rid, ct] of outbox) ct === null ? fresh.delete(rid) : fresh.set(rid, ct);
  // Если с сервера разом пропала большая часть записей — не стираем копию на устройстве без согласия.
  const lost = [...rows.keys()].filter(r => !fresh.has(r)).length;
  if (lost > 10 && lost > rows.size / 2
      && !confirm(`С сервера пропали ${lost} записей из ${rows.size}. Если ты сам удалил их с другого устройства — нажми «ОК». ` +
                  "Если нет — нажми «Отмена»: копия на этом телефоне сохранится, а ты сможешь сохранить её в файл в настройках.")) {
    throw new Error("Синхронизация остановлена: на сервере пропали записи. Сохрани копию в файл в настройках");
  }
  // Самолечение: если на сервере запись подменили (не открывается), а своя копия читается — оставляем свою и отправляем заново.
  if (keys) {
    for (const [rid, ct] of fresh) {
      const mine = rows.get(rid);
      if (rid === CHECK_RID || !mine || mine === ct) continue;
      const ok = async c => { try { await decryptRecord(rid, c); return true; } catch { return false; } };
      if (await ok(mine) && !(await ok(ct))) { fresh.set(rid, mine); outbox.set(rid, mine); }
    }
  }
  rows = fresh;
  saveLocal();
}

let flushing = null;
function flush() {
  flushing ||= (async () => {
    const ups = [...outbox].filter(([, ct]) => ct !== null);
    for (let i = 0; i < ups.length; i += 200) {
      const batch = ups.slice(i, i + 200);
      await api("/rest/v1/records?on_conflict=user_id,rid", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: batch.map(([rid, ct]) => ({ user_id: session.user.id, rid, ct })),
      });
      for (const [rid, ct] of batch) if (outbox.get(rid) === ct) outbox.delete(rid);
      saveLocal();
    }
    for (const [rid, ct] of [...outbox]) {
      if (ct !== null) continue;
      await api(`/rest/v1/records?rid=eq.${rid}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      if (outbox.get(rid) === null) outbox.delete(rid);
      saveLocal();
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

async function syncNow() {
  if (sync.busy || screen !== "main" || keyConflict) return;
  sync.busy = true;
  renderStatus();
  try {
    await flush();
    await pull();
    await verifyKey();
    await decryptAll();
    if (outbox.size) await flush();   // восстановленные «самолечением» записи сразу уходят обратно на сервер
    sync.at = new Date();
    sync.error = "";
  } catch (e) {
    if (e instanceof AuthGone) return;
    if (e instanceof KeyMismatch) {
      // Ничего не стираем: останавливаем синхронизацию и даём человеку решить.
      keyConflict = true;
      sync.error = "Проверка ключа на сервере не совпадает с ключом этого устройства. Синхронизация остановлена.";
    } else {
      sync.error = e.message;
    }
  } finally {
    sync.busy = false;
  }
  if (screen === "main") render();
}

async function putRecord(rid, obj) {
  const ct = await TJCrypto.encrypt(obj.t === "mt5" ? keys.robot : keys.main, rid, obj);
  if (ct.length > 16000) throw new Error("Запись слишком длинная — сократи заметку");
  rows.set(rid, ct);
  records.set(rid, clean(obj));
  outbox.set(rid, ct);
  saveLocal();
}

function removeRecord(rid) {
  rows.delete(rid);
  records.delete(rid);
  outbox.set(rid, null);
  saveLocal();
}

function afterLocalChange() {
  render();
  flush().then(() => { sync.error = ""; renderStatus(); }, e => { if (!(e instanceof AuthGone)) { sync.error = e.message; renderStatus(); } });
}

// ================================================================ вход и ключ

const strongPassword = p => p.length >= 10 && /\d/.test(p) && /[a-zA-Zа-яА-ЯёЁ]/.test(p);

async function doAuth() {
  authMsg = "";
  const btn = $("authBtn");
  if (btn) btn.disabled = true;
  try {
    if (authMode === "set") {
      const p1 = String($("authPass").value || ""), p2 = String($("authPass2").value || "");
      if (!strongPassword(p1)) return showAuthMsg("Пароль: минимум 10 символов, буквы и цифры");
      if (p1 !== p2) return showAuthMsg("Пароли не совпадают");
      await authCall("user", { password: p1 }, linkSession.access_token, "PUT");
      saveSession(linkSession, Date.now());
      linkSession = null;
      authMode = "in";
      await afterLogin();
      return;
    }
    const email = String($("authEmail").value || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showAuthMsg("Проверь email");
    if (authMode === "reset") {
      await authCall("recover", { email });
      authMode = "in";
      authMsg = "Если такой аккаунт есть, мы отправили письмо со ссылкой для нового пароля.";
      render();
      return;
    }
    const password = String($("authPass").value || "");
    if (!password) return showAuthMsg("Введи пароль");
    saveSession(await authCall("token?grant_type=password", { email, password }), Date.now());
    await afterLogin();
  } catch (e) {
    showAuthMsg(e.message);
  } finally {
    const b = $("authBtn");
    if (b) b.disabled = false;
  }
}

function showAuthMsg(m) { authMsg = m; const el = $("authMsg"); if (el) el.textContent = m; }

/** Ссылка из письма (приглашение или сброс пароля) приносит сессию в адресе после #. */
async function readLinkFromAddress() {
  if (!location.hash || location.hash.length < 2) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);   // токены не остаются в адресе и истории
  if (p.get("error_description")) {
    authMsg = "Ссылка недействительна или устарела. Попроси новое приглашение или сбрось пароль ещё раз.";
    return false;
  }
  const access = p.get("access_token"), type = p.get("type");
  if (!access || !["invite", "recovery"].includes(type)) return false;
  try {
    const user = await authCall("user", null, access, "GET");
    if (session && session.user && user.email && session.user.email !== user.email
        && !confirm(`Ссылка для ${user.email}, а сейчас вход выполнен как ${session.user.email}. Переключиться?`)) return false;
    linkSession = { access_token: access, refresh_token: p.get("refresh_token"),
      expires_at: Number(p.get("expires_at")) || undefined, expires_in: Number(p.get("expires_in")) || 3600, user };
    authMode = "set";
    authMsg = type === "invite" ? "Добро пожаловать! Задай пароль для входа." : "Задай новый пароль.";
    return true;
  } catch {
    authMsg = "Ссылка недействительна или устарела.";
    return false;
  }
}

async function loadKeys(master) {
  keys = { main: await TJCrypto.deriveKeys(master), robot: null };
  robotKey = await TJCrypto.robotKeyFor(master);
  keys.robot = await TJCrypto.deriveKeys(robotKey);
}

async function afterLogin() {
  loadLocal();
  keys = null;
  const saved = store.get(userKey("key"));
  if (saved) {
    try { await loadKeys(saved); } catch { keys = null; }
  }
  if (keys) {
    await decryptAll();
    await enterMain();
    return;
  }
  screen = "loading";
  render();
  try {
    await pull();
  } catch (e) {
    if (e instanceof AuthGone) return;
    screen = "error";
    authMsg = e.message;
    render();
    return;
  }
  // Новый ключ — только для совсем пустого аккаунта; если записи есть, просим существующий.
  pendingKey = rows.size === 0 ? TJCrypto.newMasterKey() : null;
  screen = "key";
  render();
}

async function createKey() {
  const key = pendingKey;
  const k = await TJCrypto.deriveKeys(key);
  const ct = await TJCrypto.encrypt(k, CHECK_RID, { t: "check", v: 2 });
  try {
    // Без перезаписи: если ключ уже создан на другом устройстве, сервер ответит конфликтом.
    await api("/rest/v1/records", { method: "POST", headers: { Prefer: "return=minimal" }, body: [{ rid: CHECK_RID, ct }] });
  } catch (e) {
    if (e instanceof AuthGone) return;
    if (e.status === 409) {
      pendingKey = null;
      await pull().catch(() => {});
      screen = "key";
      render();
      alert("Ключ для этого аккаунта уже создан на другом устройстве. Введи его.");
      return;
    }
    alert(e.message);
    return;
  }
  rows.set(CHECK_RID, ct);
  await loadKeys(key);
  store.set(userKey("key"), key);
  pendingKey = null;
  await enterMain();
}

async function enterKey() {
  const msg = $("keyMsg");
  let key, k;
  try {
    key = TJCrypto.normalizeKey($("keyInput").value);
    k = await TJCrypto.deriveKeys(key);
  } catch (e) { msg.textContent = e.message; return; }
  const check = rows.get(CHECK_RID);
  let fits = false;
  if (check) {
    try { await TJCrypto.decrypt(k, CHECK_RID, check); fits = true; } catch { /* не подошёл */ }
  } else {
    // проверки нет — ключ подходит, если открывает хотя бы одну запись (или записей нет вовсе)
    await loadKeys(key);
    fits = rows.size === 0;
    for (const [rid, ct] of rows) { try { await decryptRecord(rid, ct); fits = true; break; } catch { /* дальше */ } }
  }
  if (!fits) {
    keys = null;
    msg.textContent = "Ключ не подходит к этому аккаунту";
    return;
  }
  await loadKeys(key);
  store.set(userKey("key"), key);
  await decryptAll();
  await enterMain();   // verifyKey при синхронизации восстановит отсутствующую проверку
}

async function enterMain() {
  screen = "main";
  await migrateLegacy();
  render();
  syncNow();
}

/** Сделки из первой версии (без входа) переносим в аккаунт один раз. */
async function migrateLegacy() {
  const legacy = store.get(LEGACY_STORE);
  if (!Array.isArray(legacy) || !legacy.length) return;
  for (const t of legacy) {
    try { await putRecord(TJCrypto.randomRid(), clean({ ...t, t: "trade" })); } catch { /* пропускаем битые */ }
  }
  store.del(LEGACY_STORE);
  flush().catch(() => {});
}

async function logout(everywhere = false, ask = true) {
  if (ask) {
    if (outbox.size && !confirm("Есть изменения, которые ещё не отправлены на сервер. Если выйти, они пропадут. Выйти?")) return;
    if (!confirm(everywhere
      ? "Выйти на всех устройствах? На каждом из них придётся снова войти по паролю."
      : "Выйти? На этом устройстве будут стёрты ключ и сделки. Для входа снова понадобится ключ.")) return;
  }
  const uid = session && session.user && session.user.id;   // запоминаем до запроса: он может обнулить сессию
  // Сессию на сервере закрываем свежим токеном — иначе просроченный токен не даст её отозвать.
  try {
    const token = await freshToken();
    await authCall(everywhere ? "logout?scope=global" : "logout", {}, token);
  } catch { /* нет сети или сессия уже закончилась — всё равно стираем данные на устройстве */ }
  if (uid) for (const n of ["key", "key-prev", "rows", "outbox"]) store.del(`tj-${n}:${uid}`);
  store.del("tj-session");
  session = null; keys = null; robotKey = ""; rows = new Map(); records = new Map(); outbox = new Map();
  tokens = null; newToken = null; keyShown = false;
  screen = "auth"; authMode = "in"; authMsg = "";
  render();
}

// ================================================================ экраны

function render() {
  const main = screen === "main";
  $("tabs").classList.toggle("hidden", !main);
  $("addBtn").classList.toggle("hidden", !(main && tab === "trades"));
  $("title").textContent = !main ? "Дневник сделок" : tab === "trades" ? "Сделки" : tab === "stats" ? "Статистика" : tab === "ai" ? "Аналитик" : "Настройки";
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));

  if (!configured) view.innerHTML = setupHTML();
  else if (screen === "loading") view.innerHTML = `<div class="empty">Загрузка…</div>`;
  else if (screen === "error") view.innerHTML = `<div class="empty"><b>Не удалось связаться с сервером</b>${esc(authMsg)}</div><button class="btn" data-act="retry">Повторить</button>`;
  else if (screen === "auth") view.innerHTML = authHTML();
  else if (screen === "key") view.innerHTML = keyHTML();
  else view.innerHTML = tab === "trades" ? tradesHTML() : tab === "stats" ? statsHTML() : tab === "ai" ? analystHTML() : settingsHTML();
}

function renderStatus() {
  const el = $("status");
  if (el) el.innerHTML = statusHTML();
}

function statusHTML() {
  if (sync.busy) return "Синхронизация…";
  if (keyConflict)
    return `<span class="warn">⚠︎ ${esc(sync.error)}</span><br>
      Если ты менял ключ на другом устройстве — <button class="copy" data-act="use-new-key">введи новый ключ</button>.
      Если не менял — <button class="copy" data-act="restore-check">восстанови проверку своим ключом</button>.`;
  const parts = [];
  if (sync.error) parts.push(`<span class="warn">⚠︎ ${esc(sync.error)}</span>`);
  else if (sync.at) parts.push(`Синхронизировано в ${timeFmt.format(sync.at)}`);
  if (outbox.size) parts.push(`не отправлено: ${outbox.size}`);
  if (sync.bad) parts.push(`<span class="warn">не расшифровано записей: ${sync.bad}</span>`);
  return parts.join(" · ");
}

function setupHTML() {
  if (secretKeyInConfig)
    return `<div class="empty"><b>В config.js вставлен секретный ключ!</b>Это ключ service_role: он обходит все правила доступа. Замени его на публичный (anon / publishable), а секретный ключ в Supabase смени.</div>`;
  return `<div class="empty"><b>Приложение ещё не подключено к базе</b>Владелец должен заполнить файл config.js (адрес и публичный ключ Supabase).</div>`;
}

function authHTML() {
  const head = `<div class="auth"><img src="icon-192.png" alt="">`;
  const foot = `<p class="note warn" id="authMsg">${esc(authMsg)}</p>
    <button class="btn danger" data-act="wipe-device">Стереть данные дневника на этом устройстве</button>
    <p class="note muted">Вход только по приглашению владельца. Сделки шифруются на твоём устройстве: их не видит никто, кроме тебя, — даже владелец приложения.</p>
  </div>`;
  if (authMode === "set") {
    return `${head}<h2 class="center">Пароль для входа</h2>
      <p class="center muted">${esc(linkSession && linkSession.user && linkSession.user.email || "")}</p>
      <form id="authForm" class="card" autocomplete="on">
        <input type="email" class="hidden" autocomplete="username" value="${esc(linkSession && linkSession.user && linkSession.user.email || "")}">
        <div class="row"><input class="full" id="authPass" type="password" placeholder="Пароль: от 10 символов, буквы и цифры" autocomplete="new-password" maxlength="200"></div>
        <div class="row"><input class="full" id="authPass2" type="password" placeholder="Повтори пароль" autocomplete="new-password" maxlength="200"></div>
      </form>
      <button class="btn primary" id="authBtn" data-act="auth">Сохранить пароль</button>${foot}`;
  }
  if (authMode === "reset") {
    return `${head}<h2 class="center">Новый пароль</h2>
      <form id="authForm" class="card" autocomplete="on">
        <div class="row"><input class="full" id="authEmail" type="email" placeholder="Email" autocomplete="username" maxlength="120"></div>
      </form>
      <button class="btn primary" id="authBtn" data-act="auth">Прислать ссылку</button>
      <button class="btn" data-act="mode-in">Назад ко входу</button>${foot}`;
  }
  return `${head}<h2 class="center">Вход</h2>
    <form id="authForm" class="card" autocomplete="on">
      <div class="row"><input class="full" id="authEmail" type="email" placeholder="Email" autocomplete="username" maxlength="120"></div>
      <div class="row"><input class="full" id="authPass" type="password" placeholder="Пароль" autocomplete="current-password" maxlength="200"></div>
    </form>
    <button class="btn primary" id="authBtn" data-act="auth">Войти</button>
    <button class="btn" data-act="mode-reset">Забыл пароль</button>${foot}`;
}

function keyHTML() {
  if (pendingKey) {
    return `<div class="auth">
      <h2>Твой ключ шифрования</h2>
      <p>Им шифруются все твои сделки и заметки. Он нужен, чтобы войти с другого телефона.</p>
      <div class="secret" id="keyBox">${esc(pendingKey)}</div>
      <button class="copy" data-act="copy-key">Скопировать</button>
      <p class="note warn"><b>Сохрани ключ в надёжном месте</b> (менеджер паролей, заметка с паролем). Если его потерять, восстановить сделки не сможет никто — ни ты, ни владелец приложения.</p>
      <div class="card"><label class="check"><input type="checkbox" id="keySaved"> Я сохранил ключ в надёжном месте</label></div>
      <button class="btn primary" id="keyGo" data-act="create-key" disabled>Продолжить</button>
      <button class="btn" data-act="have-key">У меня уже есть ключ</button>
    </div>`;
  }
  return `<div class="auth">
    <h2>Введи ключ шифрования</h2>
    <p>Этот аккаунт уже используется на другом устройстве. Введи ключ, который ты сохранил при первом входе (начинается с tjk_).</p>
    <div class="card"><div class="row"><input class="full" id="keyInput" placeholder="tjk_…" autocomplete="off" autocapitalize="off" spellcheck="false"></div></div>
    <button class="btn primary" data-act="enter-key">Открыть дневник</button>
    <p class="note warn" id="keyMsg"></p>
    <button class="btn" data-act="logout-now">Выйти из аккаунта</button>
  </div>`;
}

function tradesHTML() {
  const list = buildTrades().sort((a, b) => b.date.localeCompare(a.date));
  const status = `<p class="status" id="status">${statusHTML()}</p>`;
  if (!list.length) return status + `<div class="empty"><b>Сделок пока нет</b>Нажми «+», чтобы записать сделку, или подключи MetaTrader в настройках</div>`;
  const rowsHtml = list.map(t => {
    const p = pnlOf(t), r = rOf(t);
    const right = p == null ? `<span class="open">Открыта</span>`
      : `<div class="${cls(p)}" style="font-weight:700">${money(p)}</div>${r != null ? `<div class="muted small">${rFmt(r)}</div>` : ""}`;
    return `<div class="row trade" data-rid="${t.rid}">
      <div><span class="sym">${esc(t.symbol)}</span><span class="badge ${t.isLong ? "long" : "short"}">${t.isLong ? "ЛОНГ" : "ШОРТ"}</span>${t.src === "mt5" ? `<span class="badge src">MT5</span>` : ""}${t.stop == null ? ` <span class="warn">⚠︎</span>` : ""}
        <div class="muted small">${dateFmt.format(new Date(t.date))}</div></div>
      <div class="num">${right}</div></div>`;
  }).join("");
  return status + `<div class="card">${rowsHtml}</div>`;
}

function statsHTML() {
  const from = period === "week" ? Date.now() - 7 * 864e5 : period === "month" ? Date.now() - 30 * 864e5 : 0;
  const s = stats(buildTrades().filter(t => new Date(t.date).getTime() >= from));
  const seg = `<div class="seg">${[["week", "Неделя"], ["month", "Месяц"], ["all", "Всё время"]]
    .map(([k, l]) => `<button data-act="period" data-p="${k}" class="${period === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (!s.count) return seg + `<div class="empty"><b>Нет закрытых сделок</b>Статистика появится, когда закроешь первую сделку за этот период</div>`;
  const row = (l, v, c = "") => `<div class="row"><span>${l}</span><span class="num ${c}">${v}</span></div>`;
  return seg + `
    <div class="card">
      <div class="row" style="display:block"><div class="muted small">Итог</div><div class="big num ${cls(s.net)}" style="text-align:left">${money(s.net)}</div></div>
      ${row("Сделок", s.count)}
      ${s.winRate != null ? row("Винрейт", Math.round(s.winRate * 100) + " %", "muted") : ""}
      ${s.avgR != null ? row("Средний R", rFmt(s.avgR), "muted") : ""}
      ${s.pf != null ? row("Профит-фактор", nf0.format(s.pf), "muted") : ""}
      ${s.avgWin != null ? row("Средняя прибыль", money(s.avgWin), "muted") : ""}
      ${s.avgLoss != null ? row("Средний убыток", money(s.avgLoss), "muted") : ""}
      ${row("Макс. просадка", money(s.maxDD), "muted")}
    </div>
    ${s.count > 1 ? `<div class="section-title">Кривая капитала</div><div class="card" style="padding:12px">${chart(s.equity)}</div>` : ""}
    <div class="section-title">Дисциплина</div>
    <div class="card">
      ${row("Без стопа", s.noStop, s.noStop ? "warn" : "muted")}
      ${row("Не по плану", `${s.offPlanN} · ${money(s.offPlanPnl)}`, cls(s.offPlanPnl))}
      ${s.byEmotion.map(x => row(`${x.e} (${x.n})`, money(x.pnl), cls(x.pnl))).join("")}
    </div>
    <div class="section-title">Выводы</div>
    <div class="card">${s.insights.map(i => `<div class="insight">${esc(i)}</div>`).join("")}</div>`;
}

function chart(values) {
  const W = 600, H = 180, pad = 10;
  const pts = [0, ...values];
  const min = Math.min(0, ...pts), max = Math.max(0, ...pts), span = max - min || 1;
  const x = i => pad + i * (W - 2 * pad) / (pts.length - 1);
  const y = v => H - pad - (v - min) * (H - 2 * pad) / span;
  const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const color = values[values.length - 1] >= 0 ? "var(--green)" : "var(--red)";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)" stroke-dasharray="4 4" stroke-width="1" opacity=".6"/>
    <path d="${line}L${x(pts.length - 1)},${y(0)}L${x(0)},${y(0)}Z" fill="${color}" opacity=".12"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function settingsHTML() {
  if (tokens === null) loadTokens();
  const tokenRows = tokens === null ? `<div class="row muted">Загрузка…</div>`
    : !tokens.length ? `<div class="row muted">Робот ещё не подключён</div>`
    : tokens.map(t => `<div class="row"><div>${esc(t.label || "MetaTrader")}<div class="muted small">создан ${dateFmt.format(new Date(t.created_at))}${t.last_used_at ? ` · последний раз ${dateFmt.format(new Date(t.last_used_at))}` : " · ещё не использовался"}</div></div>
        <button class="copy" style="color:var(--red)" data-act="revoke" data-id="${esc(t.id)}">Отозвать</button></div>`).join("");
  const keyStr = store.get(userKey("key")) || "";
  return `
    <p class="status" id="status">${statusHTML()}</p>
    <div class="section-title">Аккаунт</div>
    <div class="card">
      <div class="row"><span>${esc(session.user.email || "")}</span><button class="copy" data-act="sync">Обновить</button></div>
    </div>

    <div class="section-title">Подключение MetaTrader 5</div>
    <div class="card">${tokenRows}</div>
    ${newToken ? `<div class="card" style="padding:14px 16px">
        <b>Данные для робота</b> — введи их в настройках робота в MT5. Токен показывается один раз.
        <div class="small muted" style="margin-top:8px">Адрес (InpUrl)</div><div class="secret">${esc(cfg.supabaseUrl)}</div>
        <div class="small muted">Публичный ключ (InpAnon)</div><div class="secret">${esc(cfg.supabaseAnonKey)}</div>
        <div class="small muted">Токен (InpToken)</div><div class="secret">${esc(newToken)}</div><button class="copy" data-act="copy" data-v="${esc(newToken)}">Скопировать токен</button>
        <div class="small muted" style="margin-top:8px">Ключ робота (InpKey)</div><div class="secret">${esc(robotKey)}</div><button class="copy" data-act="copy" data-v="${esc(robotKey)}">Скопировать ключ робота</button>
        <p class="note warn">Токен позволяет только отправлять позиции — читать дневник по нему нельзя. Ключ робота открывает только позиции из MetaTrader, но не твои заметки и ручные сделки. Если что-то из этого попало в чужие руки — отзови токен.</p>
      </div>` : ""}
    <button class="btn" data-act="new-token">Подключить MetaTrader (создать токен)</button>
    <button class="btn" data-act="import-report">Загрузить отчёт MT5 (HTML)</button>
    <p class="note muted">Отчёт: в MetaTrader 5 на компьютере — вкладка «История» → правый клик → «Отчёт» → HTML.</p>

    <div class="section-title">Ключ шифрования</div>
    <div class="card" style="padding:14px 16px">
      ${keyShown ? `<div class="secret">${esc(keyStr)}</div><button class="copy" data-act="copy" data-v="${esc(keyStr)}">Скопировать</button>`
        : `<button class="copy" data-act="show-key">Показать ключ</button>`}
      <p class="note muted">Ключ нужен для входа с другого устройства. Без него сделки не восстановить. Роботу MT5 он не нужен — у робота свой ключ.</p>
    </div>

    <div class="section-title">Резервная копия</div>
    <button class="btn" data-act="export">Сохранить копию в файл</button>
    <button class="btn" data-act="import-backup">Загрузить копию из файла</button>
    <p class="note muted">Копия зашифрована твоим ключом: без ключа её не прочитать.</p>

    ${sync.bad ? `<button class="btn danger" data-act="purge-bad">Удалить нечитаемые записи (${sync.bad})</button>` : ""}
    <button class="btn" data-act="logout" style="margin-top:28px">Выйти</button>
    <button class="btn" data-act="logout-all">Выйти на всех устройствах</button>
    <button class="btn danger" data-act="wipe">Удалить все мои данные с сервера</button>`;
}

async function loadTokens() {
  tokens = [];
  try {
    tokens = await api("/rest/v1/sync_tokens?select=id,label,created_at,last_used_at&order=created_at.desc") || [];
  } catch (e) {
    if (e instanceof AuthGone) return;
    sync.error = e.message;
  }
  if (screen === "main" && tab === "settings") render();
}

// ================================================================ действия в настройках

async function createToken() {
  try {
    const label = "MetaTrader · " + new Date().toLocaleDateString("ru-RU");
    const t = await api("/rest/v1/rpc/create_sync_token", { method: "POST", body: { p_label: label } });
    if (typeof t !== "string" || !/^tjs_[0-9a-f]{64}$/.test(t)) throw new Error("Сервер вернул неожиданный ответ");
    newToken = t;
    tokens = null;
    render();
  } catch (e) {
    if (!(e instanceof AuthGone)) alert(e.message);
  }
}

async function revokeToken(id) {
  if (!UUID_RE.test(id) || !confirm("Отозвать токен? Робот с ним перестанет отправлять сделки.")) return;
  try {
    await api(`/rest/v1/sync_tokens?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    newToken = null;
    tokens = null;
    render();
  } catch (e) {
    if (!(e instanceof AuthGone)) alert(e.message);
  }
}

async function wipeAll() {
  if (!confirm("Удалить с сервера ВСЕ твои сделки и токены робота? Это нельзя отменить.")) return;
  if (prompt("Для подтверждения напиши: УДАЛИТЬ") !== "УДАЛИТЬ") return;
  try {
    await api("/rest/v1/records?rid=not.is.null", { method: "DELETE", headers: { Prefer: "return=minimal" } });
    await api("/rest/v1/sync_tokens?id=not.is.null", { method: "DELETE", headers: { Prefer: "return=minimal" } });
  } catch (e) {
    if (!(e instanceof AuthGone)) alert(e.message);
    return;
  }
  for (const n of ["key", "rows", "outbox"]) store.del(userKey(n));
  keys = null; robotKey = ""; rows = new Map(); records = new Map(); outbox = new Map(); tokens = null; newToken = null; keyShown = false;
  alert("Все данные удалены. При следующем входе будет создан новый ключ.");
  await afterLogin();
}

/** Удаляет записи, которые не открываются ни одним ключом (мусор от утёкшего токена). */
async function purgeUnreadable() {
  const bad = [];
  for (const [rid, ct] of rows) {
    if (rid === CHECK_RID) continue;
    try { await decryptRecord(rid, ct); } catch { bad.push(rid); }
  }
  if (!bad.length || !confirm(`Удалить ${bad.length} нечитаемых записей? Их не открывает твой ключ — это мусор или чужие данные.`)) return;
  bad.forEach(removeRecord);
  sync.bad = 0;
  afterLocalChange();
}

/** Стирает всё, что дневник хранит на этом устройстве (для чужого или общего компьютера). */
function wipeDevice() {
  if (!confirm("Стереть с этого устройства ключи, сделки и вход всех аккаунтов дневника?")) return;
  try {
    Object.keys(localStorage).filter(k => k.startsWith("tj-") || k === LEGACY_STORE).forEach(k => localStorage.removeItem(k));
  } catch { /* недоступно */ }
  session = null; keys = null; robotKey = ""; rows = new Map(); records = new Map(); outbox = new Map();
  authMsg = "Данные дневника на этом устройстве стёрты";
  render();
}

/** Копия — это те же зашифрованные записи, что на сервере: без ключа файл бесполезен. */
function exportFile() {
  const data = { app: "trade-journal", version: 3, encrypted: true, rows: [...rows].filter(([rid]) => rid !== CHECK_RID) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `дневник-сделок-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function pickFile(accept) {
  return new Promise(resolve => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = accept;
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
}

async function importBackup() {
  const file = await pickFile("application/json,.json");
  if (!file) return;
  if (file.size > 20e6) return alert("Файл слишком большой");
  let added = 0, foreign = 0;
  try {
    const data = JSON.parse(await file.text());
    if (data.encrypted && Array.isArray(data.rows)) {
      for (const item of data.rows) {
        const [rid, ct] = Array.isArray(item) ? item : [];
        if (!RID_RE.test(rid) || rid === CHECK_RID || typeof ct !== "string" || ct.length > 16384 || rows.has(rid)) continue;
        try {
          records.set(rid, await decryptRecord(rid, ct));   // принимаем только записи, которые открывает наш ключ
          rows.set(rid, ct);
          outbox.set(rid, ct);
          added++;
        } catch { foreign++; }
      }
      saveLocal();
    } else {
      // старый формат первой версии (без входа и шифрования)
      const list = Array.isArray(data) ? data : data.trades;
      if (!Array.isArray(list)) throw new Error();
      for (const t of list) {
        try { await putRecord(TJCrypto.randomRid(), clean({ ...t, t: "trade" })); added++; } catch { /* пропуск */ }
      }
    }
  } catch {
    return alert("Это не файл дневника сделок");
  }
  afterLocalChange();
  alert(`Загружено записей: ${added}` + (foreign ? `. Не подошли к твоему ключу: ${foreign}` : ""));
}

// ================================================================ импорт отчёта MetaTrader 5 (HTML)

async function importReport() {
  const file = await pickFile(".html,.htm,text/html");
  if (!file) return;
  if (file.size > 30e6) return alert("Файл слишком большой");
  let parsed;
  try {
    parsed = parseMt5Report(await file.arrayBuffer());
  } catch (e) {
    return alert(e.message);
  }
  let added = 0, skipped = 0;
  for (const p of parsed.positions) {
    const rid = await TJCrypto.rid(keys.robot, `mt5:${parsed.account}:${p.pos}`);   // тот же id, что у робота
    if (records.has(rid)) { skipped++; continue; }
    await putRecord(rid, { t: "mt5", account: parsed.account, ...p });
    added++;
  }
  afterLocalChange();
  alert(`Счёт ${parsed.account}: добавлено сделок ${added}${skipped ? `, уже были в дневнике ${skipped}` : ""}.`);
}

/** Разбирает отчёт «История торговли» из MetaTrader 5 (HTML, обычно в UTF-16). Берёт таблицу позиций. */
function parseMt5Report(buf) {
  const bytes = new Uint8Array(buf);
  const utf16 = (bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes.length > 3 && bytes[1] === 0 && bytes[3] === 0);
  const html = new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bytes);
  // DOMParser не выполняет скрипты и не загружает ресурсы: безопасно для чужого файла.
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = doc.body ? doc.body.textContent : "";
  const acc = text.match(/(?:Account|Счёт|Счет)\s*:?\s*(\d{3,12})/i);
  if (!acc) throw new Error("Не нашёл номер счёта в отчёте. Нужен отчёт «История торговли» из MetaTrader 5 в формате HTML.");
  const numCell = s => num(String(s).replace(/\s/g, ""));
  const timeCell = s => {
    const m = String(s).match(/(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))).toISOString() : null;
  };
  const positions = [];
  for (const tr of doc.querySelectorAll("tr")) {
    const cells = [...tr.querySelectorAll("td")].map(td => td.textContent.trim()).filter((c, i, a) => !(c === "" && i === a.length - 1));
    if (cells.length < 13) continue;
    const [openT, pos, symbol, type, vol, open, sl, , closeT, close, commission, swap, profit] = cells;
    if (!/^\d+$/.test(pos) || !/^(buy|sell)$/i.test(type) || numCell(vol) == null) continue;
    const date = timeCell(openT), closeDate = timeCell(closeT);
    if (!date || !closeDate) continue;
    positions.push({
      pos, symbol: symbol.slice(0, 40), isLong: /^buy$/i.test(type), entry: numCell(open), exit: numCell(close),
      stop: numCell(sl) || null, qty: numCell(vol),
      profit: (numCell(profit) || 0) + (numCell(commission) || 0) + (numCell(swap) || 0),
      riskMoney: null, date, closeDate, open: false,
    });
  }
  if (!positions.length) throw new Error("В отчёте не нашлось закрытых позиций.");
  return { account: acc[1], positions };
}

// ================================================================ форма сделки

const form = $("form"), sheet = $("sheet"), sheetBg = $("sheetBg");
const f = name => form.elements[name];
const localISO = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
const PRICE_FIELDS = ["entry", "stop", "exit", "qty", "fees"];

function openForm(t) {
  editing = t ? { rid: t.rid, src: t.src } : null;
  const mt5 = !!t && t.src === "mt5";
  $("sheetTitle").textContent = t ? "Сделка" : "Новая сделка";
  $("deleteBtn").textContent = mt5 ? "Скрыть сделку" : "Удалить сделку";
  $("deleteBtn").classList.toggle("hidden", !t);
  $("mt5Note").classList.toggle("hidden", !mt5);
  $("qtyLabel").textContent = mt5 ? "Объём, лоты" : "Объём";
  $("feesRow").classList.toggle("hidden", mt5);
  f("symbol").value = t ? t.symbol : "";
  f("date").value = localISO(t ? new Date(t.date) : new Date());
  for (const k of PRICE_FIELDS) f(k).value = t && t[k] != null ? String(t[k]).replace(".", ",") : "";
  for (const k of ["symbol", "date", ...PRICE_FIELDS]) f(k).readOnly = mt5;
  document.querySelectorAll("#dirSeg button").forEach(b => { b.disabled = mt5; });
  setLong(t ? t.isLong : true);
  f("setup").value = t ? t.setup : "";
  f("emotion").value = t ? t.emotion : "Спокоен";
  f("plan").checked = t ? t.plan : true;
  f("notes").value = t ? t.notes : "";
  updatePreview();
  sheetBg.classList.add("show");
  sheet.classList.add("show");
  sheet.setAttribute("aria-hidden", "false");
  sheet.scrollTop = 0;
}

function closeForm() {
  sheetBg.classList.remove("show");
  sheet.classList.remove("show");
  sheet.setAttribute("aria-hidden", "true");
  editing = null;
}

function setLong(v) {
  formLong = v;
  document.querySelectorAll("#dirSeg button").forEach(b => b.classList.toggle("on", (b.dataset.long === "1") === v));
  updatePreview();
}

function draft() {
  return { symbol: f("symbol").value.trim().toUpperCase(), isLong: formLong, entry: num(f("entry").value),
    stop: num(f("stop").value), exit: num(f("exit").value), qty: num(f("qty").value), fees: num(f("fees").value) || 0 };
}

function currentTrade() {
  return editing ? buildTrades().find(t => t.rid === editing.rid) : null;
}

function updatePreview() {
  const mt5 = editing && editing.src === "mt5";
  const d = mt5 ? currentTrade() : draft();
  const valid = mt5 || (d.symbol && d.entry > 0 && d.qty > 0);
  $("saveBtn").disabled = !valid;
  let warn = "";
  if (d && d.entry > 0) {
    if (d.stop == null) warn = "⚠︎ Сделка без стопа: риск не ограничен";
    else if (stopWrongSide(d.entry, d.stop, d.isLong)) warn = d.isLong ? "⚠︎ Для лонга стоп должен быть ниже входа" : "⚠︎ Для шорта стоп должен быть выше входа";
  }
  $("stopWarn").textContent = warn;
  let html = "";
  if (valid && d) {
    const t = mt5 ? d : { ...d, src: "manual" };
    const risk = riskOf(t), p = pnlOf(t);
    const out = [];
    if (risk) out.push(`<div class="row"><span>Риск до стопа</span><span class="num">${money(-risk)}</span></div>`);
    if (p != null) out.push(`<div class="row"><span>Результат</span><span class="num ${cls(p)}">${money(p)}</span></div>`);
    if (p != null && risk) out.push(`<div class="row"><span>В R</span><span class="num">${rFmt(p / risk)}</span></div>`);
    if (out.length) html = `<div class="section-title">Расчёт</div><div class="card">${out.join("")}</div>`;
  }
  $("preview").innerHTML = html;
}

const annotation = () => ({ setup: f("setup").value.trim().slice(0, 200), emotion: emotionOf(f("emotion").value),
  plan: f("plan").checked, notes: f("notes").value.slice(0, 4000) });

async function save() {
  if (!keys) return;
  if (editing && editing.src === "mt5") {
    const ref = editing.rid;
    await putRecord(await TJCrypto.rid(keys.main, "ann:" + ref), { t: "ann", ref, ...annotation(), hidden: false });
  } else {
    const d = draft();
    if (!(d.symbol && d.entry > 0 && d.qty > 0)) return;
    const rid = editing ? editing.rid : TJCrypto.randomRid();
    const date = new Date(f("date").value || Date.now());
    await putRecord(rid, { t: "trade", ...d, date: (isNaN(date) ? new Date() : date).toISOString(), ...annotation() });
  }
  closeForm();
  afterLocalChange();
}

async function removeCurrent() {
  if (!editing) return;
  if (editing.src === "mt5") {
    if (!confirm("Скрыть сделку из дневника? Она останется в MetaTrader.")) return;
    const ref = editing.rid;
    await putRecord(await TJCrypto.rid(keys.main, "ann:" + ref), { t: "ann", ref, ...annotation(), hidden: true });
  } else {
    if (!confirm("Удалить сделку?")) return;
    removeRecord(editing.rid);
  }
  closeForm();
  afterLocalChange();
}

// ================================================================ события

$("tabs").onclick = e => {
  const b = e.target.closest("button");
  if (!b) return;
  tab = b.dataset.tab;
  if (tab !== "settings") { newToken = null; keyShown = false; }
  render();
  if (tab === "ai") analystOpened();
  scrollTo(0, 0);
};

$("addBtn").onclick = () => openForm(null);

view.addEventListener("submit", e => { e.preventDefault(); if (e.target.id === "authForm") doAuth(); });
view.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if (["authEmail", "authPass", "authPass2"].includes(e.target.id)) { e.preventDefault(); doAuth(); }
  if (e.target.id === "keyInput") { e.preventDefault(); enterKey(); }
  if (e.target.id === "aiSymbol") { e.preventDefault(); runAnalysis(); }
});
view.addEventListener("change", e => {
  if (e.target.id === "keySaved") $("keyGo").disabled = !e.target.checked;
});

view.onclick = e => {
  const row = e.target.closest(".trade");
  if (row) { const t = buildTrades().find(x => x.rid === row.dataset.rid); if (t) openForm(t); return; }
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const actions = {
    "mode-in": () => { authMode = "in"; authMsg = ""; render(); },
    "mode-reset": () => { authMode = "reset"; authMsg = ""; render(); },
    "auth": doAuth,
    "copy-key": () => copy(pendingKey),
    "create-key": createKey,
    "enter-key": enterKey,
    "logout-now": () => logout(false, false),
    "retry": afterLogin,
    "period": () => { period = el.dataset.p; render(); },
    "sync": syncNow,
    "new-token": createToken,
    "revoke": () => revokeToken(el.dataset.id),
    "copy": () => copy(el.dataset.v),
    "show-key": () => { if (confirm("Показать ключ? Убедись, что экран никто не видит.")) { keyShown = true; render(); } },
    "export": exportFile,
    "import-backup": importBackup,
    "import-report": importReport,
    "logout": () => logout(false),
    "logout-all": () => logout(true),
    "use-new-key": useNewKey,
    "restore-check": restoreCheck,
    "have-key": () => { pendingKey = null; render(); },
    "purge-bad": purgeUnreadable,
    "wipe-device": wipeDevice,
    "wipe": wipeAll,
    ...analystActions(el),
  };
  if (actions[act]) Promise.resolve(actions[act]()).catch(err => { if (!(err instanceof AuthGone)) alert(err.message || "Ошибка"); });
};

function copy(v) {
  if (!v) return;
  navigator.clipboard.writeText(v).then(() => alert("Скопировано"), () => alert("Не удалось скопировать — выдели текст вручную"));
}

$("dirSeg").onclick = e => { const b = e.target.closest("button"); if (b && !b.disabled) setLong(b.dataset.long === "1"); };
form.oninput = updatePreview;
form.onsubmit = e => { e.preventDefault(); save(); };
$("saveBtn").onclick = () => save().catch(e => alert(e.message));
$("cancelBtn").onclick = closeForm;
sheetBg.onclick = closeForm;
$("deleteBtn").onclick = () => removeCurrent().catch(e => alert(e.message));

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncNow(); });
// Ссылку из письма могут открыть во вкладке, где приложение уже запущено, — страница тогда не перезагружается.
window.addEventListener("hashchange", async () => {
  if (configured && await readLinkFromAddress()) { closeForm(); screen = "auth"; render(); }
});
setInterval(() => { if (document.visibilityState === "visible") syncNow(); }, 60_000);

// ================================================================ старт

(async () => {
  if (!configured) { screen = "setup"; render(); return; }
  if (await readLinkFromAddress()) { screen = "auth"; render(); return; }
  if (!session) { screen = "auth"; render(); return; }
  try {
    await afterLogin();
  } catch (e) {
    if (!(e instanceof AuthGone)) { screen = "error"; authMsg = e.message; render(); }
  }
})();

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
