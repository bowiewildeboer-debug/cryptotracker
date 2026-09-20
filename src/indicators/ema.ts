import type { Series } from '../types.ts';

export interface EmaResult {
  /** The EMA series, seeded with SMA(n) at index n-1. `null` before that. */
  values: Series;
  /** Number of source values fed in. */
  bars: number;
  /** The period. */
  period: number;
  /**
   * A hard upper bound on how much the LAST value could differ purely because of the
   * seed choice, in absolute price units. See the derivation in the module docs below.
   * `null` when there is no value at all.
   */
  uncertainty: number | null;
}

/**
 * Exponential moving average, matching TradingView's recursion.
 *
 *   alpha    = 2 / (n + 1)
 *   ema[n-1] = sma(src, n)                              // SMA seed
 *   ema[t]   = alpha*src[t] + (1-alpha)*ema[t-1]
 *
 * ## Why `uncertainty` instead of a bar-count rule of thumb
 *
 * The recursion is linear, so two different seeds s1 and s2 produce series that differ by
 * exactly `(s1 - s2) * (1-alpha)^k` after k further bars. The true seed (the value an EMA
 * with infinite history would have had at index n-1) is unknown, but it must lie within the
 * high/low range of the seed window. Therefore
 *
 *   uncertainty = (max(src[0..n-1]) - min(src[0..n-1])) * (1-alpha)^(bars - n)
 *
 * is a genuine upper bound on the seed-induced error of the last value — not a heuristic.
 *
 * Callers must use it: a coin only gets a green "above the EMA" tick when
 * `close > ema + uncertainty`, and a red cross only when `close < ema - uncertainty`.
 * Anything in between is genuinely undecidable from the available history and scores 0.
 * Without this, an alt with 30 weekly candles would get a confident tick on a weekly EMA100.
 */
export function ema(src: readonly number[], period: number): EmaResult {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`ema period must be a positive integer, got ${period}`);
  }
  const bars = src.length;
  const values: Series = new Array<number | null>(bars).fill(null);

  if (bars < period) {
    return { values, bars, period, uncertainty: null };
  }

  const alpha = 2 / (period + 1);

  let sum = 0;
  let seedMin = Infinity;
  let seedMax = -Infinity;
  for (let i = 0; i < period; i++) {
    const v = src[i]!;
    sum += v;
    if (v < seedMin) seedMin = v;
    if (v > seedMax) seedMax = v;
  }

  let prev = sum / period;
  values[period - 1] = prev;

  for (let t = period; t < bars; t++) {
    prev = alpha * src[t]! + (1 - alpha) * prev;
    values[t] = prev;
  }

  const warmup = bars - period;
  const uncertainty = (seedMax - seedMin) * Math.pow(1 - alpha, warmup);

  return { values, bars, period, uncertainty };
}
