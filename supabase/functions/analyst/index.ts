// Аналитик: свечи с нескольких таймфреймов + свежие новости → прогноз с точными целями и вероятностями.
// Модель — бесплатный Google Gemini (ключ GEMINI_API_KEY в секретах функции). Если ключа нет, лимит Gemini
// исчерпан или ответ не прошёл проверку — прогноз считается по формулам (бесплатно, без внешних сервисов).
//
// Безопасность:
//  * Вызывать может только вошедший пользователь (проверяется его токен); лимит 10 анализов в сутки — в базе.
//  * Ключ хранится только в секретах функции, в приложение он не попадает.
//  * Функция ничего не сохраняет и не пишет в логи тикеры: прогноз уходит пользователю и шифруется у него.
//  * В Google уходят только тикер и рыночные данные — сделки, заметки и ключи пользователя нет.
import { candlesSince, expectedMove, Forecast, HORIZONS, loadFrames, Market, normalizeSymbol, ruleForecast, summarize, validate } from "./market.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ORIGIN = Deno.env.get("APP_ORIGIN") || "*";   // адрес приложения, например https://login.github.io
const MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const MARKETS: Market[] = ["crypto", "gold", "forex", "stocks"];

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function rest(path: string, token: string, key = ANON, body: unknown = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SYSTEM = `Ты — осторожный рыночный аналитик. Тебе дают индикаторы и последние свечи инструмента на 4 таймфреймах (15m, 1h, 4h, 1d), посчитанные сервером, а также горизонт прогноза.
Задача: оценить три исхода за горизонт — цена сначала дойдёт до цели роста (up), сначала до цели падения (down), или не дойдёт ни до одной (flat).
Правила:
- Сначала найди веб-поиском 2–4 свежие новости и события (за последние дни), которые могут повлиять на инструмент: макро, отчёты, регуляторы, крупные потоки. Не выдумывай новости: в поле news — только реально найденные страницы с их точным URL.
- Цели ставь у реальных уровней (поддержки/сопротивления, high/low) и соразмерно ожидаемому ходу за горизонт, который указан во входных данных.
- Вероятности — целые проценты, сумма ровно 100. Будь откалиброван: если сигнал слабый, вероятности up и down близки, а flat заметен. Не выдавай уверенность, которой нет.
- Числа (цели, уровни) — в тех же единицах, что и цены во входных данных.
- Пиши кратко, по-русски, без призывов к сделке. Это аналитика, а не инвестиционный совет.`;

async function analyze(user: { id: string; token: string }, market: Market, src: ReturnType<typeof normalizeSymbol> & {}, horizon: string) {
  const hours = HORIZONS[horizon];
  const frames = await loadFrames(fetch, src);
  const h1 = frames["1h"];
  if (!h1?.length || h1.length < 50) throw new UserError("Слишком мало данных по этому тикеру");
  const price = h1[h1.length - 1].c;
  const lastBarAge = Date.now() - h1[h1.length - 1].t;
  const move = expectedMove(frames, hours);

  const input = {
    instrument: src.label, market, horizon_hours: hours, now_utc: new Date().toISOString(),
    current_price: price, expected_move_over_horizon: Number(move.toPrecision(5)),
    market_open_note: lastBarAge > 3 * 36e5 ? "последняя часовая свеча старше 3 часов — рынок, вероятно, закрыт" : "рынок торгуется",
    timeframes: summarize(frames),
  };

  const key = Deno.env.get("GEMINI_API_KEY");
  if (key) {
    try {
      const f = await gemini(key, input, price, move);
      if (f) return { forecast: f, price, move, engine: "ai" };
    } catch (e) {
      console.error("gemini error:", String((e as Error)?.message || "").slice(0, 200));
    }
  }
  return { forecast: validate(ruleForecast(frames, price, move), price, move, new Set()).clean, price, move, engine: "formula" };
}

const FORMAT = `Ответь ТОЛЬКО JSON-объектом без пояснений и без markdown:
{"bias":"up|down|flat","summary":"3–5 предложений","up":{"probability":целое,"target":число,"reason":"..."},
"down":{"probability":целое,"target":число,"reason":"..."},"flat":{"probability":целое,"reason":"..."},
"levels":[{"price":число,"kind":"support|resistance","note":"..."}],
"news":[{"title":"заголовок","source":"домен сайта-источника, например reuters.com","impact":"bullish|bearish|neutral"}],"risks":"..."}`;

async function gemini(key: string, input: unknown, price: number, move: number): Promise<Forecast | null> {
  const contents: any[] = [{ role: "user", parts: [{ text: `Данные (JSON):\n${JSON.stringify(input)}\n\n${FORMAT}` }] }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST", signal: AbortSignal.timeout(90_000),
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents,
        tools: [{ google_search: {} }], generationConfig: { temperature: 0.3 } }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const cand = d?.candidates?.[0];
    const text: string = (cand?.content?.parts || []).map((p: any) => p.text || "").join("");
    // Источники — только то, что реально нашёл поиск Google: домен → ссылка.
    const chunks: { uri: string; title: string }[] = (cand?.groundingMetadata?.groundingChunks || [])
      .map((c: any) => c.web).filter((w: any) => typeof w?.uri === "string" && w.uri.startsWith("https://"));
    let parsed: any = null;
    try { parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { /* ниже — повтор */ }
    if (parsed && Array.isArray(parsed.news)) {
      parsed.news = parsed.news.map((n: any) => {
        const src = String(n?.source || "").toLowerCase().replace(/^www\./, "");
        const c = chunks.find(c => src && c.title.toLowerCase().replace(/^www\./, "") === src);
        return c ? { title: n.title, url: c.uri, impact: n.impact } : null;
      }).filter(Boolean);
    }
    const { errors, clean } = validate(parsed, price, move, new Set(chunks.map(c => c.uri)));
    if (!errors.length) return clean;
    contents.push({ role: "model", parts: [{ text: text || "{}" }] });
    contents.push({ role: "user", parts: [{ text: `Ответ не прошёл проверку: ${parsed ? errors.join("; ") : "это не JSON"}. Исправь и верни только JSON в том же формате.` }] });
  }
  return null;
}

class UserError extends Error {}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return reply(405, { message: "POST only" });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!who.ok) return reply(401, { message: "Нужен вход" });
  const user = { id: (await who.json()).id as string, token };

  let body: any;
  try { body = await req.json(); } catch { return reply(400, { message: "Неверный запрос" }); }
  const market = body?.market as Market;
  if (!MARKETS.includes(market)) return reply(400, { message: "Неизвестный рынок" });
  const src = normalizeSymbol(market, body?.symbol);
  if (!src) return reply(400, { message: "Неверный тикер для этого рынка" });

  try {
    // Свечи для проверки старого прогноза: без ИИ и без списания лимита.
    if (body.op === "candles") {
      const from = Number(body.from), hours = Number(body.hours);
      if (!(from > Date.parse("2024-01-01") && from < Date.now()) || !Object.values(HORIZONS).includes(hours))
        return reply(400, { message: "Неверный период" });
      const bars = await candlesSince(fetch, src, from, hours);
      return reply(200, { bars: bars.map(b => [b.t, b.h, b.l, b.c]), complete: Date.now() >= from + hours * 36e5 });
    }

    if (body.op === "left") {
      const r = await rest("/rest/v1/rpc/ai_left", token);
      return reply(200, { left: await r.json() });
    }

    if (body.op !== "analyze") return reply(400, { message: "Неизвестная операция" });
    const horizon = String(body.horizon);
    if (!HORIZONS[horizon]) return reply(400, { message: "Неверный горизонт" });

    // Сначала списываем лимит (атомарно в базе), при сбое сервера — возвращаем.
    const q = await rest("/rest/v1/rpc/ai_consume", token);
    const qd = await q.json().catch(() => null);
    if (!q.ok) return reply(429, { message: (qd && qd.message) || "Лимит исчерпан" });
    try {
      const out = await analyze(user, market, src, horizon);
      return reply(200, { ...out, label: src.label, market, horizon, hours: HORIZONS[horizon], at: Date.now(), left: qd });
    } catch (e) {
      await rest("/rest/v1/rpc/ai_refund", SERVICE, SERVICE, { p_user: user.id }).catch(() => {});
      throw e;
    }
  } catch (e) {
    if (e instanceof UserError) return reply(400, { message: e.message });
    console.error("analyst error:", (e as Error)?.name, String((e as Error)?.message || "").slice(0, 200));   // без тикера и данных пользователя
    return reply(502, { message: "Анализ не удался — лимит не списан. Попробуй позже." });
  }
});
