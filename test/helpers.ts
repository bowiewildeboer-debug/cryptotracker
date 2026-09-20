import type { Candle } from '../src/types.ts';

const DAY_MS = 86_400_000;
/** 2024-01-01T00:00:00Z is a Monday - a convenient anchor for week-boundary tests. */
export const MONDAY_2024_01_01 = Date.UTC(2024, 0, 1);

export type Ohlc = [number, number, number, number];

export function candle(
  openTime: number,
  o: number,
  h: number,
  l: number,
  c: number,
  volume = 1,
  partial = false,
): Candle {
  return { openTime, open: o, high: h, low: l, close: c, volume, closeTime: openTime + DAY_MS - 1, partial };
}

/** Daily candles starting at `start`, one per day, from [o,h,l,c] tuples. */
export function dailySeries(start: number, rows: readonly Ohlc[]): Candle[] {
  return rows.map((r, i) => candle(start + i * DAY_MS, r[0], r[1], r[2], r[3]));
}

/** `count` identical daily candles - a convenient flat baseline. */
export function flatBars(start: number, count: number, o: number, h: number, l: number, c: number): Candle[] {
  return dailySeries(start, Array.from({ length: count }, () => [o, h, l, c] as Ohlc));
}
