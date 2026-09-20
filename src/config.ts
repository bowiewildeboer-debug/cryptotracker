import { readFileSync, existsSync } from 'node:fs';
import type { IchimokuParams, Timeframe } from './types.ts';

/**
 * Loads `.env` and the JSON config files once, so nothing else has to know where they live.
 *
 * `.env` is gitignored and must stay that way: the repo is public so that GitHub Pages is
 * free, which means anything committed is world-readable. In CI the same values arrive as
 * GitHub Actions secrets instead, and `.env` simply will not exist.
 */
export function loadEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // A malformed .env should not take the run down; the code degrades to keyless.
  }
}

export interface EmaConvergence {
  okMaxRelError: number;
  provisionalMaxRelError: number;
}

export interface ScoreWeights {
  kijunDaily: number;
  kijunWeekly: number;
  coinBtcInTrend: number;
  cloudDaily: { above: number; in: number; below: number };
  cloudWeekly: { above: number; in: number; below: number };
  emaTotal: number;
}

export interface PortfolioParams {
  startDate: string;
  startCapitalEur: number;
  feeRate: number;
  minTradeUsd: number;
  fxSymbol: string;
  strategy: {
    topRankCount: number;
    topMinWeight: number;
    altMaxWeight: number;
    altcoinGate: { line: 'kijun' | 'tenkan'; series: 'coinBtc' };
    rebalance: { onSetChange: boolean; weekly: boolean };
  };
}

/** One EMA cell: a period paired with the timeframe it is actually used on. */
export interface EmaUsage {
  period: number;
  timeframe: Timeframe;
}

export interface Params {
  ichimoku: IchimokuParams;
  ema: { periods: number[]; usage: Record<string, Timeframe[]>; convergence: EmaConvergence };
  timeframes: { kijun: Timeframe[]; cloud: Timeframe[] };
  universe: { targetSize: number; fetchSize: number };
  data: { maxDailyCandles: number; klineConcurrency: number };
  portfolio: PortfolioParams;
  score: ScoreWeights;
}

export interface Exclusions {
  deny: string[];
  allow: string[];
}

export interface Holdings {
  owned: string[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadParams(path = 'config/params.json'): Params {
  return readJson<Params>(path);
}

export function loadExclusions(path = 'config/exclusions.json'): Exclusions {
  const raw = readJson<Partial<Exclusions>>(path);
  return { deny: raw.deny ?? [], allow: raw.allow ?? [] };
}

export function loadHoldings(path = 'config/holdings.json'): Holdings {
  if (!existsSync(path)) return { owned: [] };
  const raw = readJson<Partial<Holdings>>(path);
  return { owned: (raw.owned ?? []).map((s) => s.toUpperCase()) };
}

/**
 * The exact set of EMA cells in use, flattened from the usage matrix.
 *
 * This is deliberately data-driven rather than hardcoded: Bowie uses EMA21 on weekly and
 * monthly, EMA55 on daily and weekly, EMA100 on daily and weekly - six cells. The daily EMA21
 * in particular is NOT used, and must never appear in the table or the touch signal.
 */
export function emaCells(params: Params): EmaUsage[] {
  const cells: EmaUsage[] = [];
  for (const period of params.ema.periods) {
    for (const timeframe of params.ema.usage[String(period)] ?? []) {
      cells.push({ period, timeframe });
    }
  }
  return cells;
}
