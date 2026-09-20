import { weekStartUtc } from '../data/aggregate.ts';

/**
 * Two simulated portfolios, both starting from the same capital on the same day.
 *
 *   A "HODL"     - buy the whole universe once, market-cap weighted, never touch it again.
 *   B "Strategy" - hold only the coins that pass the daily gate, re-weighted by Bowie's rules.
 *
 * INFORMATIONAL ONLY. Nothing here executes a trade; it exists to answer "what would following
 * the rules have been worth compared with just holding everything".
 *
 * The whole history is REPLAYED from the start date on every run, out of committed daily
 * snapshots. State is derived, never incrementally mutated, so a missed run heals itself on
 * the next one instead of permanently corrupting the series.
 */

export interface UniverseCoin {
  /** CoinGecko id - the only safe identifier. Ticker strings collide (LIT = Lighter vs Litentry). */
  id: string;
  symbol: string;
  /** 1-based rank within the FILTERED universe, so stablecoins never occupy a top-10 slot. */
  rank: number;
  marketCapUsd: number;
}

export interface DayInput {
  /** YYYY-MM-DD, UTC. */
  date: string;
  /** EURUSDT daily close - how many USD one EUR buys. */
  eurUsd: number;
  universe: UniverseCoin[];
  /** coin id -> USDT daily close. A coin missing here has no price on this day. */
  priceUsd: Record<string, number>;
  /** coin id -> passes the strategy gate (§11.3). Absent counts as false. */
  qualifies: Record<string, boolean>;
}

export interface StrategyWeightConfig {
  topRankCount: number;
  topMinWeight: number;
  altMaxWeight: number;
}

export interface PortfolioConfig extends StrategyWeightConfig {
  startDate: string;
  startCapitalEur: number;
  feeRate: number;
  minTradeUsd: number;
}

export interface Trade {
  date: string;
  portfolio: 'hodl' | 'strategy';
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  feeUsd: number;
  reason: string;
}

export interface Position {
  id: string;
  symbol: string;
  units: number;
  priceUsd: number;
  valueUsd: number;
  weight: number;
  /** True when this day's price was carried forward because the coin had no quote. */
  stale: boolean;
}

export interface DayPoint {
  date: string;
  eurUsd: number;
  hodlUsd: number;
  hodlEur: number;
  strategyUsd: number;
  strategyEur: number;
  cashUsd: number;
  cashWeight: number;
  qualifyingCount: number;
  rebalanced: boolean;
}

export interface PortfolioStats {
  returnPct: number;
  maxDrawdownPct: number;
  bestDayPct: number;
  worstDayPct: number;
  totalFeesUsd: number;
}

export interface PortfolioResult {
  config: PortfolioConfig;
  series: DayPoint[];
  trades: Trade[];
  holdings: { hodl: Position[]; strategy: Position[] };
  cashUsd: number;
  stats: { hodl: PortfolioStats; strategy: PortfolioStats & { daysFullyInCash: number; avgCashWeight: number } };
  warnings: string[];
}

export interface TargetWeights {
  /** coin id -> fraction of total portfolio value. Sums to 1 - cashWeight. */
  weights: Map<string, number>;
  cashWeight: number;
  topCount: number;
  altCount: number;
}

/**
 * Bowie's allocation rule, stated exactly as he gave it:
 *
 *   - coins ranked 1..10 share AT LEAST 50% (and up to 100%), pro rata by market cap
 *   - coins ranked 11+ get AT MOST 5% each and are split evenly
 *   - therefore altcoins can never exceed 50% between them
 *   - anything that cannot be allocated stays in stablecoins
 *
 * The last point is not a special case, it falls out of the rule: with no qualifying top-10
 * coin the portfolio is at least half cash, and with nothing qualifying at all it is 100% cash.
 */
export function targetWeights(
  universe: readonly UniverseCoin[],
  qualifies: Readonly<Record<string, boolean>>,
  cfg: StrategyWeightConfig,
): TargetWeights {
  const qualifying = universe.filter((c) => qualifies[c.id] === true);
  const top = qualifying.filter((c) => c.rank <= cfg.topRankCount);
  const alts = qualifying.filter((c) => c.rank > cfg.topRankCount);

  const altBudget = 1 - cfg.topMinWeight;
  const altEach = alts.length > 0 ? Math.min(cfg.altMaxWeight, altBudget / alts.length) : 0;
  const altTotal = altEach * alts.length;
  const topTotal = 1 - altTotal;

  const weights = new Map<string, number>();
  for (const c of alts) weights.set(c.id, altEach);

  const topMcap = top.reduce((s, c) => s + Math.max(0, c.marketCapUsd), 0);
  if (top.length > 0 && topMcap > 0) {
    for (const c of top) weights.set(c.id, (topTotal * Math.max(0, c.marketCapUsd)) / topMcap);
  }
  // If no top-10 coin qualifies, topTotal is simply not allocated and becomes cash.

  let allocated = 0;
  for (const w of weights.values()) allocated += w;

  return {
    weights,
    cashWeight: Math.max(0, 1 - allocated),
    topCount: top.length,
    altCount: alts.length,
  };
}

interface Book {
  units: Map<string, number>;
  cashUsd: number;
}

function bookValue(book: Book, price: Map<string, number>): number {
  let v = book.cashUsd;
  for (const [id, units] of book.units) v += units * (price.get(id) ?? 0);
  return v;
}

/**
 * Move a book towards `targets` (coin id -> desired fraction of total value).
 *
 * Sells execute first; buys are then scaled to whatever cash is actually available after
 * fees, so the book can never spend money it does not have. That leaves the portfolio a
 * hair under-invested by exactly the fee, which is what really happens.
 */
function rebalance(
  book: Book,
  targets: Map<string, number>,
  price: Map<string, number>,
  symbolOf: Map<string, string>,
  cfg: PortfolioConfig,
  date: string,
  portfolio: Trade['portfolio'],
  reason: string,
  trades: Trade[],
): void {
  const total = bookValue(book, price);
  if (total <= 0) return;

  const ids = new Set<string>([...book.units.keys(), ...targets.keys()]);
  const deltas: { id: string; delta: number }[] = [];

  for (const id of ids) {
    const p = price.get(id);
    // A coin with no price cannot be traded today. Holding it is the only honest option.
    if (p === undefined || !(p > 0)) continue;
    const current = (book.units.get(id) ?? 0) * p;
    const desired = (targets.get(id) ?? 0) * total;
    const delta = desired - current;
    if (Math.abs(delta) >= cfg.minTradeUsd) deltas.push({ id, delta });
  }

  for (const { id, delta } of deltas) {
    if (delta >= 0) continue;
    const p = price.get(id)!;
    const notional = -delta;
    const fee = notional * cfg.feeRate;
    book.units.set(id, Math.max(0, (book.units.get(id) ?? 0) - notional / p));
    if ((book.units.get(id) ?? 0) <= 0) book.units.delete(id);
    book.cashUsd += notional - fee;
    trades.push({ date, portfolio, id, symbol: symbolOf.get(id) ?? id, side: 'sell', notionalUsd: notional, feeUsd: fee, reason });
  }

  const buys = deltas.filter((d) => d.delta > 0);
  const buyTotal = buys.reduce((s, d) => s + d.delta, 0);
  if (buyTotal <= 0) return;

  const affordable = book.cashUsd / (1 + cfg.feeRate);
  const scale = Math.min(1, affordable / buyTotal);
  if (!(scale > 0)) return;

  for (const { id, delta } of buys) {
    const p = price.get(id)!;
    const notional = delta * scale;
    if (notional < cfg.minTradeUsd) continue;
    const fee = notional * cfg.feeRate;
    book.units.set(id, (book.units.get(id) ?? 0) + notional / p);
    book.cashUsd -= notional + fee;
    trades.push({ date, portfolio, id, symbol: symbolOf.get(id) ?? id, side: 'buy', notionalUsd: notional, feeUsd: fee, reason });
  }
}

function statsOf(values: number[]): Omit<PortfolioStats, 'totalFeesUsd'> {
  if (values.length === 0) return { returnPct: 0, maxDrawdownPct: 0, bestDayPct: 0, worstDayPct: 0 };
  const first = values[0]!;
  const last = values[values.length - 1]!;
  let peak = first;
  let maxDd = 0;
  let best = 0;
  let worst = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v > peak) peak = v;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
    if (i > 0) {
      const prev = values[i - 1]!;
      if (prev > 0) {
        const r = (v - prev) / prev;
        if (r > best) best = r;
        if (r < worst) worst = r;
      }
    }
  }
  return {
    returnPct: first > 0 ? (last / first - 1) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    bestDayPct: best * 100,
    worstDayPct: worst * 100,
  };
}

export function simulate(days: readonly DayInput[], cfg: PortfolioConfig): PortfolioResult {
  const warnings: string[] = [];
  const trades: Trade[] = [];
  const series: DayPoint[] = [];

  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date)).filter((d) => d.date >= cfg.startDate);
  if (ordered.length === 0) {
    throw new Error(`no day inputs on or after the start date ${cfg.startDate}`);
  }

  const hodl: Book = { units: new Map(), cashUsd: 0 };
  const strat: Book = { units: new Map(), cashUsd: 0 };

  /** Last seen price per coin, so a missing quote carries forward instead of valuing at zero. */
  const lastPrice = new Map<string, number>();
  const staleToday = new Set<string>();
  const symbolOf = new Map<string, string>();

  let lastQualifyingKey: string | null = null;
  let lastRebalanceWeek: number | null = null;

  for (let i = 0; i < ordered.length; i++) {
    const day = ordered[i]!;
    for (const c of day.universe) symbolOf.set(c.id, c.symbol);

    staleToday.clear();
    const price = new Map<string, number>();
    for (const id of new Set([...Object.keys(day.priceUsd), ...hodl.units.keys(), ...strat.units.keys()])) {
      const fresh = day.priceUsd[id];
      if (fresh !== undefined && fresh > 0) {
        price.set(id, fresh);
        lastPrice.set(id, fresh);
      } else {
        const carried = lastPrice.get(id);
        if (carried !== undefined) {
          price.set(id, carried);
          staleToday.add(id);
        }
      }
    }

    const isFirst = i === 0;

    if (isFirst) {
      const capitalUsd = cfg.startCapitalEur * day.eurUsd;
      hodl.cashUsd = capitalUsd;
      strat.cashUsd = capitalUsd;

      const investable = day.universe.filter((c) => (price.get(c.id) ?? 0) > 0 && c.marketCapUsd > 0);
      const skipped = day.universe.length - investable.length;
      if (skipped > 0) warnings.push(`${cfg.startDate}: ${skipped} universe coins had no price and were left out of the HODL benchmark`);

      const mcapTotal = investable.reduce((s, c) => s + c.marketCapUsd, 0);
      const hodlTargets = new Map<string, number>();
      for (const c of investable) hodlTargets.set(c.id, c.marketCapUsd / mcapTotal);
      rebalance(hodl, hodlTargets, price, symbolOf, cfg, day.date, 'hodl', 'initial purchase', trades);
    }

    const tw = targetWeights(day.universe, day.qualifies, cfg);
    const qualifyingKey = [...tw.weights.keys()].sort().join(',');
    const week = weekStartUtc(Date.parse(`${day.date}T00:00:00Z`));

    const setChanged = qualifyingKey !== lastQualifyingKey;
    const newWeek = lastRebalanceWeek !== null && week !== lastRebalanceWeek;
    const shouldRebalance = isFirst || setChanged || newWeek;

    if (shouldRebalance) {
      const reason = isFirst ? 'initial purchase' : setChanged ? 'qualifying set changed' : 'weekly rebalance';
      rebalance(strat, tw.weights, price, symbolOf, cfg, day.date, 'strategy', reason, trades);
      lastQualifyingKey = qualifyingKey;
      lastRebalanceWeek = week;
    }

    const hodlUsd = bookValue(hodl, price);
    const stratUsd = bookValue(strat, price);

    series.push({
      date: day.date,
      eurUsd: day.eurUsd,
      hodlUsd,
      hodlEur: hodlUsd / day.eurUsd,
      strategyUsd: stratUsd,
      strategyEur: stratUsd / day.eurUsd,
      cashUsd: strat.cashUsd,
      cashWeight: stratUsd > 0 ? strat.cashUsd / stratUsd : 1,
      qualifyingCount: tw.weights.size,
      rebalanced: shouldRebalance,
    });
  }

  const lastDay = ordered[ordered.length - 1]!;
  const finalPrice = new Map<string, number>();
  for (const id of new Set([...hodl.units.keys(), ...strat.units.keys()])) {
    finalPrice.set(id, lastDay.priceUsd[id] ?? lastPrice.get(id) ?? 0);
  }

  const toPositions = (book: Book): Position[] => {
    const total = bookValue(book, finalPrice);
    return [...book.units.entries()]
      .map(([id, units]) => {
        const p = finalPrice.get(id) ?? 0;
        return {
          id,
          symbol: symbolOf.get(id) ?? id,
          units,
          priceUsd: p,
          valueUsd: units * p,
          weight: total > 0 ? (units * p) / total : 0,
          stale: lastDay.priceUsd[id] === undefined,
        };
      })
      .sort((a, b) => b.valueUsd - a.valueUsd);
  };

  const feesOf = (p: Trade['portfolio']) =>
    trades.filter((t) => t.portfolio === p).reduce((s, t) => s + t.feeUsd, 0);

  const cashWeights = series.map((s) => s.cashWeight);

  return {
    config: cfg,
    series,
    trades,
    holdings: { hodl: toPositions(hodl), strategy: toPositions(strat) },
    cashUsd: strat.cashUsd,
    stats: {
      hodl: { ...statsOf(series.map((s) => s.hodlEur)), totalFeesUsd: feesOf('hodl') },
      strategy: {
        ...statsOf(series.map((s) => s.strategyEur)),
        totalFeesUsd: feesOf('strategy'),
        daysFullyInCash: series.filter((s) => s.qualifyingCount === 0).length,
        avgCashWeight: cashWeights.length > 0 ? cashWeights.reduce((a, b) => a + b, 0) / cashWeights.length : 0,
      },
    },
    warnings,
  };
}
