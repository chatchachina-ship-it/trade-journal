// ИИ-аналитик: свечи с нескольких таймфреймов + свежие новости → прогноз Claude с точными целями и вероятностями.
//
// Безопасность:
//  * Вызывать может только вошедший пользователь (проверяется его токен); лимит 10 анализов в сутки — в базе.
//  * Ключ Anthropic хранится только в секретах функции (ANTHROPIC_API_KEY), в приложение он не попадает.
//  * Функция ничего не сохраняет и не пишет в логи тикеры: прогноз уходит пользователю и шифруется у него.
//  * Тикер и рыночные данные отправляются в Anthropic — сделки, заметки и ключи пользователя нет.
import Anthropic from "npm:@anthropic-ai/sdk@1.6.0";
import { candlesSince, expectedMove, FORECAST_SCHEMA, HORIZONS, loadFrames, Market, normalizeSymbol, summarize, validate } from "./market.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ORIGIN = Deno.env.get("APP_ORIGIN") || "*";   // адрес приложения, например https://login.github.io
const MODEL = "claude-opus-5-5";
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

  const client = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")!, timeout: 140_000, maxRetries: 1 });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `Данные (JSON):\n${JSON.stringify(input)}` }];
  const urls = new Set<string>();
  let usage = { input: 0, output: 0, searches: 0 };

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Anthropic.Message;
    // Серверный поиск может поставить ответ на паузу — продолжаем, пока модель не закончит.
    for (let step = 0; ; step++) {
      res = await client.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: FORECAST_SCHEMA } },
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4, allowed_callers: ["direct"] }],
        messages,
      });
      usage.input += res.usage.input_tokens; usage.output += res.usage.output_tokens;
      usage.searches += res.usage.server_tool_use?.web_search_requests ?? 0;
      for (const b of res.content) {
        if (b.type === "web_search_tool_result" && Array.isArray(b.content))
          for (const r of b.content) if (r.type === "web_search_result") urls.add(r.url);
      }
      if (res.stop_reason !== "pause_turn" || step >= 3) break;
      messages.push({ role: "assistant", content: res.content });
    }
    if (res!.stop_reason === "refusal") throw new UserError("Модель отказалась анализировать этот запрос");
    const text = res!.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlock).text).join("");
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const { errors, clean } = validate(parsed, price, move, urls);
    if (!errors.length) return { forecast: clean, price, move, usage };
    if (attempt === 1) throw new Error("Модель дважды вернула некорректный прогноз: " + errors.join("; "));
    messages.push({ role: "assistant", content: res!.content });
    messages.push({ role: "user", content: `Ответ не прошёл проверку: ${errors.join("; ")}. Исправь и верни прогноз заново в том же формате (повторный поиск не нужен).` });
  }
  throw new Error("unreachable");
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
    if (!Deno.env.get("ANTHROPIC_API_KEY")) return reply(503, { message: "Аналитик не настроен владельцем" });

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
