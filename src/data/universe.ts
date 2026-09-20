import { fetchTopCoins, fetchStablecoinIds, fetchTickers, hasApiKey, type MarketCoin } from './coingecko.ts';
import { fetchExchangeInfo, fetchAllPrices } from './binance.ts';

/**
 * Turns "the top 100 minus the things that cannot trend" into a list of coins paired with a
 * Binance symbol we can actually fetch candles for.
 *
 * ## Why symbol resolution gets its own careful treatment
 *
 * Ticker strings collide, and the collision is live rather than hypothetical: the current top
 * 100 contains `LIT` = **Lighter**, while Binance's `LITUSDT` is **Litentry**. Matching on the
 * ticker alone would chart a completely different asset and produce a confident, wrong buy
 * signal - the worst possible failure mode for this tool.
 *
 * The obvious fix, asking CoinGecko for each coin's exchange tickers, costs one call per coin
 * and is unusable on the keyless tier. So instead every mapping is CHECKED rather than trusted:
 * a ticker match is only accepted when Binance's last price agrees with CoinGecko's price for
 * that coin. Two different coins are essentially never within a few percent of each other, so
 * a disagreement reliably exposes a collision - and only those few coins then cost an
 * authoritative CoinGecko call.
 */

export interface ResolvedCoin {
  id: string;
  symbol: string;
  name: string;
  rank: number;
  marketCapUsd: number;
  priceUsd: number;
  /** Binance spot symbol, e.g. BTCUSDT. */
  binanceSymbol: string;
  /** How the mapping was established. */
  resolution: 'ticker-price-verified' | 'coingecko-tickers' | 'manual-override';
}

export interface ExcludedCoin {
  id: string;
  symbol: string;
  rank: number | null;
  reason: string;
}

export interface Universe {
  /** Coins that survived every filter, re-ranked 1..n within the filtered set. */
  coins: ResolvedCoin[];
  excluded: ExcludedCoin[];
  warnings: string[];
  resolvedAt: string;
}

export interface ExclusionConfig {
  deny: string[];
  allow: string[];
}

export interface SymbolOverrides {
  /** CoinGecko id -> Binance symbol, applied before anything else. */
  [coinId: string]: string;
}

/** A Binance price within this fraction of CoinGecko's price confirms the mapping. */
const PRICE_TOLERANCE = 0.1;

/**
 * Assets that are not stablecoins but still cannot trend on their own: they track something
 * else one-for-one. CoinGecko's `stablecoins` category does not cover them.
 */
const PEGGED_NAME_PATTERNS = [
  /\bwrapped\b/i,
  /\bstaked\b/i,
  /\brestaked\b/i,
  /\bliquid staked\b/i,
  /\btokenized\b/i,
  /\bbridged\b/i,
];

function isPegged(coin: MarketCoin): boolean {
  return PEGGED_NAME_PATTERNS.some((re) => re.test(coin.name));
}

export interface BuildUniverseOptions {
  fetchSize: number;
  targetSize: number;
  exclusions: ExclusionConfig;
  overrides?: SymbolOverrides;
  /** Set false in tests to avoid the extra CoinGecko calls. */
  resolveDisputes?: boolean;
}

export async function buildUniverse(opts: BuildUniverseOptions): Promise<Universe> {
  const warnings: string[] = [];
  const excluded: ExcludedCoin[] = [];
  const overrides = opts.overrides ?? {};
  const allow = new Set(opts.exclusions.allow);
  const deny = new Set(opts.exclusions.deny);

  if (!hasApiKey()) {
    warnings.push('COINGECKO_API_KEY is not set - running keyless against a shared IP pool, which rate-limits aggressively');
  }

  const [top, stablecoinIds, exchangeInfo, prices] = await Promise.all([
    fetchTopCoins(opts.fetchSize),
    fetchStablecoinIds(),
    fetchExchangeInfo(),
    fetchAllPrices(),
  ]);

  const usdtByBase = new Map<string, string>();
  for (const s of exchangeInfo) {
    if (s.quoteAsset === 'USDT') usdtByBase.set(s.baseAsset.toUpperCase(), s.symbol);
  }

  const kept: ResolvedCoin[] = [];
  const disputed: { coin: MarketCoin; candidate: string; cgPrice: number; binPrice: number }[] = [];

  for (const coin of top) {
    const drop = (reason: string) => excluded.push({ id: coin.id, symbol: coin.symbol, rank: coin.market_cap_rank, reason });
    const forced = allow.has(coin.id);

    if (deny.has(coin.id)) {
      drop('manual deny list');
      continue;
    }
    if (!forced && stablecoinIds.has(coin.id)) {
      drop('CoinGecko stablecoins category');
      continue;
    }
    if (!forced && isPegged(coin)) {
      drop(`pegged or wrapped asset (${coin.name})`);
      continue;
    }
    if (coin.market_cap === null || coin.market_cap <= 0 || coin.current_price === null || coin.current_price <= 0) {
      drop('no market cap or price from CoinGecko');
      continue;
    }

    const override = overrides[coin.id];
    if (override) {
      kept.push(toResolved(coin, override, 'manual-override'));
      continue;
    }

    const candidate = usdtByBase.get(coin.symbol.toUpperCase());
    if (!candidate) {
      drop('no Binance USDT spot pair');
      continue;
    }

    const binPrice = prices.get(candidate);
    if (binPrice === undefined || binPrice <= 0) {
      drop(`Binance has ${candidate} but no price for it`);
      continue;
    }

    const drift = Math.abs(binPrice - coin.current_price) / coin.current_price;
    if (drift <= PRICE_TOLERANCE) {
      kept.push(toResolved(coin, candidate, 'ticker-price-verified'));
    } else {
      // Either a ticker collision or an unusually stale quote. Do not guess.
      disputed.push({ coin, candidate, cgPrice: coin.current_price, binPrice });
    }
  }

  // Every fetched coin is filtered, not just the first `targetSize`, so that an exclusion
  // promotes the next coin up and the universe always reaches its target size when it can.
  // Dispute resolution costs one CoinGecko call each, so only coins that could actually make
  // the cut are worth resolving.
  kept.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
  const cutoff = kept.length >= opts.targetSize ? kept[opts.targetSize - 1]!.marketCapUsd : 0;
  const worthResolving = disputed.filter((d) => (d.coin.market_cap ?? 0) >= cutoff);
  for (const d of disputed) {
    if (!worthResolving.includes(d)) {
      excluded.push({ id: d.coin.id, symbol: d.coin.symbol, rank: d.coin.market_cap_rank, reason: `price mismatch against Binance ${d.candidate}, ranked too low to be worth resolving` });
    }
  }

  if (worthResolving.length > 0 && opts.resolveDisputes !== false) {
    for (const d of worthResolving) {
      try {
        const tickers = await fetchTickers(d.coin.id);
        const best = tickers
          .filter((t) => t.target === 'USDT' && t.market.identifier === 'binance')
          .sort((a, b) => (b.converted_volume?.usd ?? 0) - (a.converted_volume?.usd ?? 0))[0];

        if (!best) {
          excluded.push({ id: d.coin.id, symbol: d.coin.symbol, rank: d.coin.market_cap_rank, reason: `ticker ${d.coin.symbol} collides on Binance and CoinGecko lists no Binance USDT pair for it` });
          warnings.push(`${d.coin.symbol} (${d.coin.name}): Binance ${d.candidate} is a DIFFERENT coin (price ${d.binPrice} vs ${d.cgPrice}); excluded`);
          continue;
        }
        const symbol = `${best.base}${best.target}`;
        kept.push(toResolved(d.coin, symbol, 'coingecko-tickers'));
        if (symbol !== d.candidate) {
          warnings.push(`${d.coin.symbol} (${d.coin.name}): ticker match ${d.candidate} was WRONG, resolved to ${symbol} via CoinGecko`);
        }
      } catch (err) {
        excluded.push({ id: d.coin.id, symbol: d.coin.symbol, rank: d.coin.market_cap_rank, reason: `disputed mapping could not be resolved: ${String(err)}` });
      }
    }
  } else if (worthResolving.length > 0) {
    for (const d of worthResolving) {
      excluded.push({ id: d.coin.id, symbol: d.coin.symbol, rank: d.coin.market_cap_rank, reason: `price mismatch against Binance ${d.candidate} and dispute resolution disabled` });
    }
  }

  // Re-rank inside the filtered universe, so stablecoins never occupy a top-10 slot.
  kept.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
  const coins = kept.slice(0, opts.targetSize).map((c, i) => ({ ...c, rank: i + 1 }));

  // The coins that matter most are the ones genuinely in the CoinMarketCap top 100 that we
  // cannot chart at all - each one is silently replaced by a lower-ranked coin, which changes
  // what "the top 100" means in the report.
  const missingFromTop100 = excluded
    .filter((e) => e.rank !== null && e.rank <= 100 && e.reason === 'no Binance USDT spot pair')
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  if (missingFromTop100.length > 0) {
    warnings.push(
      `${missingFromTop100.length} coins in the real top 100 have no Binance USDT pair and were replaced by lower-ranked ones: ` +
        missingFromTop100.map((e) => `#${e.rank} ${e.symbol.toUpperCase()}`).join(', '),
    );
  }

  if (coins.length < opts.targetSize) {
    warnings.push(`only ${coins.length} tradeable coins survived the filters, wanted ${opts.targetSize} - consider raising universe.fetchSize`);
  }

  return { coins, excluded, warnings, resolvedAt: new Date().toISOString() };
}

function toResolved(coin: MarketCoin, binanceSymbol: string, resolution: ResolvedCoin['resolution']): ResolvedCoin {
  return {
    id: coin.id,
    symbol: coin.symbol.toUpperCase(),
    name: coin.name,
    rank: coin.market_cap_rank ?? 9999,
    marketCapUsd: coin.market_cap ?? 0,
    priceUsd: coin.current_price ?? 0,
    binanceSymbol,
    resolution,
  };
}
