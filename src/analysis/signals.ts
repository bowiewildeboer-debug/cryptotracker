import type { Candle, Timeframe } from '../types.ts';
import type { Params } from '../config.ts';
import { emaCells } from '../config.ts';
import { aggregate } from '../data/aggregate.ts';
import { syntheticBtcRatio } from '../data/ratio.ts';
import { ichimoku, cloudStateAt, type IchimokuSeries, type CloudState } from '../indicators/ichimoku.ts';
import { ema } from '../indicators/ema.ts';
import { compare, touched, type Verdict } from '../indicators/predicates.ts';

/**
 * Turns one coin's daily candles into the full row of the report.
 *
 * ## The reference candle
 *
 * The job runs shortly after 00:00 UTC, so today's daily candle is about an hour old and
 * meaningless. Everything scored is therefore computed on `C0`, the last CLOSED daily candle,
 * with `C1` the one before it. Today's forming candle appears only in a separate, greyed
 * "live" field so the app is still useful when opened in the evening; it never affects a
 * verdict, a score or a notification.
 *
 * Weekly and monthly series are built from the daily candles TRUNCATED AT C0. That keeps every
 * number in the row consistent with a single moment in time, and it is exactly what the
 * cross-timeframe questions need: "did yesterday's daily candle touch the weekly Kijun?" must
 * use the weekly Kijun as it stood at that day's close, not as it stands now.
 */

export interface EmaCellResult {
  period: number;
  timeframe: Timeframe;
  value: number | null;
  /** Upper bound on the seed-induced error of `value`, in price units. */
  uncertainty: number | null;
  /** `ok` is the only state that can earn a point; see `docs/SPEC.md` 5.2. */
  state: 'ok' | 'provisional' | 'na';
  verdict: Verdict;
  /** Did C0's daily candle touch this level? Bowie wants this for every EMA except daily-21. */
  touchedByDaily: boolean;
  bars: number;
}

export interface KijunCellResult {
  timeframe: Timeframe;
  value: number | null;
  verdict: Verdict;
  touchedByDaily: boolean;
  /** Daily only: was it above yesterday and not today? */
  crossedBelowToday: boolean;
  crossedAboveToday: boolean;
}

export interface CloudCellResult extends CloudState {
  timeframe: Timeframe;
  /** The undisplaced reading, kept for reference; never drives the table or the score. */
  noOffsetPosition: CloudState['position'];
}

export interface BtcRelative {
  /** Is the {coin}/BTC series above its own daily Kijun? */
  coinBtcInTrend: boolean | null;
  /** BTC is in trend but this coin is not beating it - Bowie would rather hold BTC. */
  preferBtc: boolean | null;
  kijun: number | null;
  close: number | null;
  /** Always true: the ratio is synthesised for every coin so one method covers the column. */
  synthetic: true;
  bars: number;
}

export interface ScoreResult {
  points: number;
  /** Maximum reachable given the history actually available. */
  max: number;
  /** Points that could not be judged because of missing or unconverged data. */
  unavailable: number;
  breakdown: { label: string; got: number; of: number; counted: boolean }[];
}

export interface CoinSignals {
  id: string;
  symbol: string;
  name: string;
  rank: number;
  marketCapUsd: number;

  asOf: string;
  closeUsd: number;
  changePct: number | null;
  live: { closeUsd: number; verdictVsDailyKijun: Verdict } | null;

  kijun: { daily: KijunCellResult; weekly: KijunCellResult };
  cloud: { daily: CloudCellResult; weekly: CloudCellResult };
  ema: EmaCellResult[];
  btc: BtcRelative;
  /** Undisplaced donchian(55) - the "auxiliary" line Bowie has on his chart but does not use. */
  kijunAux: number | null;

  inTrend: boolean;
  droppedOutToday: boolean;
  owned: boolean;

  score: ScoreResult;
  dataQuality: { dailyBars: number; weeklyBars: number; monthlyBars: number; notes: string[] };
}

export interface MarketContext {
  params: Params;
  /** BTC's daily candles, used for the synthetic ratio and for the preferBtc filter. */
  btcDaily: readonly Candle[];
  /** BTC's own coin id, so BTC is not compared against itself. */
  btcId: string;
  /** Is BTC itself above its daily Kijun at C0? When false, rotating to BTC is no safe haven. */
  btcInTrend: boolean;
  owned: ReadonlySet<string>;
}

export interface CoinInput {
  id: string;
  symbol: string;
  name: string;
  rank: number;
  marketCapUsd: number;
  daily: readonly Candle[];
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Index of the last CLOSED daily candle, or -1 when there is none. */
export function referenceIndex(daily: readonly Candle[]): number {
  for (let i = daily.length - 1; i >= 0; i--) {
    if (!daily[i]!.partial) return i;
  }
  return -1;
}

function lastOf<T>(arr: readonly T[]): T | undefined {
  return arr[arr.length - 1];
}

function emaCell(
  candles: readonly Candle[],
  period: number,
  timeframe: Timeframe,
  refBar: Candle,
  conv: Params['ema']['convergence'],
): EmaCellResult {
  const closes = candles.map((c) => c.close);
  const r = ema(closes, period);
  const value = lastOf(r.values) ?? null;
  const refClose = lastOf(closes) ?? 0;

  let state: EmaCellResult['state'] = 'na';
  if (value !== null && r.uncertainty !== null && refClose > 0) {
    const rel = r.uncertainty / refClose;
    state = rel < conv.okMaxRelError ? 'ok' : rel < conv.provisionalMaxRelError ? 'provisional' : 'na';
  }

  return {
    period,
    timeframe,
    value,
    uncertainty: r.uncertainty,
    state,
    // Widen the neutral band by the EMA's own uncertainty: an unconverged EMA must never
    // produce a confident verdict just because the numbers happen to differ.
    verdict: compare(refClose, value, r.uncertainty ?? 0),
    touchedByDaily: touched(refBar, value, r.uncertainty ?? 0),
    bars: candles.length,
  };
}

function kijunCell(
  ich: IchimokuSeries,
  candles: readonly Candle[],
  timeframe: Timeframe,
  refBar: Candle,
  withCross: boolean,
): KijunCellResult {
  const i = candles.length - 1;
  const value = ich.kijun[i] ?? null;
  const refClose = candles[i]?.close ?? 0;

  let crossedBelowToday = false;
  let crossedAboveToday = false;
  if (withCross && i >= 1) {
    // Each bar is compared against ITS OWN Kijun. Applying today's level to yesterday's
    // candle would invent crosses that never happened.
    const prevAbove = compare(candles[i - 1]!.close, ich.kijun[i - 1] ?? null) === 'above';
    const nowAbove = compare(refClose, value) === 'above';
    crossedBelowToday = prevAbove && !nowAbove;
    crossedAboveToday = !prevAbove && nowAbove;
  }

  return {
    timeframe,
    value,
    verdict: compare(refClose, value),
    touchedByDaily: touched(refBar, value),
    crossedBelowToday,
    crossedAboveToday,
  };
}

function cloudCell(candles: readonly Candle[], ich: IchimokuSeries, timeframe: Timeframe): CloudCellResult {
  const i = candles.length - 1;
  const state = cloudStateAt(candles, ich, i);
  const close = candles[i]!.close;
  const noTop = ich.cloudTopNoOffset[i] ?? null;
  const noBottom = ich.cloudBottomNoOffset[i] ?? null;
  const noOffsetPosition =
    noTop === null || noBottom === null ? 'unknown' : close > noTop ? 'above' : close < noBottom ? 'below' : 'in';
  return { ...state, timeframe, noOffsetPosition };
}

export function analyseCoin(coin: CoinInput, ctx: MarketContext): CoinSignals | null {
  const { params } = ctx;
  const idx = referenceIndex(coin.daily);
  if (idx < 0) return null;

  const base = coin.daily.slice(0, idx + 1);
  const c0 = base[idx]!;
  const c1 = base[idx - 1];
  const livePartial = coin.daily[idx + 1];

  const dailyIch = ichimoku(base, params.ichimoku);
  const weekly = aggregate(base, 'weekly');
  const monthly = aggregate(base, 'monthly');
  const weeklyIch = ichimoku(weekly, params.ichimoku);

  const notes: string[] = [];
  const minDailyBars = params.ichimoku.senkouB + params.ichimoku.displacement;
  if (base.length < minDailyBars) {
    notes.push(`only ${base.length} daily candles; the daily cloud needs ${minDailyBars}`);
  }

  // --- {coin}/BTC, synthesised (see src/data/ratio.ts for why) ---
  const isBtc = coin.id === ctx.btcId;
  // BTC/BTC is 1.0 on every bar, so its Kijun is 1.0 too and the comparison lands on "at",
  // which would otherwise read as "not beating BTC" and wrongly flag BTC as preferBtc.
  const btcBase = ctx.btcDaily.slice(0, referenceIndex(ctx.btcDaily) + 1);
  const ratio = isBtc ? [] : syntheticBtcRatio(base, btcBase);
  let btc: BtcRelative = { coinBtcInTrend: null, preferBtc: null, kijun: null, close: null, synthetic: true, bars: ratio.length };
  if (ratio.length > 0) {
    const rIch = ichimoku(ratio, params.ichimoku);
    const j = ratio.length - 1;
    const kij = rIch.kijun[j] ?? null;
    const cl = ratio[j]!.close;
    const inTrend = kij === null ? null : compare(cl, kij) === 'above';
    btc = {
      coinBtcInTrend: inTrend,
      // Bowie's rule: coin/BTC below its Kijun while BTC itself is above its own -> hold BTC.
      preferBtc: inTrend === null ? null : ctx.btcInTrend && !inTrend,
      kijun: kij,
      close: cl,
      synthetic: true,
      bars: ratio.length,
    };
  } else if (!isBtc) {
    notes.push('no overlapping days with BTC, so the coin/BTC filter is unavailable');
  }

  const cells = emaCells(params).map((c) => {
    const series = c.timeframe === 'daily' ? base : c.timeframe === 'weekly' ? weekly : monthly;
    return emaCell(series, c.period, c.timeframe, c0, params.ema.convergence);
  });

  const kijun = {
    daily: kijunCell(dailyIch, base, 'daily', c0, true),
    weekly: kijunCell(weeklyIch, weekly, 'weekly', c0, false),
  };
  const cloud = {
    daily: cloudCell(base, dailyIch, 'daily'),
    weekly: cloudCell(weekly, weeklyIch, 'weekly'),
  };

  const inTrend = kijun.daily.verdict === 'above';
  const score = scoreCoin({ kijun, cloud, ema: cells, btc }, params);

  return {
    id: coin.id,
    symbol: coin.symbol,
    name: coin.name,
    rank: coin.rank,
    marketCapUsd: coin.marketCapUsd,

    asOf: iso(c0.openTime),
    closeUsd: c0.close,
    changePct: c1 && c1.close > 0 ? ((c0.close - c1.close) / c1.close) * 100 : null,
    live: livePartial
      ? { closeUsd: livePartial.close, verdictVsDailyKijun: compare(livePartial.close, kijun.daily.value) }
      : null,

    kijun,
    cloud,
    ema: cells,
    btc,
    kijunAux: dailyIch.kijunAux[idx] ?? null,

    inTrend,
    droppedOutToday: kijun.daily.crossedBelowToday,
    owned: ctx.owned.has(coin.symbol.toUpperCase()),

    score,
    dataQuality: { dailyBars: base.length, weeklyBars: weekly.length, monthlyBars: monthly.length, notes },
  };
}

/**
 * Split `total` into `n` parts of whole cents that sum back to exactly `total`.
 * The first parts absorb the remainder, so 20 over 6 becomes 3.34 3.34 3.33 3.33 3.33 3.33.
 */
function distribute(total: number, n: number): number[] {
  if (n <= 0) return [];
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  let left = cents - base * n;
  return Array.from({ length: n }, () => (base + (left-- > 0 ? 1 : 0)) / 100);
}

interface ScoreInput {
  kijun: { daily: KijunCellResult; weekly: KijunCellResult };
  cloud: { daily: CloudCellResult; weekly: CloudCellResult };
  ema: EmaCellResult[];
  btc: BtcRelative;
}

/**
 * Fully additive so any total can be traced back to the cells that produced it.
 *
 * A cell that cannot be judged - no history, or an EMA too unconverged to give a verdict -
 * scores nothing AND is removed from the maximum, so a young coin is neither silently
 * rewarded nor silently punished for data it could not have.
 */
export function scoreCoin(s: ScoreInput, params: Params): ScoreResult {
  const w = params.score;
  const breakdown: ScoreResult['breakdown'] = [];

  // Round each part, then sum the rounded parts. Doing it the other way round leaves a report
  // whose columns visibly do not add up to its own total, which reads as a bug.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const add = (label: string, got: number, of: number, counted: boolean) => {
    breakdown.push({ label, got: counted ? round2(got) : 0, of: round2(of), counted });
  };

  add('Kijun daily', s.kijun.daily.verdict === 'above' ? w.kijunDaily : 0, w.kijunDaily, s.kijun.daily.verdict !== 'unknown');
  add('Kijun weekly', s.kijun.weekly.verdict === 'above' ? w.kijunWeekly : 0, w.kijunWeekly, s.kijun.weekly.verdict !== 'unknown');
  add('coin/BTC above Kijun', s.btc.coinBtcInTrend ? w.coinBtcInTrend : 0, w.coinBtcInTrend, s.btc.coinBtcInTrend !== null);

  const cloudPoints = (pos: CloudCellResult['position'], t: { above: number; in: number; below: number }) =>
    pos === 'above' ? t.above : pos === 'in' ? t.in : 0;
  add('Cloud daily', cloudPoints(s.cloud.daily.position, w.cloudDaily), w.cloudDaily.above, s.cloud.daily.position !== 'unknown');
  add('Cloud weekly', cloudPoints(s.cloud.weekly.position, w.cloudWeekly), w.cloudWeekly.above, s.cloud.weekly.position !== 'unknown');

  // Six cells sharing 20 points is 3.333... each, which does not survive rounding to cents.
  // Distribute the remainder instead, so the printed columns really do add up to the total.
  const shares = distribute(w.emaTotal, s.ema.length);
  s.ema.forEach((cell, i) => {
    const of = shares[i] ?? 0;
    add(`EMA${cell.period} ${cell.timeframe}`, cell.verdict === 'above' ? of : 0, of, cell.state === 'ok');
  });

  let points = 0;
  let max = 0;
  let unavailable = 0;
  for (const b of breakdown) {
    if (b.counted) {
      points += b.got;
      max += b.of;
    } else {
      unavailable += b.of;
    }
  }
  return { points: round2(points), max: round2(max), unavailable: round2(unavailable), breakdown };
}
