import { fetchJson } from './http.ts';

/**
 * CoinGecko provides the ranking and the coin identity. It never provides candles:
 * `/coins/{id}/ohlc` silently coarsens to 4-day bars past 30 days, which would quietly
 * corrupt every Kijun and EMA in the report.
 *
 * A free Demo key is strongly recommended - keyless requests come from a shared IP pool and
 * start returning HTTP 429 after roughly four rapid calls. Set `COINGECKO_API_KEY`.
 * This module is deliberately designed to need only a couple of calls per run, so it still
 * works keyless.
 */
const BASE = 'https://api.coingecko.com/api/v3';

function headers(): Record<string, string> {
  const key = process.env['COINGECKO_API_KEY'];
  return key ? { 'x-cg-demo-api-key': key } : {};
}

export function hasApiKey(): boolean {
  return Boolean(process.env['COINGECKO_API_KEY']);
}

export interface MarketCoin {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
}

/** Top `count` coins by market cap. Ask for more than 100 so exclusions still leave 100. */
export async function fetchTopCoins(count: number): Promise<MarketCoin[]> {
  const perPage = Math.min(250, count);
  const url =
    `${BASE}/coins/markets?vs_currency=usd&order=market_cap_desc` +
    `&per_page=${perPage}&page=1&sparkline=false&price_change_percentage=24h`;
  const rows = await fetchJson<MarketCoin[]>(url, { headers: headers(), attempts: 5, baseDelayMs: 2000 });
  return rows.filter((c) => c.market_cap_rank !== null).slice(0, count);
}

/**
 * Coin ids in CoinGecko's `stablecoins` category - the authoritative exclusion set.
 *
 * Do not try to detect stablecoins by name or by a substring match on tags: `stablecoin-protocol`
 * marks real trend assets such as ENA, SKY and FF, which must stay in the universe.
 */
export async function fetchStablecoinIds(): Promise<Set<string>> {
  const url = `${BASE}/coins/markets?vs_currency=usd&category=stablecoins&per_page=250&page=1&sparkline=false`;
  const rows = await fetchJson<MarketCoin[]>(url, { headers: headers(), attempts: 5, baseDelayMs: 2000 });
  return new Set(rows.map((c) => c.id));
}

export interface Ticker {
  base: string;
  target: string;
  market: { identifier: string };
  trust_score: string | null;
  converted_volume?: { usd?: number };
}

/**
 * Authoritative exchange tickers for one coin. Used only to settle a disputed mapping,
 * because it costs one call per coin.
 *
 * `base + target` is the Binance spot symbol - verified: BTC + USDT gives BTCUSDT.
 */
export async function fetchTickers(id: string, exchange = 'binance'): Promise<Ticker[]> {
  const url = `${BASE}/coins/${encodeURIComponent(id)}/tickers?exchange_ids=${exchange}&depth=false`;
  const data = await fetchJson<{ tickers: Ticker[] }>(url, { headers: headers(), attempts: 5, baseDelayMs: 2000 });
  return data.tickers ?? [];
}
