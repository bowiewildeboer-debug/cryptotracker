import type { Candle, Timeframe } from '../types.ts';

const DAY_MS = 86_400_000;

/**
 * Start of the UTC week (Monday 00:00:00.000) containing `ts`.
 *
 * Binance's native `1w` candle opens Monday 00:00 UTC and closes Sunday 23:59:59.999 UTC —
 * verified empirically. All boundary maths must be in UTC: grouping in local Amsterdam time
 * shifts every weekly boundary by 1-2 hours and pulls Sunday-evening candles into the wrong
 * week, and the CET/CEST transition would change the offset halfway through the year.
 */
export function weekStartUtc(ts: number): number {
  const d = new Date(ts);
  const dayFromMonday = (d.getUTCDay() + 6) % 7; // Sunday(0) -> 6, Monday(1) -> 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dayFromMonday * DAY_MS;
}

/** Start of the UTC calendar month containing `ts`. Binance's `1M` is a true calendar month. */
export function monthStartUtc(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function bucketEnd(start: number, tf: 'weekly' | 'monthly'): number {
  if (tf === 'weekly') return start + 7 * DAY_MS;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Build weekly or monthly candles from UTC daily candles.
 *
 *   open = first day's open, high = max of highs, low = min of lows,
 *   close = last day's close, volume = sum
 *
 * This was verified bit-exact against Binance's native intervals: 50 of 50 weekly candles
 * and 34 of 34 complete monthly candles matched OHLC and volume to the cent. Aggregating
 * locally means one fetch path, one cache and one rate-limit budget instead of three, and it
 * sidesteps the fact that other exchanges disagree about boundaries (OKX aligns its default
 * 1D/1W/1M bars to UTC+8, Gate.io's coarsest bucket is a rolling 30 days).
 *
 * `daily` must be sorted ascending by openTime.
 */
export function aggregate(daily: readonly Candle[], tf: 'weekly' | 'monthly'): Candle[] {
  if (daily.length === 0) return [];

  const startOf = tf === 'weekly' ? weekStartUtc : monthStartUtc;
  const out: Candle[] = [];
  let anyPartialInBucket = false;

  for (const day of daily) {
    const start = startOf(day.openTime);
    const last = out[out.length - 1];

    if (last === undefined || last.openTime !== start) {
      out.push({
        openTime: start,
        open: day.open,
        high: day.high,
        low: day.low,
        close: day.close,
        volume: day.volume,
        closeTime: bucketEnd(start, tf) - 1,
        partial: false,
      });
      anyPartialInBucket = day.partial;
    } else {
      if (day.high > last.high) last.high = day.high;
      if (day.low < last.low) last.low = day.low;
      last.close = day.close;
      last.volume += day.volume;
      anyPartialInBucket ||= day.partial;
    }
  }

  // Only the trailing bucket can be incomplete: either its window has not elapsed, or the
  // final daily candle it contains is itself still forming.
  const lastDay = daily[daily.length - 1]!;
  const tail = out[out.length - 1]!;
  tail.partial = anyPartialInBucket || lastDay.closeTime < tail.closeTime;

  return out;
}

/**
 * The higher-timeframe series exactly as it stood at the close of daily bar `dailyIndex`.
 *
 * Needed for cross-timeframe questions like "did yesterday's daily candle touch the weekly
 * Kijun?" — which must use the weekly Kijun as it was on that day, built from the partial
 * week up to and including that day, not the weekly Kijun as it is now.
 */
export function higherTimeframeAsOf(
  daily: readonly Candle[],
  dailyIndex: number,
  tf: Timeframe,
): Candle[] {
  if (tf === 'daily') return daily.slice(0, dailyIndex + 1);
  return aggregate(daily.slice(0, dailyIndex + 1), tf);
}
