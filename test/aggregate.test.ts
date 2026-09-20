import { describe, it, expect } from 'vitest';
import { aggregate, weekStartUtc, monthStartUtc, higherTimeframeAsOf } from '../src/data/aggregate.ts';
import { dailySeries, candle, MONDAY_2024_01_01 as MON, type Ohlc } from './helpers.ts';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('UTC boundaries', () => {
  it('anchors the week to Monday 00:00 UTC, matching Binance', () => {
    expect(new Date(MON).getUTCDay()).toBe(1); // sanity: 2024-01-01 really is a Monday
    for (let d = 0; d < 7; d++) {
      expect(weekStartUtc(MON + d * DAY)).toBe(MON);
    }
    expect(weekStartUtc(MON + 7 * DAY)).toBe(MON + 7 * DAY);
    // A Sunday must land in the week that started the previous Monday, not the next one.
    const sunday = MON + 6 * DAY;
    expect(new Date(sunday).getUTCDay()).toBe(0);
    expect(weekStartUtc(sunday)).toBe(MON);
  });

  it('groups by UTC even for timestamps late on a Sunday evening in Amsterdam', () => {
    // 2024-01-07 23:30 UTC is Monday 00:30 in CET. It still belongs to the week of Jan 1.
    const lateSunday = Date.UTC(2024, 0, 7, 23, 30);
    expect(iso(weekStartUtc(lateSunday))).toBe('2024-01-01T00:00:00.000Z');
  });

  it('anchors the month to the 1st, UTC', () => {
    expect(iso(monthStartUtc(Date.UTC(2024, 1, 29, 23, 59)))).toBe('2024-02-01T00:00:00.000Z');
    expect(iso(monthStartUtc(Date.UTC(2024, 11, 31)))).toBe('2024-12-01T00:00:00.000Z');
  });
});

describe('aggregate', () => {
  /** 14 days from Monday 2024-01-01, with a distinctive high/low in each week. */
  const rows: Ohlc[] = [
    [10, 11, 9, 10], // Mon
    [10, 18, 9, 12], // Tue  <- week 1 high
    [12, 13, 4, 6], //  Wed  <- week 1 low
    [6, 8, 5, 7], //    Thu
    [7, 9, 6, 8], //    Fri
    [8, 9, 7, 9], //    Sat
    [9, 10, 8, 9.5], // Sun  <- week 1 close
    [20, 21, 19, 20], // Mon <- week 2 open
    [20, 30, 18, 25],
    [25, 26, 24, 25],
    [25, 27, 15, 16], // week 2 low
    [16, 17, 15, 17],
    [17, 18, 16, 18],
    [18, 19, 17, 19], // Sun <- week 2 close
  ];
  const daily = dailySeries(MON, rows);

  it('builds weekly candles as first-open / max-high / min-low / last-close / sum-volume', () => {
    const weekly = aggregate(daily, 'weekly');
    expect(weekly).toHaveLength(2);

    expect(iso(weekly[0]!.openTime)).toBe('2024-01-01T00:00:00.000Z');
    expect(weekly[0]).toMatchObject({ open: 10, high: 18, low: 4, close: 9.5, volume: 7 });
    expect(iso(weekly[0]!.closeTime)).toBe('2024-01-07T23:59:59.999Z');

    expect(iso(weekly[1]!.openTime)).toBe('2024-01-08T00:00:00.000Z');
    expect(weekly[1]).toMatchObject({ open: 20, high: 30, low: 15, close: 19, volume: 7 });
  });

  it('marks only the trailing bucket partial, and only when its window has not elapsed', () => {
    const full = aggregate(daily, 'weekly');
    expect(full[0]!.partial).toBe(false);
    expect(full[1]!.partial).toBe(false);

    // Stop on the Wednesday of week 2: that bucket is still forming.
    const cut = aggregate(daily.slice(0, 10), 'weekly');
    expect(cut).toHaveLength(2);
    expect(cut[0]!.partial).toBe(false);
    expect(cut[1]!.partial).toBe(true);
  });

  it('propagates a partial daily candle into its bucket', () => {
    const withLive = [...daily.slice(0, 13), { ...daily[13]!, partial: true }];
    const weekly = aggregate(withLive, 'weekly');
    expect(weekly[1]!.partial).toBe(true);
  });

  it('builds monthly candles on calendar months', () => {
    // 2024-01-30, 01-31, 02-01, 02-02
    const spanning = [
      candle(Date.UTC(2024, 0, 30), 1, 5, 1, 4),
      candle(Date.UTC(2024, 0, 31), 4, 6, 2, 5),
      candle(Date.UTC(2024, 1, 1), 5, 9, 5, 8),
      candle(Date.UTC(2024, 1, 2), 8, 10, 3, 9),
    ];
    const monthly = aggregate(spanning, 'monthly');
    expect(monthly).toHaveLength(2);
    expect(iso(monthly[0]!.openTime)).toBe('2024-01-01T00:00:00.000Z');
    expect(monthly[0]).toMatchObject({ open: 1, high: 6, low: 1, close: 5 });
    expect(iso(monthly[0]!.closeTime)).toBe('2024-01-31T23:59:59.999Z');
    expect(monthly[1]).toMatchObject({ open: 5, high: 10, low: 3, close: 9 });
  });

  it('handles a leap-year February and a year boundary', () => {
    const feb29 = candle(Date.UTC(2024, 1, 29), 1, 2, 0, 1);
    expect(iso(aggregate([feb29], 'monthly')[0]!.closeTime)).toBe('2024-02-29T23:59:59.999Z');
    const dec31 = candle(Date.UTC(2024, 11, 31), 1, 2, 0, 1);
    expect(iso(aggregate([dec31], 'monthly')[0]!.closeTime)).toBe('2024-12-31T23:59:59.999Z');
  });

  it('tolerates gaps in the daily series without inventing candles', () => {
    const gappy = [daily[0]!, daily[3]!, daily[6]!]; // Mon, Thu, Sun of week 1
    const weekly = aggregate(gappy, 'weekly');
    expect(weekly).toHaveLength(1);
    expect(weekly[0]).toMatchObject({ open: 10, close: 9.5, volume: 3 });
  });

  it('returns an empty array for no input', () => {
    expect(aggregate([], 'weekly')).toEqual([]);
    expect(aggregate([], 'monthly')).toEqual([]);
  });
});

describe('higherTimeframeAsOf', () => {
  const rows: Ohlc[] = Array.from({ length: 20 }, (_, i) => [i, i + 2, i - 2, i + 1] as Ohlc);
  const daily = dailySeries(MON, rows);

  it('rebuilds the weekly series as it stood at the close of a given day', () => {
    // Index 9 is Wednesday of week 2, so week 2 must contain only Mon..Wed.
    const asOf = higherTimeframeAsOf(daily, 9, 'weekly');
    expect(asOf).toHaveLength(2);
    expect(asOf[1]!.partial).toBe(true);
    expect(asOf[1]!.close).toBe(daily[9]!.close);
    // ...and the completed week before it must be identical to the final answer.
    expect(asOf[0]).toEqual(aggregate(daily, 'weekly')[0]);
  });

  it('returns the plain daily slice for the daily timeframe', () => {
    expect(higherTimeframeAsOf(daily, 4, 'daily')).toEqual(daily.slice(0, 5));
  });
});
