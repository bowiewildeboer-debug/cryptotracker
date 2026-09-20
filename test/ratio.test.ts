import { describe, it, expect } from 'vitest';
import { syntheticBtcRatio } from '../src/data/ratio.ts';
import { candle, MONDAY_2024_01_01 as MON } from './helpers.ts';

const DAY = 86_400_000;

describe('syntheticBtcRatio', () => {
  it('divides close by close and both extremes by BTC’s midpoint', () => {
    const coin = [candle(MON, 10, 12, 8, 11)];
    const btc = [candle(MON, 100, 110, 90, 105)];
    const [r] = syntheticBtcRatio(coin, btc);
    const mid = (110 + 90) / 2; // 100
    expect(r!.open).toBeCloseTo(10 / 100, 12);
    expect(r!.close).toBeCloseTo(11 / 105, 12);
    expect(r!.high).toBeCloseTo(12 / mid, 12);
    expect(r!.low).toBeCloseTo(8 / mid, 12);
  });

  it('always produces a candle whose open and close lie inside its own range', () => {
    // BTC closing far below its midpoint pushes the ratio close above the naive high.
    const coin = [candle(MON, 10, 10.1, 9.9, 10.1)];
    const btc = [candle(MON, 100, 140, 100, 100)];
    const [r] = syntheticBtcRatio(coin, btc);
    expect(r!.high).toBeGreaterThanOrEqual(Math.max(r!.open, r!.close));
    expect(r!.low).toBeLessThanOrEqual(Math.min(r!.open, r!.close));
    expect(r!.high).toBeGreaterThanOrEqual(r!.low);
  });

  it('is exactly 1 for BTC against itself', () => {
    const btc = [candle(MON, 100, 110, 90, 105), candle(MON + DAY, 105, 120, 100, 118)];
    for (const r of syntheticBtcRatio(btc, btc)) {
      expect(r.open).toBeCloseTo(1, 12);
      expect(r.close).toBeCloseTo(1, 12);
      // high/low use the midpoint divisor, so they straddle 1 rather than equalling it.
      expect(r.high).toBeGreaterThanOrEqual(1);
      expect(r.low).toBeLessThanOrEqual(1);
    }
  });

  it('rises when the coin outperforms BTC and falls when it lags', () => {
    const coin = [candle(MON, 10, 10, 10, 10), candle(MON + DAY, 20, 20, 20, 20)];
    const flatBtc = [candle(MON, 100, 100, 100, 100), candle(MON + DAY, 100, 100, 100, 100)];
    const fastBtc = [candle(MON, 100, 100, 100, 100), candle(MON + DAY, 400, 400, 400, 400)];
    const up = syntheticBtcRatio(coin, flatBtc);
    const down = syntheticBtcRatio(coin, fastBtc);
    expect(up[1]!.close).toBeGreaterThan(up[0]!.close);
    expect(down[1]!.close).toBeLessThan(down[0]!.close);
  });

  it('skips days that are missing on either side instead of interpolating', () => {
    const coin = [candle(MON, 10, 10, 10, 10), candle(MON + DAY, 11, 11, 11, 11), candle(MON + 2 * DAY, 12, 12, 12, 12)];
    const btc = [candle(MON, 100, 100, 100, 100), candle(MON + 2 * DAY, 100, 100, 100, 100)];
    const r = syntheticBtcRatio(coin, btc);
    expect(r.map((c) => c.openTime)).toEqual([MON, MON + 2 * DAY]);
  });

  it('refuses to divide by a zero or negative BTC price', () => {
    const coin = [candle(MON, 10, 10, 10, 10)];
    expect(syntheticBtcRatio(coin, [candle(MON, 0, 0, 0, 0)])).toEqual([]);
  });

  it('marks the ratio candle partial when either side is still forming', () => {
    const coin = [candle(MON, 10, 10, 10, 10, 1, false)];
    const btc = [candle(MON, 100, 100, 100, 100, 1, true)];
    expect(syntheticBtcRatio(coin, btc)[0]!.partial).toBe(true);
  });
});
