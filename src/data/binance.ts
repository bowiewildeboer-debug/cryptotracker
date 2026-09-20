import type { Candle } from '../types.ts';
import { fetchJson, pool } from './http.ts';

/**
 * Binance market data. No API key, no account, no signature.
 *
 * `data-api.binance.vision` is the official market-data-only host. Verified reachable from
 * the Netherlands on 2026-09-20 (HTTP 200); the 451 geo-block applies to US IPs.
 *
 * Only `interval=1d` is ever requested. Weekly and monthly candles are built locally in
 * `aggregate.ts`, which was verified bit-exact against Binance's own `1w`/`1M`.
 */
export const BINANCE_BASE = 'https://data-api.binance.vision';

/** Request weight per klines call, against an IP budget of 6000 per minute. */
const KLINE_WEIGHT = 2;
const WEIGHT_BUDGET = 6000;
/** Back off once we have consumed this share of the minute's budget. */
const WEIGHT_SOFT_LIMIT = 0.5;

class WeightMeter {
  private used = 0;
  /** Binance reports the true figure on every response; trust it over our own counting. */
  observe(res: Response): void {
    const reported = Number(res.headers.get('x-mbx-used-weight-1m'));
    if (Number.isFinite(reported) && reported > 0) this.used = reported;
    else this.used += KLINE_WEIGHT;
  }
  get current(): number {
    return this.used;
  }
  async throttle(): Promise<void> {
    if (this.used < WEIGHT_BUDGET * WEIGHT_SOFT_LIMIT) return;
    // A full minute is the only wait that reliably clears a 1m rolling window.
    await new Promise((r) => setTimeout(r, 60_000));
    this.used = 0;
  }
}

const meter = new WeightMeter();

export function usedWeight(): number {
  return meter.current;
}

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

function toCandle(k: RawKline, nowMs: number): Candle {
  const closeTime = k[6];
  return {
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime,
    partial: nowMs <= closeTime,
  };
}

export interface KlineOptions {
  /** Maximum candles to return, newest last. Paginated in requests of 1000. */
  limit?: number;
  /** Treated as "now" when deciding whether the newest candle is still forming. */
  nowMs?: number;
}

/**
 * Daily candles for one symbol, oldest first.
 *
 * Binance caps a single response at 1000 rows and, notably, does NOT error when asked for
 * more - it silently returns 1000. Deeper history therefore has to be paged backwards with
 * `endTime`, which is what this does.
 */
export async function fetchDailyCandles(symbol: string, opts: KlineOptions = {}): Promise<Candle[]> {
  const limit = opts.limit ?? 1000;
  const nowMs = opts.nowMs ?? Date.now();
  const collected: Candle[] = [];
  let endTime: number | undefined;

  while (collected.length < limit) {
    await meter.throttle();
    const want = Math.min(1000, limit - collected.length);
    const url =
      `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${want}` +
      (endTime === undefined ? '' : `&endTime=${endTime}`);

    const raw = await fetchJson<RawKline[]>(url, { onResponse: (res) => meter.observe(res) });
    if (raw.length === 0) break;

    collected.unshift(...raw.map((k) => toCandle(k, nowMs)));
    if (raw.length < want) break; // reached the start of this symbol's history

    endTime = raw[0]![0] - 1;
  }

  // Binance can repeat a boundary candle across pages; keep one row per open time.
  const byOpen = new Map<number, Candle>();
  for (const c of collected) byOpen.set(c.openTime, c);
  return [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
}

export async function fetchDailyCandlesMany(
  symbols: readonly string[],
  concurrency: number,
  opts: KlineOptions = {},
): Promise<Map<string, Candle[]>> {
  const results = await pool(symbols, concurrency, async (symbol) => {
    try {
      return [symbol, await fetchDailyCandles(symbol, opts)] as const;
    } catch (err) {
      // One dead symbol must never take the whole daily report down.
      return [symbol, { error: String(err) }] as const;
    }
  });

  const out = new Map<string, Candle[]>();
  for (const [symbol, value] of results) {
    if (Array.isArray(value)) out.set(symbol, value);
  }
  return out;
}

export interface ExchangeSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
}

/**
 * Every tradeable spot symbol.
 *
 * Re-read on every run rather than cached: Binance's BTC-quote list in particular has shrunk
 * sharply (only 38 remain), and a symbol vanishing mid-history must degrade to "insufficient
 * data" instead of crashing the run.
 */
export async function fetchExchangeInfo(): Promise<ExchangeSymbol[]> {
  const data = await fetchJson<{ symbols: ExchangeSymbol[] }>(`${BINANCE_BASE}/api/v3/exchangeInfo`, {
    onResponse: (res) => meter.observe(res),
  });
  return data.symbols.filter((s) => s.status === 'TRADING');
}

/** Last traded price for every symbol, in one call. Used to verify ticker mappings. */
export async function fetchAllPrices(): Promise<Map<string, number>> {
  const rows = await fetchJson<{ symbol: string; price: string }[]>(`${BINANCE_BASE}/api/v3/ticker/price`, {
    onResponse: (res) => meter.observe(res),
  });
  return new Map(rows.map((r) => [r.symbol, Number(r.price)]));
}
