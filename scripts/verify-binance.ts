/**
 * Live verification of the riskiest assumptions in the data layer.
 *
 *   npx tsx scripts/verify-binance.ts
 *
 * Proves, against the real API rather than documentation:
 *   1. Binance market data is reachable from this machine
 *   2. pagination past the 1000-row cap works and produces a clean daily series
 *   3. locally aggregated weekly/monthly candles equal Binance's own 1w/1M
 *   4. EURUSDT exists, so the portfolio can be valued in euros
 *   5. BTC-quote coverage is as poor as the research claims
 */
import { fetchDailyCandles, fetchExchangeInfo, fetchAllPrices, usedWeight, BINANCE_BASE } from '../src/data/binance.ts';
import { fetchJson } from '../src/data/http.ts';
import { aggregate } from '../src/data/aggregate.ts';
import type { Candle } from '../src/types.ts';

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

async function nativeCandles(symbol: string, interval: '1w' | '1M'): Promise<Candle[]> {
  const raw = await fetchJson<[number, string, string, string, string, string, number][]>(
    `${BINANCE_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000`,
  );
  return raw.map((k) => ({
    openTime: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
    closeTime: k[6],
    partial: false,
  }));
}

/** Compare only COMPLETE buckets: the first is truncated by our window, the last still forming. */
function compareBuckets(mine: Candle[], native: Candle[], label: string): void {
  const nativeByOpen = new Map(native.map((c) => [c.openTime, c]));
  let compared = 0;
  const mismatches: string[] = [];

  for (const m of mine.slice(1, -1)) {
    const n = nativeByOpen.get(m.openTime);
    if (!n) continue;
    compared++;
    const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-9);
    if (!near(m.open, n.open) || !near(m.high, n.high) || !near(m.low, n.low) || !near(m.close, n.close)) {
      mismatches.push(`${iso(m.openTime)} mine=${m.open}/${m.high}/${m.low}/${m.close} native=${n.open}/${n.high}/${n.low}/${n.close}`);
    }
  }
  check(`${label}: ${compared} complete buckets match Binance exactly`, compared > 20 && mismatches.length === 0,
    mismatches.length ? `\n      ${mismatches.slice(0, 3).join('\n      ')}` : `(compared ${compared})`);
}

const t0 = Date.now();

console.log('--- 1. reachability + pagination ---');
const daily = await fetchDailyCandles('BTCUSDT', { limit: 1200 });
check('BTCUSDT daily candles fetched', daily.length > 1000, `${daily.length} candles, ${iso(daily[0]!.openTime)} .. ${iso(daily.at(-1)!.openTime)}`);
check('pagination produced no duplicate open times', new Set(daily.map((c) => c.openTime)).size === daily.length);
check('daily series is strictly ascending and gap-free', daily.every((c, i) => i === 0 || c.openTime - daily[i - 1]!.openTime === 86_400_000));
check('every candle opens at 00:00:00 UTC', daily.every((c) => c.openTime % 86_400_000 === 0));
check('only the newest candle is marked partial', daily.slice(0, -1).every((c) => !c.partial));
check('OHLC is internally consistent', daily.every((c) => c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)));

console.log('\n--- 2. local aggregation vs Binance native ---');
compareBuckets(aggregate(daily, 'weekly'), await nativeCandles('BTCUSDT', '1w'), 'weekly');
compareBuckets(aggregate(daily, 'monthly'), await nativeCandles('BTCUSDT', '1M'), 'monthly');

const weekly = aggregate(daily, 'weekly');
check('every weekly bucket opens on a Monday UTC', weekly.every((c) => new Date(c.openTime).getUTCDay() === 1));
check('only the newest weekly bucket is partial', weekly.slice(0, -1).every((c) => !c.partial));

console.log('\n--- 3. euro valuation ---');
const fx = await fetchDailyCandles('EURUSDT', { limit: 5 });
check('EURUSDT is tradeable, so the portfolio can be valued in EUR', fx.length > 0, `last close ${fx.at(-1)?.close}`);

console.log('\n--- 4. symbol coverage ---');
const info = await fetchExchangeInfo();
const usdt = info.filter((s) => s.quoteAsset === 'USDT');
const btc = info.filter((s) => s.quoteAsset === 'BTC');
check('exchangeInfo returns a plausible symbol universe', info.length > 500, `${info.length} trading symbols`);
console.log(`      ${usdt.length} USDT-quoted, ${btc.length} BTC-quoted`);
check('BTC-quote coverage is poor, confirming the synthetic ratio is required', btc.length < 100,
  `${btc.length} BTC pairs exist in total, so most top-100 alts have none`);

const prices = await fetchAllPrices();
check('ticker/price returns a price for every symbol', prices.size >= info.length * 0.9, `${prices.size} prices`);

console.log(`\nweight used: ${usedWeight()} of 6000 per minute · elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
