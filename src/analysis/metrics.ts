import type { Candle, Timeframe } from '../types.ts';
import type { Params } from '../config.ts';
import { emaCells } from '../config.ts';
import { aggregate } from '../data/aggregate.ts';
import { ichimoku, cloudStateAt, type IchimokuSeries, type CloudState } from '../indicators/ichimoku.ts';
import { ema } from '../indicators/ema.ts';
import { compare, touched, type Verdict } from '../indicators/predicates.ts';

/**
 * One complete indicator reading of a single price series.
 *
 * ## Why this exists as its own module
 *
 * Bowie's base metric is no longer "the coin in dollars". It is **the coin priced in BTC**,
 * because that is the only series that answers the question he actually asks every morning:
 * am I gaining or losing ground against simply holding bitcoin? So the same Kijun, the same
 * cloud and the same EMA grid have to be computed twice — once on the USD candles and once
 * on the synthetic {coin}/BTC candles — and the app has to be able to show either.
 *
 * Which of the two is authoritative depends on BTC itself:
 *
 * * **BTC above its own daily Kijun** → the BTC-quoted set leads. Rotating into BTC is a real
 *   alternative, so an altcoin has to beat it to be worth owning.
 * * **BTC below its own daily Kijun** → the USD set leads. Beating a falling BTC is no
 *   achievement, and the only meaningful question left is whether the coin holds up in money.
 *
 * Everything downstream (buckets, score, tabs) reads `primary`, so that switch happens in
 * exactly one place.
 */

export type MetricBase = 'usd' | 'btc';
export type LevelFamily = 'kijun' | 'cloud' | 'ema';

export interface EmaCellResult {
  period: number;
  timeframe: Timeframe;
  value: number | null;
  /** Upper bound on the seed-induced error of `value`, in price units. */
  uncertainty: number | null;
  /**
   * How converged the EMA is. This drives DISPLAY only (a provisional value is greyed).
   * Whether the cell can be scored is decided by `verdict`, which already has the
   * uncertainty folded into its neutral band.
   */
  state: 'ok' | 'provisional' | 'na';
  verdict: Verdict;
  /** Did the reference candle touch this level? */
  touchedByRef: boolean;
  bars: number;
}

export interface KijunCellResult {
  timeframe: Timeframe;
  value: number | null;
  verdict: Verdict;
  touchedByRef: boolean;
  /** Daily only: was it above on the previous bar and not on this one? */
  crossedBelowToday: boolean;
  crossedAboveToday: boolean;
}

export interface CloudCellResult extends CloudState {
  timeframe: Timeframe;
  /** The undisplaced reading, kept for reference; never drives the table or the score. */
  noOffsetPosition: CloudState['position'];
}

/** A single comparable price level, before the retest/approach analysis is layered on. */
export interface LevelSample {
  key: string;
  label: string;
  family: LevelFamily;
  timeframe: Timeframe;
  /** Relative importance, from `params.levels.weights`. Drives both extra scores. */
  weight: number;
  value: number | null;
  /** Neutral band around `value`; non-zero only for an unconverged EMA. */
  uncertainty: number;
}

export interface RetestEvent {
  /** 0 = the reference bar itself, 1 = the bar before it, and so on. */
  barsAgo: number;
  /**
   * `retest` — the bar came back down to a level it was already above and closed above it
   * again: the textbook support test. `reclaim` — it was below the level and closed above it
   * for the first time, having touched it on the way. Both are buying signals; a retest of an
   * established level is the stronger of the two.
   */
  kind: 'retest' | 'reclaim';
}

export interface LevelRef extends LevelSample {
  verdict: Verdict;
  /**
   * How far the close is from the level, as a percentage OF THE CLOSE: how much the price
   * has to move to get there. Positive means the level sits above the close.
   */
  gapPct: number | null;
  /** Did the reference candle's range touch this level? */
  touchedByRef: boolean;
  /** The freshest successful test inside the window, or null. */
  retest: RetestEvent | null;
  /** The level is overhead and within `params.levels.approachPct` of the close. */
  approaching: boolean;
}

export interface MetricSet {
  base: MetricBase;
  /** Reference close of this series: USD for `usd`, BTC per coin for `btc`. */
  close: number;
  kijun: { daily: KijunCellResult; weekly: KijunCellResult };
  cloud: { daily: CloudCellResult; weekly: CloudCellResult };
  ema: EmaCellResult[];
  levels: LevelRef[];
  /** Shorthand for `kijun.daily.verdict === 'above'` — the single most-used fact in the app. */
  inTrend: boolean;
  bars: { daily: number; weekly: number; monthly: number };
}

/* ------------------------------------------------------------------ snapshots */

interface Snapshot {
  bar: Candle;
  close: number;
  kijun: { daily: KijunCellResult; weekly: KijunCellResult };
  cloud: { daily: CloudCellResult; weekly: CloudCellResult };
  ema: EmaCellResult[];
  levels: LevelSample[];
  bars: { daily: number; weekly: number; monthly: number };
}

const TF_SUFFIX: Record<Timeframe, string> = { daily: 'D', weekly: 'W', monthly: 'M' };

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
    touchedByRef: touched(refBar, value, r.uncertainty ?? 0),
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

  return { timeframe, value, verdict: compare(refClose, value), touchedByRef: touched(refBar, value), crossedBelowToday, crossedAboveToday };
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

/**
 * Every indicator of one series as it stood at the close of daily bar `end`.
 *
 * Weekly and monthly series are rebuilt from the daily candles TRUNCATED AT `end`, never
 * sliced off the current ones. That is what makes a retest three days ago answerable: "did
 * that day's candle touch the weekly Kijun?" needs the weekly Kijun as it was on that day.
 */
export function snapshotAt(daily: readonly Candle[], end: number, params: Params): Snapshot | null {
  if (end < 0 || end >= daily.length) return null;
  const base = daily.slice(0, end + 1);
  const refBar = base[end]!;

  const weekly = aggregate(base, 'weekly');
  const monthly = aggregate(base, 'monthly');
  const dailyIch = ichimoku(base, params.ichimoku);
  const weeklyIch = ichimoku(weekly, params.ichimoku);

  const kijun = {
    daily: kijunCell(dailyIch, base, 'daily', refBar, true),
    weekly: kijunCell(weeklyIch, weekly, 'weekly', refBar, false),
  };
  const cloud = { daily: cloudCell(base, dailyIch, 'daily'), weekly: cloudCell(weekly, weeklyIch, 'weekly') };
  const emaResults = emaCells(params).map((c) => {
    const series = c.timeframe === 'daily' ? base : c.timeframe === 'weekly' ? weekly : monthly;
    return emaCell(series, c.period, c.timeframe, refBar, params.ema.convergence);
  });

  const w = params.levels.weights;
  const levels: LevelSample[] = [];
  for (const tf of ['daily', 'weekly'] as const) {
    levels.push({
      key: `kijun-${tf}`,
      label: `Kijun-sen ${tf === 'daily' ? 'daily' : 'weekly'}`,
      family: 'kijun',
      timeframe: tf,
      weight: w.kijun[tf] ?? 0,
      value: kijun[tf].value,
      uncertainty: 0,
    });
    const c = cloud[tf];
    // Top and bottom are separate levels on purpose: coming down, the cloud TOP is the
    // support that gets retested; coming up, the BOTTOM is the first resistance met.
    levels.push({
      key: `cloudtop-${tf}`,
      label: `Cloud ${tf === 'daily' ? 'daily' : 'weekly'} bovenkant`,
      family: 'cloud',
      timeframe: tf,
      weight: w.cloud[tf] ?? 0,
      value: c.top,
      uncertainty: 0,
    });
    levels.push({
      key: `cloudbot-${tf}`,
      label: `Cloud ${tf === 'daily' ? 'daily' : 'weekly'} onderkant`,
      family: 'cloud',
      timeframe: tf,
      weight: w.cloud[tf] ?? 0,
      value: c.bottom,
      uncertainty: 0,
    });
  }
  for (const cell of emaResults) {
    levels.push({
      key: `ema${cell.period}-${cell.timeframe}`,
      label: `EMA ${cell.period} ${TF_SUFFIX[cell.timeframe]}`,
      family: 'ema',
      timeframe: cell.timeframe,
      weight: w.ema[cell.timeframe] ?? 0,
      value: cell.value,
      uncertainty: cell.uncertainty ?? 0,
    });
  }

  return {
    bar: refBar,
    close: refBar.close,
    kijun,
    cloud,
    ema: emaResults,
    levels,
    bars: { daily: base.length, weekly: weekly.length, monthly: monthly.length },
  };
}

/* ------------------------------------------------------------------ retest & approach */

/** Did this bar test the level and hold above it? */
function heldAbove(snap: Snapshot, sample: LevelSample): boolean {
  if (sample.value === null) return false;
  return touched(snap.bar, sample.value, sample.uncertainty) && compare(snap.close, sample.value, sample.uncertainty) === 'above';
}

function wasAbove(snap: Snapshot | null, key: string): boolean {
  if (!snap) return false;
  const s = snap.levels.find((l) => l.key === key);
  if (!s || s.value === null) return false;
  return compare(snap.close, s.value, s.uncertainty) === 'above';
}

/**
 * The freshest successful test of `key` inside the window.
 *
 * "Successful" is deliberately strict: the bar's range had to reach the level AND its close
 * had to finish above it. A wick through the line that closed below is a failed test and is
 * the opposite of a buy signal, so it must never register here.
 */
function findRetest(snaps: (Snapshot | null)[], key: string, window: number): RetestEvent | null {
  for (let barsAgo = 0; barsAgo < window; barsAgo++) {
    const snap = snaps[barsAgo];
    if (!snap) continue;
    const sample = snap.levels.find((l) => l.key === key);
    if (!sample || !heldAbove(snap, sample)) continue;
    return { barsAgo, kind: wasAbove(snaps[barsAgo + 1] ?? null, key) ? 'retest' : 'reclaim' };
  }
  return null;
}

function buildLevelRefs(snaps: (Snapshot | null)[], params: Params): LevelRef[] {
  const now = snaps[0]!;
  const window = params.levels.retestWindowDays;
  const near = params.levels.approachPct;

  return now.levels.map((s) => {
    const verdict = compare(now.close, s.value, s.uncertainty);
    const gapPct = s.value === null || now.close <= 0 ? null : ((s.value - now.close) / now.close) * 100;
    const touchedByRef = touched(now.bar, s.value, s.uncertainty);
    // A level only counts as a completed test while the price is still above it; a level the
    // price has since fallen back through was not a successful test after all.
    const retest = verdict === 'above' ? findRetest(snaps, s.key, window) : null;
    const approaching = gapPct !== null && gapPct > 0 && gapPct <= near;
    return { ...s, verdict, gapPct, touchedByRef, retest, approaching };
  });
}

/* ------------------------------------------------------------------ the metric set */

/**
 * Builds the full metric set for one series.
 *
 * `daily` must already be truncated to the last CLOSED candle — this function makes no
 * judgement about which bar is the reference one.
 */
export function buildMetricSet(daily: readonly Candle[], params: Params, base: MetricBase): MetricSet | null {
  const end = daily.length - 1;
  // One extra snapshot beyond the window, so the oldest bar in it can still be classified as
  // a retest (was it already above?) rather than a reclaim.
  const snaps: (Snapshot | null)[] = [];
  for (let back = 0; back <= params.levels.retestWindowDays; back++) {
    snaps.push(snapshotAt(daily, end - back, params));
  }
  const now = snaps[0];
  if (!now) return null;

  return {
    base,
    close: now.close,
    kijun: now.kijun,
    cloud: now.cloud,
    ema: now.ema,
    levels: buildLevelRefs(snaps, params),
    inTrend: now.kijun.daily.verdict === 'above',
    bars: now.bars,
  };
}

/* ------------------------------------------------------------------ extra scores */

export interface ExtraScore {
  points: number;
  contributions: { key: string; label: string; points: number; detail: string }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * "Buitenkans" — how strong is the case that this coin just got a green light?
 *
 * Every level that was successfully retested inside the window contributes its own weight,
 * scaled down by how long ago it happened and by whether it was a true retest or a first
 * reclaim. Several levels tested at once is the real signal, so the contributions add up;
 * the total is capped at 100 so the number stays readable next to the main score.
 */
export function opportunityScore(set: MetricSet, params: Params): ExtraScore {
  const window = params.levels.retestWindowDays;
  const contributions: ExtraScore['contributions'] = [];
  let raw = 0;

  for (const l of set.levels) {
    if (!l.retest) continue;
    const freshness = (window - l.retest.barsAgo) / window;
    const kindFactor = l.retest.kind === 'retest' ? 1 : params.levels.reclaimFactor;
    const pts = l.weight * freshness * kindFactor;
    raw += pts;
    const when = l.retest.barsAgo === 0 ? 'op de laatste dag' : `${l.retest.barsAgo} ${l.retest.barsAgo === 1 ? 'dag' : 'dagen'} geleden`;
    contributions.push({
      key: l.key,
      label: l.label,
      points: round1(pts),
      detail: `${l.retest.kind === 'retest' ? 'geslaagde retest' : 'teruggepakt'} ${when}`,
    });
  }

  contributions.sort((a, b) => b.points - a.points);
  return { points: round1(Math.min(100, raw)), contributions };
}

/**
 * "Winst pakken" — how much resistance is the price about to run into?
 *
 * The mirror image of the opportunity score. Only levels ABOVE the close count, weighted by
 * how close they already are; a level the reference candle has already tapped counts in full,
 * because the test is happening right now.
 */
export function takeProfitScore(set: MetricSet, params: Params): ExtraScore {
  const near = params.levels.approachPct;
  const contributions: ExtraScore['contributions'] = [];
  let raw = 0;

  for (const l of set.levels) {
    if (l.gapPct === null || l.gapPct <= 0) continue;
    if (!l.approaching && !l.touchedByRef) continue;
    const proximity = l.touchedByRef ? 1 : Math.max(0, 1 - l.gapPct / near);
    const pts = l.weight * proximity;
    if (pts <= 0) continue;
    raw += pts;
    contributions.push({
      key: l.key,
      label: l.label,
      points: round1(pts),
      detail: l.touchedByRef ? 'de koers raakt dit niveau nu' : `nog ${l.gapPct.toFixed(1)}% te gaan`,
    });
  }

  contributions.sort((a, b) => b.points - a.points);
  return { points: round1(Math.min(100, raw)), contributions };
}
