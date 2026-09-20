import type { Candle, Series } from '../types.ts';

/**
 * Donchian midpoint, the building block of every Ichimoku line.
 *
 *   donchian(len, t) = ( max(high[t-len+1..t]) + min(low[t-len+1..t]) ) / 2
 *
 * Computed on HIGH and LOW (never close), over a window that INCLUDES bar t.
 * This is what TradingView's Pine `donchian(len) => avg(lowest(len), highest(len))` does.
 *
 * Returns a series the same length as `candles`, with `null` for t < len-1.
 */
export function donchian(candles: readonly Candle[], len: number): Series {
  if (!Number.isInteger(len) || len < 1) {
    throw new RangeError(`donchian length must be a positive integer, got ${len}`);
  }
  const out: Series = new Array<number | null>(candles.length).fill(null);

  // Monotonic deques holding indices of candidate max-high and min-low.
  const maxDq: number[] = [];
  const minDq: number[] = [];

  for (let t = 0; t < candles.length; t++) {
    const bar = candles[t]!;

    while (maxDq.length > 0 && candles[maxDq[maxDq.length - 1]!]!.high <= bar.high) maxDq.pop();
    maxDq.push(t);
    while (minDq.length > 0 && candles[minDq[minDq.length - 1]!]!.low >= bar.low) minDq.pop();
    minDq.push(t);

    const windowStart = t - len + 1;
    if (maxDq[0]! < windowStart) maxDq.shift();
    if (minDq[0]! < windowStart) minDq.shift();

    if (windowStart >= 0) {
      out[t] = (candles[maxDq[0]!]!.high + candles[minDq[0]!]!.low) / 2;
    }
  }
  return out;
}
