// Проверка свечей, индикаторов и валидатора аналитика: node tests/test_market.mts
import { normalizeSymbol, loadFrames, summarize, expectedMove, validate, rsi, ema, atr, aggregate, candlesSince } from "../supabase/functions/analyst/market.ts";
let ok = 0, all = 0;
const check = (name: string, cond: boolean) => { all++; if (cond) ok++; console.log((cond ? "ПРОЙДЕН " : "ПРОВАЛ  ") + name); };

check("rsi растущего ряда = 100", rsi(Array.from({ length: 30 }, (_, i) => i)) === 100);
check("ema постоянного ряда = значение", ema(Array(50).fill(7), 20) === 7);
check("atr постоянного диапазона", Math.abs(atr(Array.from({ length: 30 }, (_, i) => ({ t: i, o: 10, h: 11, l: 9, c: 10, v: 1 })))! - 2) < 1e-9);
check("склейка 4h", aggregate([0, 1, 2, 3, 4].map(i => ({ t: i * 36e5, o: i, h: i + 1, l: i - 1, c: i, v: 1 })), 4).length === 2);
check("тикер: btc → BTCUSDT", normalizeSymbol("crypto", "btc")?.symbol === "BTCUSDT");
check("тикер: золото", normalizeSymbol("gold", "xauusd")?.symbol === "GC=F");
check("тикер: eur/usd", normalizeSymbol("forex", "eur/usd")?.symbol === "EURUSD=X");
check("тикер: мусор отклоняется", normalizeSymbol("stocks", "AAPL&x=1") === null && normalizeSymbol("crypto", "../../") === null);

const base = { bias: "up", summary: "s", up: { probability: 45, target: 105, reason: "" }, down: { probability: 35, target: 95, reason: "" },
  flat: { probability: 20, reason: "" }, levels: [], news: [{ title: "a", url: "https://ok.com/x", impact: "bullish" }, { title: "b", url: "https://fake.com", impact: "bullish" }], risks: "" } as any;
const v = validate(base, 100, 5, new Set(["https://ok.com/x"]));
check("корректный прогноз принят", v.errors.length === 0);
check("выдуманная новость отброшена", v.clean.news.length === 1);
check("сумма ≠ 100 отклоняется", validate({ ...base, flat: { probability: 30, reason: "" } }, 100, 5, new Set()).errors.length > 0);
check("цель роста ниже цены отклоняется", validate({ ...base, up: { ...base.up, target: 99 } }, 100, 5, new Set()).errors.length > 0);
check("фантастическая цель отклоняется", validate({ ...base, up: { ...base.up, target: 200 } }, 100, 5, new Set()).errors.length > 0);
check("пустой ответ отклоняется", validate(null as any, 100, 5, new Set()).errors.length > 0);

for (const [m, s] of [["crypto", "BTC"], ["gold", "XAUUSD"], ["forex", "EURUSD"], ["stocks", "AAPL"]] as const) {
  try {
    const src = normalizeSymbol(m, s)!;
    const fr = await loadFrames(fetch, src);
    const sum: any = summarize(fr);
    const mv = expectedMove(fr, 24);
    check(`${s}: 4 таймфрейма, цена ${sum["1h"]?.close}, ход за сутки ≈ ${mv.toPrecision(3)}`, Object.keys(sum).length === 4 && mv > 0);
    const bars = await candlesSince(fetch, src, Date.now() - 30 * 36e5, 24);
    check(`${s}: свечи для проверки прогноза (${bars.length})`, bars.length >= 6);
  } catch (e) { check(`${s}: загрузка — ${(e as Error).message}`, false); }
}
console.log(`\nИтого: ${ok} из ${all}`);
process.exit(ok === all ? 0 : 1);
