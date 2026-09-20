import type { Candle, IchimokuParams, Series } from '../types.ts';
import { donchian } from './donchian.ts';
import { touched } from './predicates.ts';

export interface IchimokuSeries {
  params: IchimokuParams;
  /**
   * The actual plotted shift.
   *
   *   SHIFT = displacement - extraBars
   *
   * KryptoNight's script computes `displ = displacement - extra_bars` with `extra_bars`
   * defaulting to 1, which reproduces TradingView's own off-by-one (the built-in plots the
   * spans at `offset = displacement - 1`). For Bowie's displacement=35 that is 34, NOT 35.
   * Using 35 puts the whole cloud column one bar out of sync with what he sees on screen.
   */
  shift: number;

  tenkan: Series;
  kijun: Series;
  /**
   * The auxiliary base line. In the Pine source `baselineA` is assigned `donchian(len)` and
   * then passed to two plot() calls only — it appears in no fill(), no span calculation and
   * no entry/exit condition. It is exposed here as an extra flat support/resistance level
   * and must never enter the cloud or the score.
   */
  kijunAux: Series;

  /** Undisplaced Senkou Span A, i.e. the value as computed at bar t. */
  senkouARaw: Series;
  /** Undisplaced Senkou Span B. */
  senkouBRaw: Series;

  /** Classic Ichimoku: the cloud visible at bar t, from the spans computed `shift` bars ago. */
  cloudTopDisplaced: Series;
  cloudBottomDisplaced: Series;
  /** The script's "no offset" variant: the spans as computed at bar t, drawn at bar t. */
  cloudTopNoOffset: Series;
  cloudBottomNoOffset: Series;

  /** Whichever of the two pairs above `params.cloudMode` selects. Drives the table and score. */
  cloudTop: Series;
  cloudBottom: Series;

  /** Lagging span: close[t + shift]. Null for the last `shift` bars. */
  chikou: Series;
}

function pairwiseMid(a: Series, b: Series): Series {
  const out: Series = new Array<number | null>(a.length).fill(null);
  for (let t = 0; t < a.length; t++) {
    const x = a[t];
    const y = b[t];
    if (x !== null && x !== undefined && y !== null && y !== undefined) out[t] = (x + y) / 2;
  }
  return out;
}

function shiftForward(src: Series, by: number): Series {
  const out: Series = new Array<number | null>(src.length).fill(null);
  for (let t = by; t < src.length; t++) out[t] = src[t - by] ?? null;
  return out;
}

export function ichimoku(candles: readonly Candle[], params: IchimokuParams): IchimokuSeries {
  const shift = params.displacement - params.extraBars;
  if (shift < 0) throw new RangeError(`ichimoku shift must be >= 0, got ${shift}`);

  const tenkan = donchian(candles, params.tenkan);
  const kijun = donchian(candles, params.kijun);
  const kijunAux = donchian(candles, params.kijunAux);
  const senkouBRaw = donchian(candles, params.senkouB);

  let senkouARaw: Series;
  switch (params.senkouASource) {
    case 'tenkan+kijun':
      senkouARaw = pairwiseMid(tenkan, kijun);
      break;
    case 'tenkan+kijunAux':
      senkouARaw = pairwiseMid(tenkan, kijunAux);
      break;
    case 'kijun+kijunAux':
      senkouARaw = pairwiseMid(kijun, kijunAux);
      break;
  }

  const aDisp = shiftForward(senkouARaw, shift);
  const bDisp = shiftForward(senkouBRaw, shift);

  const cloudTopDisplaced = boundary(aDisp, bDisp, Math.max);
  const cloudBottomDisplaced = boundary(aDisp, bDisp, Math.min);
  const cloudTopNoOffset = boundary(senkouARaw, senkouBRaw, Math.max);
  const cloudBottomNoOffset = boundary(senkouARaw, senkouBRaw, Math.min);

  const useDisplaced = params.cloudMode === 'displaced';

  const chikou: Series = new Array<number | null>(candles.length).fill(null);
  for (let t = 0; t + shift < candles.length; t++) chikou[t] = candles[t + shift]!.close;

  return {
    params,
    shift,
    tenkan,
    kijun,
    kijunAux,
    senkouARaw,
    senkouBRaw,
    cloudTopDisplaced,
    cloudBottomDisplaced,
    cloudTopNoOffset,
    cloudBottomNoOffset,
    cloudTop: useDisplaced ? cloudTopDisplaced : cloudTopNoOffset,
    cloudBottom: useDisplaced ? cloudBottomDisplaced : cloudBottomNoOffset,
    chikou,
  };
}

/**
 * Senkou A and Senkou B swap order at every Kumo twist, so the cloud's top and bottom must
 * always be max/min of the pair. "Span A is the top" is wrong half the time.
 */
function boundary(a: Series, b: Series, pick: (x: number, y: number) => number): Series {
  const out: Series = new Array<number | null>(a.length).fill(null);
  for (let t = 0; t < a.length; t++) {
    const x = a[t];
    const y = b[t];
    if (x !== null && x !== undefined && y !== null && y !== undefined) out[t] = pick(x, y);
  }
  return out;
}

export type CloudPosition = 'above' | 'in' | 'below' | 'unknown';

export interface CloudState {
  position: CloudPosition;
  top: number | null;
  bottom: number | null;
  touchedTop: boolean;
  touchedBottom: boolean;
  /** Set instead of touchedTop/touchedBottom when the cloud has zero thickness (a twist bar). */
  touchedTwist: boolean;
  /**
   * How to read a boundary touch, decided by the PREVIOUS bar's position — not this one.
   * Touching the cloud from above is a support test; from below it is resistance.
   */
  boundaryTest: 'support' | 'resistance' | 'inside' | null;
}

export function positionVsCloud(close: number, top: number | null, bottom: number | null): CloudPosition {
  if (top === null || bottom === null) return 'unknown';
  if (close > top) return 'above';
  if (close < bottom) return 'below';
  return 'in';
}

export function cloudStateAt(candles: readonly Candle[], ich: IchimokuSeries, t: number): CloudState {
  const bar = candles[t];
  if (!bar) throw new RangeError(`cloudStateAt: index ${t} out of range`);

  const top = ich.cloudTop[t] ?? null;
  const bottom = ich.cloudBottom[t] ?? null;
  const position = positionVsCloud(bar.close, top, bottom);

  const isTwist = top !== null && bottom !== null && top === bottom;
  const hitTop = touched(bar, top);
  const hitBottom = touched(bar, bottom);

  let boundaryTest: CloudState['boundaryTest'] = null;
  if (hitTop || hitBottom) {
    const prevBar = candles[t - 1];
    const prevPos =
      prevBar === undefined
        ? 'unknown'
        : positionVsCloud(prevBar.close, ich.cloudTop[t - 1] ?? null, ich.cloudBottom[t - 1] ?? null);
    boundaryTest =
      prevPos === 'above' ? 'support' : prevPos === 'below' ? 'resistance' : prevPos === 'in' ? 'inside' : null;
  }

  return {
    position,
    top,
    bottom,
    touchedTop: isTwist ? false : hitTop,
    touchedBottom: isTwist ? false : hitBottom,
    touchedTwist: isTwist && (hitTop || hitBottom),
    boundaryTest,
  };
}
