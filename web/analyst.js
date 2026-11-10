"use strict";
// ИИ-аналитик: запрос прогноза у серверной функции, хранение прогнозов (зашифрованы, как сделки)
// и автоматическая проверка точности по свечам после горизонта.
// Использует общие функции и состояние из app.js (они объявлены в общей области видимости страницы).

const AI_MARKETS = { crypto: "Крипта", gold: "Золото", forex: "Форекс", stocks: "Акции США" };
const AI_HORIZONS = { "4h": ["4 часа", 4], "1d": ["1 день", 24], "3d": ["3 дня", 72], "1w": ["Неделя", 168] };
const AI_HINT = { crypto: "BTCUSDT, ETH, SOL…", gold: "XAUUSD или XAGUSD", forex: "EURUSD, GBPJPY…", stocks: "AAPL, TSLA, NVDA…" };
const ai = { market: "crypto", horizon: "1d", symbol: "", busy: false, msg: "", left: null, open: null, scoring: false };

const finPos = v => typeof v === "number" && Number.isFinite(v) ? v : null;
const scen = (o, withTarget) => ({ probability: Math.max(0, Math.min(100, Math.round(fin(o?.probability) ?? 0))),
  ...(withTarget ? { target: finPos(o?.target) } : {}), reason: str(o?.reason, 400) });

/** Прогноз из базы — недоверенные данные: приводим к ожидаемой форме. */
function cleanForecast(o) {
  const outcome = ["up", "down", "flat", "unclear"].includes(o.result?.outcome) ? o.result.outcome : null;
  return {
    t: "forecast", label: str(o.label, 20), market: AI_MARKETS[o.market] ? o.market : "crypto",
    horizon: AI_HORIZONS[o.horizon] ? o.horizon : "1d", at: fin(o.at) ?? 0, price: fin(o.price), move: fin(o.move),
    engine: o.engine === "formula" ? "formula" : "ai",
    bias: ["up", "down", "flat"].includes(o.bias) ? o.bias : "flat", summary: str(o.summary, 900),
    up: scen(o.up, true), down: scen(o.down, true), flat: scen(o.flat, false), risks: str(o.risks, 500),
    levels: (Array.isArray(o.levels) ? o.levels : []).slice(0, 6).filter(l => fin(l?.price) != null)
      .map(l => ({ price: l.price, kind: l.kind === "resistance" ? "resistance" : "support", note: str(l.note, 120) })),
    news: (Array.isArray(o.news) ? o.news : []).slice(0, 5).filter(n => typeof n?.url === "string" && /^https:\/\/[^\s"'<>]+$/.test(n.url))
      .map(n => ({ title: str(n.title, 160), url: n.url.slice(0, 400), impact: ["bullish", "bearish"].includes(n.impact) ? n.impact : "neutral" })),
    result: outcome ? { outcome, checkedAt: fin(o.result.checkedAt) ?? 0, hitAt: fin(o.result.hitAt) } : null,
  };
}

const forecasts = () => [...records].filter(([, r]) => r.t === "forecast").map(([rid, r]) => ({ ...r, rid })).sort((a, b) => b.at - a.at);
const hoursOf = f => AI_HORIZONS[f.horizon][1];
const priceFmt = v => v == null ? "—" : new Intl.NumberFormat("ru-RU", { maximumSignificantDigits: 7 }).format(v);
const pctFrom = (v, p) => p ? ((v / p - 1) * 100).toFixed(2).replace(".", ",") + "%" : "";
const OUT_NAME = { up: "дошла до цели роста", down: "дошла до цели падения", flat: "осталась в диапазоне", unclear: "обе цели в одном часе — не засчитано" };

/** Brier: 0 — идеально, 0,667 — как подбрасывать монетку на три исхода. Меньше — лучше. */
function brier(f) {
  const o = f.result.outcome;
  return ["up", "down", "flat"].reduce((s, k) => s + (f[k].probability / 100 - (k === o ? 1 : 0)) ** 2, 0);
}
const topOf = f => ["up", "down", "flat"].reduce((a, k) => f[k].probability > f[a].probability ? k : a, "up");

async function aiCall(body) {
  return api("/functions/v1/analyst", { method: "POST", body });
}

function analystOpened() {
  aiCall({ op: "left", market: "crypto", symbol: "BTC" }).then(d => { ai.left = d?.left ?? null; if (tab === "ai") render(); }, () => {});
  scoreForecasts();
}

async function runAnalysis() {
  if (ai.busy) return;
  const input = $("aiSymbol");
  ai.symbol = (input ? input.value : ai.symbol).trim();
  if (!ai.symbol) { ai.msg = "Введи тикер"; render(); return; }
  ai.busy = true; ai.msg = ""; render();
  try {
    const d = await aiCall({ op: "analyze", market: ai.market, symbol: ai.symbol, horizon: ai.horizon });
    const f = cleanForecast({ ...d.forecast, t: "forecast", label: d.label, market: d.market, horizon: d.horizon, at: d.at, price: d.price, move: d.move, engine: d.engine });
    const rid = TJCrypto.randomRid();
    await putRecord(rid, f);
    ai.left = d.left; ai.open = rid;
    afterLocalChange();
  } catch (e) {
    if (e instanceof AuthGone) throw e;
    ai.msg = e.message || "Ошибка";
  } finally {
    ai.busy = false;
    render();
  }
}

/** Проверяет прогнозы, у которых прошёл горизонт: какая цель была достигнута первой. */
async function scoreForecasts() {
  if (ai.scoring) return;
  ai.scoring = true;
  let changed = false;
  try {
    const todo = forecasts().filter(f => !f.result && f.price && Date.now() > f.at + 36e5).slice(0, 6);
    for (const f of todo) {
      const h = hoursOf(f);
      let d;
      try { d = await aiCall({ op: "candles", market: f.market, symbol: f.label, from: f.at, hours: h }); } catch (e) { if (e instanceof AuthGone) throw e; continue; }
      const bars = Array.isArray(d?.bars) ? d.bars : [];
      let outcome = null, hitAt = null;
      for (const [t, hi, lo] of bars) {
        const up = f.up.target != null && hi >= f.up.target, down = f.down.target != null && lo <= f.down.target;
        if (up && down) { outcome = "unclear"; hitAt = t; break; }
        if (up || down) { outcome = up ? "up" : "down"; hitAt = t; break; }
      }
      if (!outcome && d?.complete) outcome = "flat";
      if (!outcome) continue;   // горизонт ещё не прошёл и цели не достигнуты
      await putRecord(f.rid, { ...f, result: { outcome, checkedAt: Date.now(), hitAt } });
      changed = true;
    }
  } finally {
    ai.scoring = false;
  }
  if (changed) afterLocalChange();
}

function deleteForecast(rid) {
  if (!confirm("Удалить прогноз из истории? Он перестанет учитываться в точности.")) return;
  removeRecord(rid);
  if (ai.open === rid) ai.open = null;
  afterLocalChange();
}

// ---------------------------------------------------------------- экран

function probBar(f) {
  const w = k => `<i style="width:${f[k].probability}%;background:var(${k === "up" ? "--green" : k === "down" ? "--red" : "--muted"})"></i>`;
  return `<div class="bar">${w("up")}${w("flat")}${w("down")}</div>`;
}

function forecastCard(f) {
  const res = f.result;
  const resLine = res
    ? `<div class="small" style="margin-top:6px">Итог: <b class="${res.outcome === "up" ? "pos" : res.outcome === "down" ? "neg" : "muted"}">${OUT_NAME[res.outcome]}</b>${res.outcome !== "unclear" ? ` · главный сценарий ${topOf(f) === res.outcome ? "<span class=pos>сбылся</span>" : "<span class=neg>не сбылся</span>"} · Brier ${brier(f).toFixed(2).replace(".", ",")}` : ""}</div>`
    : `<div class="small muted" style="margin-top:6px">Проверка после ${dateFmt.format(new Date(f.at + hoursOf(f) * 36e5))}</div>`;
  const levels = f.levels.length ? `<div class="section-title">Уровни</div><div class="card">${f.levels.map(l =>
    `<div class="row"><span><span class="badge ${l.kind === "resistance" ? "short" : "long"}">${l.kind === "resistance" ? "СОПР." : "ПОДД."}</span> <span class="small muted">${esc(l.note)}</span></span><span class="num">${priceFmt(l.price)}</span></div>`).join("")}</div>` : "";
  const news = f.news.length ? `<div class="section-title">Новости, которые учтены</div><div class="card">${f.news.map(n =>
    `<div class="insight"><span class="${n.impact === "bullish" ? "pos" : n.impact === "bearish" ? "neg" : "muted"}">●</span> <a class="src-link" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title || n.url)}</a><div class="muted small">${esc(n.url.split("/")[2] || "")}</div></div>`).join("")}</div>` : "";
  return `
    <div class="card"><div class="insight">
      <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="sym">${esc(f.label)}</span><span class="muted small">${dateFmt.format(new Date(f.at))} · ${AI_HORIZONS[f.horizon][0]}</span></div>
      <div class="muted small">Цена при анализе: ${priceFmt(f.price)} · ${f.engine === "formula" ? "по формулам" : "ИИ Gemini"}</div>
      ${probBar(f)}
      <p style="margin:10px 0 0">${esc(f.summary)}</p>
      ${resLine}
    </div>
      <div class="row"><div><b class="pos">Рост ${f.up.probability}%</b><div class="small muted">${esc(f.up.reason)}</div></div><div class="num">${priceFmt(f.up.target)}<div class="small muted">${f.up.target != null ? "+" + pctFrom(f.up.target, f.price) : ""}</div></div></div>
      <div class="row"><div><b class="neg">Падение ${f.down.probability}%</b><div class="small muted">${esc(f.down.reason)}</div></div><div class="num">${priceFmt(f.down.target)}<div class="small muted">${f.down.target != null ? pctFrom(f.down.target, f.price) : ""}</div></div></div>
      <div class="row"><div><b class="muted">Без цели ${f.flat.probability}%</b><div class="small muted">${esc(f.flat.reason)}</div></div></div>
    </div>
    ${levels}${news}
    ${f.risks ? `<p class="note muted">Риски: ${esc(f.risks)}</p>` : ""}
    <button class="btn danger" data-act="ai-del" data-rid="${f.rid}">Удалить прогноз</button>`;
}

function accuracyHTML(list) {
  const done = list.filter(f => f.result && f.result.outcome !== "unclear");
  if (!done.length) return `<p class="note muted">Точность появится, когда пройдут горизонты первых прогнозов: приложение само сверит их со свечами.</p>`;
  const hits = done.filter(f => topOf(f) === f.result.outcome).length;
  const b = done.reduce((s, f) => s + brier(f), 0) / done.length;
  // Калибровка: насколько часто сбывается главный сценарий при разной уверенности модели.
  const buckets = [[0, 45, "до 45%"], [45, 60, "45–60%"], [60, 101, "от 60%"]].map(([lo, hi, name]) => {
    const g = done.filter(f => { const p = f[topOf(f)].probability; return p >= lo && p < hi; });
    if (!g.length) return "";
    const avg = g.reduce((s, f) => s + f[topOf(f)].probability, 0) / g.length;
    const real = g.filter(f => topOf(f) === f.result.outcome).length / g.length * 100;
    return `<div class="row small"><span>Уверенность ${name} (${g.length})</span><span class="num">обещано ${Math.round(avg)}% · сбылось ${Math.round(real)}%</span></div>`;
  }).join("");
  return `<div class="card">
    <div class="row"><span>Проверено прогнозов</span><b class="num">${done.length}</b></div>
    <div class="row"><span>Главный сценарий сбылся</span><b class="num">${Math.round(hits / done.length * 100)}%</b></div>
    <div class="row"><span>Brier (меньше — лучше; монетка 0,67)</span><b class="num ${b < 0.6 ? "pos" : b > 0.67 ? "neg" : ""}">${b.toFixed(2).replace(".", ",")}</b></div>
    ${buckets}
  </div>${done.length < 20 ? `<p class="note muted">Меньше 20 прогнозов — выводы о точности пока ненадёжны.</p>` : ""}`;
}

function analystHTML() {
  const list = forecasts();
  const open = ai.open && list.find(f => f.rid === ai.open);
  if (open) return `<button class="copy" data-act="ai-back">‹ Все прогнозы</button>` + forecastCard(open);
  const seg = (items, cur, act) => `<div class="seg wrap">${Object.entries(items).map(([k, v]) =>
    `<button type="button" data-act="${act}" data-v="${k}" class="${k === cur ? "on" : ""}">${Array.isArray(v) ? v[0] : v}</button>`).join("")}</div>`;
  const history = list.map(f => {
    const top = topOf(f), r = f.result;
    const mark = !r ? `<span class="muted small">ждёт</span>` : r.outcome === "unclear" ? `<span class="muted small">—</span>`
      : topOf(f) === r.outcome ? `<span class="pos">✓</span>` : `<span class="neg">✗</span>`;
    return `<div class="row" style="cursor:pointer" data-act="ai-open" data-rid="${f.rid}"><div><span class="sym">${esc(f.label)}</span>
      <span class="badge ${top === "up" ? "long" : top === "down" ? "short" : "src"}">${top === "up" ? "РОСТ" : top === "down" ? "ПАДЕНИЕ" : "ФЛЭТ"} ${f[top].probability}%</span>
      <div class="muted small">${dateFmt.format(new Date(f.at))} · ${AI_HORIZONS[f.horizon][0]}</div></div><div class="num">${mark}</div></div>`;
  }).join("");
  return `
    <div class="card"><div class="row">${seg(AI_MARKETS, ai.market, "ai-market")}</div>
      <div class="row"><input class="full" id="aiSymbol" placeholder="${AI_HINT[ai.market]}" value="${esc(ai.symbol)}" maxlength="15" autocapitalize="characters" autocomplete="off"></div>
      <div class="row">${seg(AI_HORIZONS, ai.horizon, "ai-horizon")}</div></div>
    <button class="btn primary" data-act="ai-run" ${ai.busy || ai.left === 0 ? "disabled" : ""}>${ai.busy ? "Анализирую… (до 2 минут)" : "Сделать прогноз"}${ai.left != null && !ai.busy ? ` · осталось ${ai.left} из 10` : ""}</button>
    ${ai.msg ? `<p class="note warn">${esc(ai.msg)}</p>` : ""}
    <p class="note muted small">Модель смотрит свечи 15m/1h/4h/1d и свежие новости и даёт три сценария с целями. Это не инвестиционный совет. На сервер уходит только тикер — сделки и ключ не уходят.</p>
    <div class="section-title">Точность</div>${accuracyHTML(list)}
    <div class="section-title">История</div>
    ${list.length ? `<div class="card">${history}</div>` : `<div class="empty"><b>Прогнозов пока нет</b>Выбери рынок и тикер</div>`}`;
}

function analystActions(el) {
  return {
    "ai-market": () => { ai.market = el.dataset.v; ai.symbol = ""; ai.msg = ""; render(); },
    "ai-horizon": () => { const s = $("aiSymbol"); if (s) ai.symbol = s.value; ai.horizon = el.dataset.v; render(); },
    "ai-run": runAnalysis,
    "ai-open": () => { ai.open = el.dataset.rid; render(); scrollTo(0, 0); },
    "ai-back": () => { ai.open = null; render(); },
    "ai-del": () => deleteForecast(el.dataset.rid),
  };
}
