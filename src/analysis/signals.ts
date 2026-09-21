import type { Candle } from '../types.ts';
import type { Params } from '../config.ts';
import { syntheticBtcRatio } from '../data/ratio.ts';
import { compare, type Verdict } from '../indicators/predicates.ts';
import {
  buildMetricSet,
  opportunityScore,
  takeProfitScore,
  type ExtraScore,
  type MetricBase,
  type MetricSet,
  type CloudCellResult,
  type EmaCellResult,
  type KijunCellResult,
  type LevelRef,
} from './metrics.ts';

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
 * ## Two bases, one primary
 *
 * Every indicator is computed twice: once on the USD candles and once on the synthetic
 * {coin}/BTC candles. Which of the two the app reports on is decided by BTC itself — see the
 * module docs of `metrics.ts`. Both sets always travel in the report, so the front end can
 * show either without a second run.
 */

export type { CloudCellResult, EmaCellResult, KijunCellResult, LevelRef, MetricBase, MetricSet };

/**
 * Which drawer the coin has landed in. This is the app's whole vocabulary: everything else
 * is evidence for one of these four words.
 */
export type Bucket = 'buitenkans' | 'winst-pakken' | 'verkopen' | 'houden';

/** Where the proceeds of a sale should go, when a coin lands in `verkopen`. */
export type SellInto = 'btc' | 'eur';

export interface BtcRelative {
  /** Is the {coin}/BTC series above its own daily Kijun? */
  coinBtcInTrend: boolean | null;
  /** BTC is in trend but this coin is not beating it — Bowie would rather hold BTC. */
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
  live: { closeUsd: number; changePct: number | null; verdictVsDailyKijun: Verdict } | null;

  /** Indicators on the USD candles. */
  usd: MetricSet;
  /** Indicators on the synthetic {coin}/BTC candles. Null for BTC itself and for coins with no overlap. */
  btcPair: MetricSet | null;
  /** Which of the two the score, the bucket and the default view are built on. */
  primaryBase: MetricBase;

  /** Kept as a compact summary for the portfolio simulation and the notification. */
  btc: BtcRelative;

  bucket: Bucket;
  /** Only set when `bucket === 'verkopen'`. */
  sellInto: SellInto | null;
  /** One sentence in Dutch explaining why the coin is in that bucket. */
  bucketReason: string;

  opportunity: ExtraScore;
  takeProfit: ExtraScore;

  /** `primary.inTrend` — kept as a top-level field because half the app asks for it. */
  inTrend: boolean;
  droppedOutToday: boolean;
  owned: boolean;

  score: ScoreResult;
  dataQuality: { dailyBars: number; weeklyBars: number; monthlyBars: number; btcPairBars: number; notes: string[] };
}

export interface MarketContext {
  params: Params;
  /** BTC's daily candles, used for the synthetic ratio and for the base switch. */
  btcDaily: readonly Candle[];
  /** BTC's own coin id, so BTC is not compared against itself. */
  btcId: string;
  /**
   * Is BTC itself above its daily Kijun at C0? This one boolean decides the whole app's
   * frame of reference: above, everything is measured against BTC; below, against dollars.
   */
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

/** The metric set the score and the bucket are built on. */
export function primaryOf(c: Pick<CoinSignals, 'usd' | 'btcPair' | 'primaryBase'>): MetricSet {
  return c.primaryBase === 'btc' && c.btcPair ? c.btcPair : c.usd;
}

export function analyseCoin(coin: CoinInput, ctx: MarketContext): CoinSignals | null {
  const { params } = ctx;
  const idx = referenceIndex(coin.daily);
  if (idx < 0) return null;

  const base = coin.daily.slice(0, idx + 1);
  const c0 = base[idx]!;
  const c1 = base[idx - 1];
  const livePartial = coin.daily[idx + 1];

  const notes: string[] = [];
  const minDailyBars = params.ichimoku.senkouB + params.ichimoku.displacement;
  if (base.length < minDailyBars) {
    notes.push(`slechts ${base.length} dagcandles; de daily cloud heeft er ${minDailyBars} nodig`);
  }

  const usd = buildMetricSet(base, params, 'usd');
  if (!usd) return null;

  // --- {coin}/BTC, synthesised (see src/data/ratio.ts for why) ---
  // BTC/BTC is 1.0 on every bar, so every one of its levels would sit exactly on the price
  // and every verdict would read "at". BTC is therefore scored on dollars, always.
  const isBtc = coin.id === ctx.btcId;
  const btcBase = ctx.btcDaily.slice(0, referenceIndex(ctx.btcDaily) + 1);
  const ratio = isBtc ? [] : syntheticBtcRatio(base, btcBase);
  const btcPair = ratio.length > 0 ? buildMetricSet(ratio, params, 'btc') : null;
  if (!isBtc && !btcPair) notes.push('geen overlappende dagen met BTC, dus de BTC-basis ontbreekt');

  const btc: BtcRelative = {
    coinBtcInTrend: btcPair ? btcPair.kijun.daily.verdict === 'above' : null,
    // Bowie's rule: coin/BTC below its Kijun while BTC itself is above its own -> hold BTC.
    preferBtc: btcPair ? ctx.btcInTrend && btcPair.kijun.daily.verdict !== 'above' : null,
    kijun: btcPair?.kijun.daily.value ?? null,
    close: btcPair?.close ?? null,
    synthetic: true,
    bars: ratio.length,
  };

  const primaryBase: MetricBase = ctx.btcInTrend && btcPair ? 'btc' : 'usd';
  const primary = primaryBase === 'btc' && btcPair ? btcPair : usd;

  const opportunity = opportunityScore(primary, params);
  const takeProfit = takeProfitScore(primary, params);
  const { bucket, sellInto, bucketReason } = classify(primary, primaryBase, ctx.btcInTrend, opportunity, takeProfit, params);

  const score = scoreCoin({ primary, other: primaryBase === 'btc' ? usd : btcPair }, params);

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
      ? {
          closeUsd: livePartial.close,
          changePct: c0.close > 0 ? ((livePartial.close - c0.close) / c0.close) * 100 : null,
          verdictVsDailyKijun: compare(livePartial.close, usd.kijun.daily.value),
        }
      : null,

    usd,
    btcPair,
    primaryBase,
    btc,

    bucket,
    sellInto,
    bucketReason,
    opportunity,
    takeProfit,

    inTrend: primary.inTrend,
    droppedOutToday: primary.kijun.daily.crossedBelowToday,
    owned: ctx.owned.has(coin.symbol.toUpperCase()),

    score,
    dataQuality: {
      dailyBars: usd.bars.daily,
      weeklyBars: usd.bars.weekly,
      monthlyBars: usd.bars.monthly,
      btcPairBars: ratio.length,
      notes,
    },
  };
}

/* ------------------------------------------------------------------ buckets */

const BASE_WORD: Record<MetricBase, string> = { usd: 'in dollars', btc: 'tegen BTC' };

/**
 * The four drawers.
 *
 * Order matters and is not arbitrary. Falling through the daily Kijun overrides everything —
 * no retest is worth anything once the trend line is gone. Above it, a coin can genuinely be
 * both a fresh entry and close to resistance at the same time, so the stronger of the two
 * scores decides, with a tie going to `buitenkans`.
 *
 * Both extra scores have to clear a floor first. Some level is almost always within a few
 * percent of some price, so without a minimum the two interesting drawers would hold most of
 * the market and `houden` would be empty — the exact opposite of what they are for.
 */
function classify(
  primary: MetricSet,
  base: MetricBase,
  btcInTrend: boolean,
  opportunity: ExtraScore,
  takeProfit: ExtraScore,
  params: Params,
): { bucket: Bucket; sellInto: SellInto | null; bucketReason: string } {
  const where = BASE_WORD[base];
  const kans = opportunity.points >= params.levels.minOpportunity ? opportunity.points : 0;
  const winst = takeProfit.points >= params.levels.minTakeProfit ? takeProfit.points : 0;

  if (primary.kijun.daily.verdict === 'below') {
    // When BTC still holds its own Kijun it is the safer place to stand; when it does not,
    // there is nothing left to rotate into and the exit is to euros.
    const sellInto: SellInto = btcInTrend ? 'btc' : 'eur';
    return {
      bucket: 'verkopen',
      sellInto,
      bucketReason:
        `Onder de daily Kijun-sen ${where}. ` +
        (sellInto === 'btc'
          ? 'BTC staat zelf nog boven zijn Kijun, dus verkoop naar BTC.'
          : 'BTC staat zelf ook onder zijn Kijun, dus verkoop naar euro.'),
    };
  }

  if (primary.kijun.daily.verdict !== 'above') {
    return {
      bucket: 'houden',
      sellInto: null,
      bucketReason: `Er is nog geen daily Kijun-sen ${where} om tegen af te meten.`,
    };
  }

  if (kans > 0 && kans >= winst) {
    const top = opportunity.contributions[0]!;
    return {
      bucket: 'buitenkans',
      sellInto: null,
      bucketReason: `Boven de daily Kijun-sen ${where}, met een ${top.detail} op ${top.label}.`,
    };
  }

  if (winst > 0) {
    const top = takeProfit.contributions[0]!;
    return {
      bucket: 'winst-pakken',
      sellInto: null,
      bucketReason: `Boven de daily Kijun-sen ${where}, maar loopt tegen ${top.label} aan — ${top.detail}.`,
    };
  }

  return {
    bucket: 'houden',
    sellInto: null,
    bucketReason:
      opportunity.points > 0 || takeProfit.points > 0
        ? `Boven de daily Kijun-sen ${where}. Er is wel wat beweging rond de niveaus, maar te weinig om een bakje te rechtvaardigen.`
        : `Boven de daily Kijun-sen ${where}, zonder verse test of niveau in de buurt.`,
  };
}

/* ------------------------------------------------------------------ score */

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

export interface ScoreInput {
  /** The series in charge: {coin}/BTC while BTC is in trend, USD otherwise. */
  primary: MetricSet;
  /** The other one, worth 20 points as confirmation. Null when it does not exist. */
  other: MetricSet | null;
}

/**
 * Fully additive so any total can be traced back to the cells that produced it.
 *
 * A cell that cannot be judged — no history, or an EMA too unconverged to give a verdict —
 * scores nothing AND is removed from the maximum, so a young coin is neither silently
 * rewarded nor silently punished for data it could not have.
 *
 * Every cell here is read off the PRIMARY series. The one exception is `confirmation`: the
 * daily Kijun of the other base, which is what separates a coin that is winning against both
 * bitcoin and the dollar from one that is only winning against whichever happens to be in
 * charge today.
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

  const p = s.primary;
  add('Kijun daily', p.kijun.daily.verdict === 'above' ? w.kijunDaily : 0, w.kijunDaily, p.kijun.daily.verdict !== 'unknown');
  add('Kijun weekly', p.kijun.weekly.verdict === 'above' ? w.kijunWeekly : 0, w.kijunWeekly, p.kijun.weekly.verdict !== 'unknown');

  const otherKijun = s.other?.kijun.daily;
  add(
    'confirmation',
    otherKijun?.verdict === 'above' ? w.confirmation : 0,
    w.confirmation,
    otherKijun !== undefined && otherKijun.verdict !== 'unknown',
  );

  const cloudPoints = (pos: CloudCellResult['position'], t: { above: number; in: number; below: number }) =>
    pos === 'above' ? t.above : pos === 'in' ? t.in : 0;
  add('Cloud daily', cloudPoints(p.cloud.daily.position, w.cloudDaily), w.cloudDaily.above, p.cloud.daily.position !== 'unknown');
  add('Cloud weekly', cloudPoints(p.cloud.weekly.position, w.cloudWeekly), w.cloudWeekly.above, p.cloud.weekly.position !== 'unknown');

  // Six cells sharing 20 points is 3.333... each, which does not survive rounding to cents.
  // Distribute the remainder instead, so the printed columns really do add up to the total.
  const shares = distribute(w.emaTotal, p.ema.length);
  p.ema.forEach((cell, i) => {
    const of = shares[i] ?? 0;
    // Counted whenever the verdict is DEFINITE. `compare` already widened its neutral band by
    // the EMA's own uncertainty, so an "above" here means above even under the worst-case
    // seed — demanding full convergence on top of that would drop cells whose answer is not
    // actually in doubt, and empty most of the monthly column for no gain.
    const decided = cell.verdict === 'above' || cell.verdict === 'below';
    add(`EMA${cell.period} ${cell.timeframe}`, cell.verdict === 'above' ? of : 0, of, decided);
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
