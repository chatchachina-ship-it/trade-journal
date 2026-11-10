// Свечи и индикаторы. Без зависимостей: работает и в Deno (Supabase), и в Node (тесты).

export type Market = "crypto" | "gold" | "forex" | "stocks";
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

export const HORIZONS: Record<string, number> = { "4h": 4, "1d": 24, "3d": 72, "1w": 168 };

/** Проверяет тикер и переводит его в формат источника. Возвращает null для недопустимого ввода. */
export function normalizeSymbol(market: Market, raw: string): { source: "binance" | "yahoo"; symbol: string; label: string } | null {
  const s = String(raw || "").trim().toUpperCase().replace(/[\s/_-]/g, "");
  if (market === "crypto") {
    if (!/^[A-Z0-9]{2,15}$/.test(s)) return null;
    const sym = /USDT$|USDC$/.test(s) ? s : s + "USDT";
    return { source: "binance", symbol: sym, label: sym };
  }
  if (market === "gold") {
    if (!["XAUUSD", "GOLD", "XAU", "GC"].includes(s)) {
      if (["XAGUSD", "SILVER", "XAG"].includes(s)) return { source: "yahoo", symbol: "SI=F", label: "XAGUSD" };
      return null;
    }
    return { source: "yahoo", symbol: "GC=F", label: "XAUUSD" };
  }
  if (market === "forex") {
    if (!/^[A-Z]{6}$/.test(s)) return null;
    return { source: "yahoo", symbol: s + "=X", label: s };
  }
  if (market === "stocks") {
    if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(s)) return null;
    return { source: "yahoo", symbol: s.replace(".", "-"), label: s };
  }
  return null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function getJSON(fetchFn: Fetch, url: string): Promise<any> {
  let err: unknown;
  for (let i = 0; i < 3; i++) {
    // Yahoo иногда рвёт соединение: повтор, со второй попытки — через зеркало query2.
    const u = i ? url.replace("//query1.", "//query2.") : url;
    try {
      const r = await fetchFn(u, { headers: { "User-Agent": "Mozilla/5.0 (trade-journal analyst)" }, signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.json();
      err = new Error(`источник цен ответил ${r.status}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { err = e; }
    await new Promise(res => setTimeout(res, 400 * (i + 1)));
  }
  throw err;
}

async function binance(fetchFn: Fetch, symbol: string, interval: string, limit: number, startMs?: number): Promise<Bar[]> {
  const q = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (startMs) q.set("startTime", String(startMs));
  try {
    const d = await getJSON(fetchFn, `https://fapi.binance.com/fapi/v1/klines?${q}`);
    return d.map((k: any[]) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  } catch (e) {
    // Binance закрыт для некоторых регионов — запасной источник Bybit.
    const bi: Record<string, string> = { "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
    const bq = new URLSearchParams({ category: "linear", symbol, interval: bi[interval], limit: String(Math.min(limit, 1000)) });
    if (startMs) bq.set("start", String(startMs));
    const d = await getJSON(fetchFn, `https://api.bybit.com/v5/market/kline?${bq}`);
    const list = d?.result?.list;
    if (!Array.isArray(list) || !list.length) throw e;
    return list.map((k: string[]) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).reverse();
  }
}

async function yahoo(fetchFn: Fetch, symbol: string, interval: string, range: string, period1?: number): Promise<Bar[]> {
  const q = new URLSearchParams({ interval, includePrePost: "false" });
  if (period1) { q.set("period1", String(Math.floor(period1 / 1000))); q.set("period2", String(Math.floor(Date.now() / 1000))); }
  else q.set("range", range);
  const d = await getJSON(fetchFn, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`);
  const r = d?.chart?.result?.[0];
  if (!r || !Array.isArray(r.timestamp)) throw new Error("нет данных по тикеру");
  const qq = r.indicators.quote[0];
  const out: Bar[] = [];
  r.timestamp.forEach((ts: number, i: number) => {
    const o = qq.open[i], h = qq.high[i], l = qq.low[i], c = qq.close[i];
    if ([o, h, l, c].every(x => typeof x === "number" && Number.isFinite(x))) out.push({ t: ts * 1000, o, h, l, c, v: qq.volume?.[i] || 0 });
  });
  return out;
}

/** Склеивает часовые бары в бары по n часов (для 4h у Yahoo). */
export function aggregate(bars: Bar[], hours: number): Bar[] {
  const ms = hours * 36e5, out: Bar[] = [];
  for (const b of bars) {
    const t = Math.floor(b.t / ms) * ms, last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
    else out.push({ ...b, t });
  }
  return out;
}

export async function loadFrames(fetchFn: Fetch, src: { source: string; symbol: string }): Promise<Record<string, Bar[]>> {
  if (src.source === "binance") {
    const [m15, h1, h4, d1] = await Promise.all([
      binance(fetchFn, src.symbol, "15m", 300), binance(fetchFn, src.symbol, "1h", 300),
      binance(fetchFn, src.symbol, "4h", 300), binance(fetchFn, src.symbol, "1d", 300)]);
    return { "15m": m15, "1h": h1, "4h": h4, "1d": d1 };
  }
  const [m15, h1, d1] = await Promise.all([
    yahoo(fetchFn, src.symbol, "15m", "30d"), yahoo(fetchFn, src.symbol, "60m", "180d"), yahoo(fetchFn, src.symbol, "1d", "2y")]);
  return { "15m": m15.slice(-300), "1h": h1.slice(-300), "4h": aggregate(h1, 4).slice(-300), "1d": d1.slice(-300) };
}

/** Часовые свечи с момента прогноза — для проверки, сбылся ли он. */
export async function candlesSince(fetchFn: Fetch, src: { source: string; symbol: string }, fromMs: number, hours: number): Promise<Bar[]> {
  const bars = src.source === "binance"
    ? await binance(fetchFn, src.symbol, "1h", Math.min(hours + 2, 1000), fromMs)
    : await yahoo(fetchFn, src.symbol, "60m", "", fromMs - 36e5);
  // Бар, в котором был сделан прогноз, частично относится к прошлому: берём только бары, начавшиеся после.
  return bars.filter(b => b.t >= fromMs && b.t < fromMs + hours * 36e5);
}

// ---------------------------------------------------------------- индикаторы

export function ema(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(values: number[], n = 14): number | null {
  if (values.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = values[i] - values[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

export function atr(bars: Bar[], n = 14): number | null {
  if (bars.length <= n) return null;
  const tr = bars.slice(1).map((b, i) => Math.max(b.h - b.l, Math.abs(b.h - bars[i].c), Math.abs(b.l - bars[i].c)));
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

/** Локальные экстремумы (фракталы по k баров с каждой стороны), ближайшие к цене. */
export function swings(bars: Bar[], k = 3): { highs: number[]; lows: number[] } {
  const highs: number[] = [], lows: number[] = [];
  for (let i = k; i < bars.length - k; i++) {
    const w = bars.slice(i - k, i + k + 1);
    if (w.every(b => b.h <= bars[i].h)) highs.push(bars[i].h);
    if (w.every(b => b.l >= bars[i].l)) lows.push(bars[i].l);
  }
  return { highs, lows };
}

const round = (x: number | null, p: number) => x == null ? null : Number(x.toPrecision(p));

export function summarize(frames: Record<string, Bar[]>) {
  const out: Record<string, unknown> = {};
  for (const [tf, bars] of Object.entries(frames)) {
    if (bars.length < 30) continue;
    const c = bars.map(b => b.c), last = bars[bars.length - 1], price = last.c;
    const sw = swings(bars.slice(-150));
    const above = [...new Set(sw.highs.filter(x => x > price))].sort((a, b) => a - b).slice(0, 3);
    const below = [...new Set(sw.lows.filter(x => x < price))].sort((a, b) => b - a).slice(0, 3);
    const recent = bars.slice(-20);
    const vol = recent.reduce((s, b) => s + b.v, 0) / 20, volPrev = bars.slice(-40, -20).reduce((s, b) => s + b.v, 0) / 20;
    out[tf] = {
      close: round(price, 7), ema20: round(ema(c, 20), 7), ema50: round(ema(c, 50), 7), ema200: round(ema(c, 200), 7),
      rsi14: round(rsi(c), 3), atr14: round(atr(bars), 5),
      high20: round(Math.max(...recent.map(b => b.h)), 7), low20: round(Math.min(...recent.map(b => b.l)), 7),
      resistance: above.map(x => round(x, 7)), support: below.map(x => round(x, 7)),
      volume_change_pct: volPrev > 0 ? Math.round((vol / volPrev - 1) * 100) : null,
      change_pct_20: Math.round((price / bars[bars.length - 21].c - 1) * 10000) / 100,
      last_bars: bars.slice(-12).map(b => [new Date(b.t).toISOString().slice(0, 16), round(b.o, 7), round(b.h, 7), round(b.l, 7), round(b.c, 7)]),
    };
  }
  return out;
}

/** Ожидаемый ход цены за горизонт: часовой ATR × √часов. Нужен, чтобы отсеять фантастические цели. */
export function expectedMove(frames: Record<string, Bar[]>, hours: number): number {
  const a = atr(frames["1h"]) ?? (atr(frames["1d"]) ?? 0) / Math.sqrt(24);
  return a * Math.sqrt(hours);
}

// ---------------------------------------------------------------- проверка ответа модели

export type Forecast = {
  bias: "up" | "down" | "flat";
  summary: string;
  up: { probability: number; target: number; reason: string };
  down: { probability: number; target: number; reason: string };
  flat: { probability: number; reason: string };
  levels: { price: number; kind: "support" | "resistance"; note: string }[];
  news: { title: string; url: string; impact: "bullish" | "bearish" | "neutral" }[];
  risks: string;
};

/** Возвращает список ошибок (пустой — всё в порядке) и приводит прогноз к безопасной форме. */
export function validate(f: Forecast, price: number, move: number, sourceUrls: Set<string>): { errors: string[]; clean: Forecast } {
  const errors: string[] = [];
  const P = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? Math.round(x) : NaN;
  const pu = P(f?.up?.probability), pd = P(f?.down?.probability), pf = P(f?.flat?.probability);
  if ([pu, pd, pf].some(x => !(x >= 0 && x <= 100))) errors.push("вероятности должны быть от 0 до 100");
  else if (pu + pd + pf !== 100) errors.push(`сумма вероятностей ${pu + pd + pf}, а должна быть 100`);
  const tu = f?.up?.target, td = f?.down?.target;
  if (!(typeof tu === "number" && tu > price)) errors.push(`цель роста должна быть выше текущей цены ${price}`);
  if (!(typeof td === "number" && td < price)) errors.push(`цель падения должна быть ниже текущей цены ${price}`);
  if (move > 0) {
    for (const [name, t] of [["роста", tu], ["падения", td]] as const) {
      if (typeof t !== "number") continue;
      const k = Math.abs(t - price) / move;
      if (k < 0.25 || k > 4) errors.push(`цель ${name} ${t} нереалистична: ожидаемый ход за горизонт ≈ ${move.toPrecision(4)}, цель должна быть в пределах 0.25–4 таких ходов`);
    }
  }
  if (!["up", "down", "flat"].includes(f?.bias)) errors.push("bias: up, down или flat");
  const txt = (s: unknown, n: number) => typeof s === "string" ? s.slice(0, n) : "";
  const news = (Array.isArray(f?.news) ? f.news : [])
    .filter(n => typeof n?.url === "string" && sourceUrls.has(n.url) && /^https:\/\//.test(n.url))   // только то, что реально нашёл поиск
    .slice(0, 5).map(n => ({ title: txt(n.title, 160), url: n.url.slice(0, 400), impact: ["bullish", "bearish", "neutral"].includes(n.impact) ? n.impact : "neutral" }));
  const levels = (Array.isArray(f?.levels) ? f.levels : [])
    .filter(l => typeof l?.price === "number" && Number.isFinite(l.price) && l.price > 0).slice(0, 6)
    .map(l => ({ price: l.price, kind: l.kind === "resistance" ? "resistance" : "support", note: txt(l.note, 120) })) as Forecast["levels"];
  return {
    errors,
    clean: {
      bias: f?.bias, summary: txt(f?.summary, 900),
      up: { probability: pu, target: tu, reason: txt(f?.up?.reason, 400) },
      down: { probability: pd, target: td, reason: txt(f?.down?.reason, 400) },
      flat: { probability: pf, reason: txt(f?.flat?.reason, 300) },
      levels, news, risks: txt(f?.risks, 500),
    },
  };
}

export const FORECAST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bias", "summary", "up", "down", "flat", "levels", "news", "risks"],
  properties: {
    bias: { type: "string", enum: ["up", "down", "flat"] },
    summary: { type: "string", description: "3–5 предложений по-русски: что происходит и почему такой расклад" },
    up: { type: "object", additionalProperties: false, required: ["probability", "target", "reason"], properties: {
      probability: { type: "integer", description: "вероятность в %, что цель роста будет достигнута раньше цели падения в пределах горизонта" },
      target: { type: "number" }, reason: { type: "string" } } },
    down: { type: "object", additionalProperties: false, required: ["probability", "target", "reason"], properties: {
      probability: { type: "integer" }, target: { type: "number" }, reason: { type: "string" } } },
    flat: { type: "object", additionalProperties: false, required: ["probability", "reason"], properties: {
      probability: { type: "integer", description: "вероятность в %, что за горизонт не будет достигнута ни одна цель" },
      reason: { type: "string" } } },
    levels: { type: "array", items: { type: "object", additionalProperties: false, required: ["price", "kind", "note"], properties: {
      price: { type: "number" }, kind: { type: "string", enum: ["support", "resistance"] }, note: { type: "string" } } } },
    news: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "url", "impact"], properties: {
      title: { type: "string" }, url: { type: "string" }, impact: { type: "string", enum: ["bullish", "bearish", "neutral"] } } } },
    risks: { type: "string" },
  },
};

// ---------------------------------------------------------------- прогноз по формулам (без ИИ)

/** Бесплатный запасной аналитик: тренд по EMA и RSI на 1h/4h/1d, цели у ближайших уровней, вероятности
 *  из силы тренда и расстояния до целей. Всегда проходит validate(). */
export function ruleForecast(frames: Record<string, Bar[]>, price: number, move: number): Forecast {
  const tfs = ["1h", "4h", "1d"].filter(tf => (frames[tf]?.length ?? 0) >= 50);
  const notes: string[] = [];
  let score = 0, n = 0;
  for (const tf of tfs) {
    const c = frames[tf].map(b => b.c);
    const e20 = ema(c, 20)!, e50 = ema(c, 50)!, r = rsi(c) ?? 50;
    let s = (price > e20 ? 1 : -1) + (price > e50 ? 1 : -1) + (e20 > e50 ? 1 : -1);
    s += r > 70 ? -1 : r < 30 ? 1 : r > 55 ? 0.5 : r < 45 ? -0.5 : 0;   // перекупленность гасит рост, перепроданность — падение
    score += s / 3.5; n++;
    notes.push(`${tf}: цена ${price > e50 ? "выше" : "ниже"} EMA50, EMA20 ${e20 > e50 ? "выше" : "ниже"} EMA50, RSI ${Math.round(r)}`);
  }
  score = n ? score / n : 0;   // от −1 (сильно вниз) до +1 (сильно вверх)

  const lv = (kind: "resistance" | "support") => {
    const out: { price: number; tf: string }[] = [];
    for (const tf of tfs) {
      const sw = swings(frames[tf].slice(-150));
      for (const x of kind === "resistance" ? sw.highs : sw.lows) out.push({ price: x, tf });
    }
    return out.filter(l => kind === "resistance" ? l.price > price : l.price < price)
      .map(l => ({ ...l, k: Math.abs(l.price - price) / move })).sort((a, b) => a.k - b.k);
  };
  const pick = (kind: "resistance" | "support") => {
    const all = lv(kind), inRange = all.find(l => l.k >= 0.6 && l.k <= 2.5);
    return { all, best: inRange ?? null };
  };
  const res = pick("resistance"), sup = pick("support");
  const up = res.best?.price ?? price + move, down = sup.best?.price ?? price - move;
  const ku = (up - price) / move, kd = (price - down) / move;

  const flat = Math.max(10, Math.min(45, Math.round(20 + 15 * ((ku + kd) / 2 - 1))));
  const wu = (1 + 0.6 * score) / ku, wd = (1 - 0.6 * score) / kd;
  let pu = Math.round((100 - flat) * wu / (wu + wd));
  pu = Math.max(5, Math.min(90 - flat, pu));
  const pd = 100 - flat - pu;
  const bias = Math.max(pu, pd, flat) === flat ? "flat" : pu >= pd ? "up" : "down";
  const strength = Math.abs(score) > 0.6 ? "сильный" : Math.abs(score) > 0.25 ? "умеренный" : "слабый";
  const dir = score > 0.1 ? "восходящий" : score < -0.1 ? "нисходящий" : "боковой";
  const levels = [
    ...res.all.slice(0, 3).map(l => ({ price: round(l.price, 7)!, kind: "resistance" as const, note: `локальный максимум ${l.tf}` })),
    ...sup.all.slice(0, 3).map(l => ({ price: round(l.price, 7)!, kind: "support" as const, note: `локальный минимум ${l.tf}` })),
  ];
  return {
    bias, summary: `Расчёт по формулам, без ИИ и без новостей. Тренд ${dir}, ${strength} (${notes.join("; ")}). Ожидаемый ход за горизонт ≈ ${move.toPrecision(4)}.`,
    up: { probability: pu, target: round(up, 7)!, reason: res.best ? `ближайшее сопротивление (${res.best.tf})` : "один ожидаемый ход вверх (ATR)" },
    down: { probability: pd, target: round(down, 7)!, reason: sup.best ? `ближайшая поддержка (${sup.best.tf})` : "один ожидаемый ход вниз (ATR)" },
    flat: { probability: flat, reason: "цели дальше обычного хода за горизонт — выше шанс остаться в диапазоне" },
    levels, news: [], risks: "Формула не знает о новостях и событиях: перед отчётами и данными по ставкам прогноз ненадёжен.",
  } as Forecast;
}
