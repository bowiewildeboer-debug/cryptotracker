import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, loadParams, loadExclusions, loadHoldings, type Params } from './config.ts';
import { buildUniverse, type Universe } from './data/universe.ts';
import { fetchDailyCandles, fetchDailyCandlesMany } from './data/binance.ts';
import { analyseCoin, referenceIndex, type CoinSignals, type MarketContext } from './analysis/signals.ts';
import { simulate, type DayInput, type PortfolioResult, type UniverseCoin } from './analysis/portfolio.ts';
import { buildPeriodicReport, type PeriodicReport, type PeriodTimeframe } from './report/periodic.ts';
import { compare } from './indicators/predicates.ts';
import { ichimoku } from './indicators/ichimoku.ts';
import type { Candle } from './types.ts';

export const DATA_DIR = 'data';
const HISTORY_DIR = join(DATA_DIR, 'history');

export interface Sections {
  buyCandidates: string[];
  preferBtc: string[];
  droppedOut: string[];
  owned: string[];
}

export interface Report {
  generatedAt: string;
  asOf: string;
  /** The full parameter set that produced this file, so an old report stays interpretable. */
  params: Params['ichimoku'] & { emaUsage: Params['ema']['usage'] };
  btcInTrend: boolean;
  coins: CoinSignals[];
  sections: Sections;
  universe: { size: number; excluded: Universe['excluded']; warnings: string[] };
  portfolio: PortfolioResult | null;
  periodic: Record<string, PeriodicReport>;
  timings: Record<string, number>;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Splits the analysed coins into the four sections of the daily report.
 *
 * A coin appears once, in the first section it qualifies for: a dropout or a holding is more
 * important to see than another name on the buy list.
 */
export function assignSections(coins: readonly CoinSignals[]): Sections {
  const sections: Sections = { buyCandidates: [], preferBtc: [], droppedOut: [], owned: [] };
  for (const c of coins) {
    if (c.droppedOutToday) sections.droppedOut.push(c.symbol);
    else if (c.owned) sections.owned.push(c.symbol);
    else if (c.inTrend && c.btc.preferBtc === true) sections.preferBtc.push(c.symbol);
    else if (c.inTrend) sections.buyCandidates.push(c.symbol);
  }
  return sections;
}

/** The strategy portfolio's gate: above the daily Kijun in USD, and beating BTC. */
export function qualifiesForStrategy(c: CoinSignals, btcSymbol: string): boolean {
  if (!c.inTrend) return false;
  if (c.symbol === btcSymbol) return true;
  return c.btc.coinBtcInTrend === true;
}

export interface RunOptions {
  /** Skip the portfolio simulation, e.g. for a fast smoke run. */
  skipPortfolio?: boolean;
  /** Limit the universe, for development. */
  limit?: number;
  write?: boolean;
  /** Also build these period reports. They reuse the candles already fetched. */
  periods?: PeriodTimeframe[];
}

export async function runDaily(opts: RunOptions = {}): Promise<Report> {
  loadEnv();
  const params = loadParams();
  const exclusions = loadExclusions();
  const holdings = loadHoldings();
  const timings: Record<string, number> = {};
  const mark = (label: string, t: number) => {
    timings[label] = Math.round(Date.now() - t);
  };

  let t = Date.now();
  const universe = await buildUniverse({
    fetchSize: params.universe.fetchSize,
    targetSize: opts.limit ?? params.universe.targetSize,
    exclusions,
  });
  mark('universe', t);

  const coins = universe.coins;
  const btc = coins.find((c) => c.symbol === 'BTC');
  if (!btc) throw new Error('BTC is not in the universe; the whole BTC-relative filter depends on it');

  t = Date.now();
  const symbols = [...new Set(coins.map((c) => c.binanceSymbol))];
  const candles = await fetchDailyCandlesMany(symbols, params.data.klineConcurrency, {
    limit: params.data.maxDailyCandles,
  });
  const fx = await fetchDailyCandles(params.portfolio.fxSymbol, { limit: 30 });
  mark('candles', t);

  const btcDaily = candles.get(btc.binanceSymbol) ?? [];
  if (btcDaily.length === 0) throw new Error('no BTC candles; cannot compute anything BTC-relative');

  const btcIdx = referenceIndex(btcDaily);
  const btcBase = btcDaily.slice(0, btcIdx + 1);
  const btcIch = ichimoku(btcBase, params.ichimoku);
  const btcInTrend = compare(btcBase[btcBase.length - 1]!.close, btcIch.kijun[btcBase.length - 1] ?? null) === 'above';

  t = Date.now();
  const owned = new Set(holdings.owned);
  const ctx: MarketContext = { params, btcDaily, btcId: btc.id, btcInTrend, owned };
  const analysed: CoinSignals[] = [];
  const missing: string[] = [];

  for (const coin of coins) {
    const daily = candles.get(coin.binanceSymbol);
    if (!daily || daily.length === 0) {
      missing.push(`${coin.symbol} (${coin.binanceSymbol}): no candles returned`);
      continue;
    }
    const row = analyseCoin({ ...coin, daily }, ctx);
    if (row) analysed.push(row);
    else missing.push(`${coin.symbol}: no closed daily candle yet`);
  }
  analysed.sort((a, b) => b.score.points - a.score.points || a.rank - b.rank);
  mark('analysis', t);

  const asOf = analysed[0]?.asOf ?? iso(Date.now());
  const eurUsd = fx.at(-1)?.close ?? 0;

  if (opts.write !== false) {
    writeHistorySnapshot(asOf, eurUsd, coins, analysed, btc.symbol);
  }

  t = Date.now();
  const periodic: Record<string, PeriodicReport> = {};
  const withCandles = coins
    .map((c) => ({ ...c, daily: candles.get(c.binanceSymbol) ?? [] }))
    .filter((c) => c.daily.length > 0);
  for (const tf of opts.periods ?? []) {
    periodic[tf] = buildPeriodicReport(withCandles, ctx, tf);
  }
  mark('periodic', t);

  t = Date.now();
  const portfolio = opts.skipPortfolio ? null : runPortfolio(params);
  mark('portfolio', t);

  const report: Report = {
    generatedAt: new Date().toISOString(),
    asOf,
    params: { ...params.ichimoku, emaUsage: params.ema.usage },
    btcInTrend,
    coins: analysed,
    sections: assignSections(analysed),
    universe: { size: coins.length, excluded: universe.excluded, warnings: [...universe.warnings, ...missing] },
    portfolio,
    periodic,
    timings,
  };

  if (opts.write !== false) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, 'latest.json'), JSON.stringify(report));
    const reportsDir = join(DATA_DIR, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    for (const [tf, r] of Object.entries(periodic)) {
      writeFileSync(join(reportsDir, `${tf}-${r.periodEnd}.json`), JSON.stringify(r));
    }
  }
  return report;
}

/**
 * One immutable snapshot per day: the ranks, market caps, prices and gate results as they
 * were. The portfolio replays these from the start date rather than mutating a running
 * balance, so a missed day leaves a gap instead of corrupting everything after it.
 */
function writeHistorySnapshot(
  date: string,
  eurUsd: number,
  universe: readonly { id: string; symbol: string; rank: number; marketCapUsd: number }[],
  analysed: readonly CoinSignals[],
  btcSymbol: string,
): void {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const byId = new Map(analysed.map((c) => [c.id, c]));
  const snapshot: DayInput = {
    date,
    eurUsd,
    universe: universe.map((c) => ({ id: c.id, symbol: c.symbol, rank: c.rank, marketCapUsd: c.marketCapUsd })),
    priceUsd: Object.fromEntries(analysed.map((c) => [c.id, c.closeUsd])),
    qualifies: Object.fromEntries(
      universe.map((c) => {
        const row = byId.get(c.id);
        return [c.id, row ? qualifiesForStrategy(row, btcSymbol) : false];
      }),
    ),
  };
  writeFileSync(join(HISTORY_DIR, `${date}.json`), JSON.stringify(snapshot));
}

export function readHistory(): DayInput[] {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(HISTORY_DIR, f), 'utf8')) as DayInput);
}

export function runPortfolio(params: Params): PortfolioResult | null {
  const days = readHistory().filter((d) => d.date >= params.portfolio.startDate);
  if (days.length === 0) return null;

  const p = params.portfolio;
  return simulate(days, {
    startDate: p.startDate,
    startCapitalEur: p.startCapitalEur,
    feeRate: p.feeRate,
    minTradeUsd: p.minTradeUsd,
    topRankCount: p.strategy.topRankCount,
    topMinWeight: p.strategy.topMinWeight,
    altMaxWeight: p.strategy.altMaxWeight,
  });
}

export type { Candle, UniverseCoin };
