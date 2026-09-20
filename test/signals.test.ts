import { describe, it, expect } from 'vitest';
import { analyseCoin, referenceIndex, type MarketContext, type CoinInput, type CoinSignals } from '../src/analysis/signals.ts';
import { assignSections, qualifiesForStrategy } from '../src/pipeline.ts';
import { loadParams, emaCells } from '../src/config.ts';
import { candle, MONDAY_2024_01_01 as MON } from './helpers.ts';
import type { Candle } from '../src/types.ts';

const DAY = 86_400_000;
const params = loadParams();

/** A long enough series for every daily indicator to have a value. */
function series(n: number, price: (i: number) => number, partialLast = false): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = price(i);
    return candle(MON + i * DAY, p, p * 1.02, p * 0.98, p, 1, partialLast && i === n - 1);
  });
}

const btcDaily = series(400, (i) => 50_000 + i * 50);

function ctxWith(over: Partial<MarketContext> = {}): MarketContext {
  return {
    params,
    btcDaily,
    btcId: 'bitcoin',
    btcInTrend: true,
    owned: new Set<string>(),
    ...over,
  };
}

function coin(id: string, symbol: string, daily: Candle[]): CoinInput {
  return { id, symbol, name: symbol, rank: 5, marketCapUsd: 1e9, daily };
}

describe('referenceIndex', () => {
  it('points at the last CLOSED candle, never at today’s forming one', () => {
    expect(referenceIndex(series(10, () => 1))).toBe(9);
    expect(referenceIndex(series(10, () => 1, true))).toBe(8);
    expect(referenceIndex([])).toBe(-1);
    expect(referenceIndex(series(1, () => 1, true))).toBe(-1);
  });
});

describe('analyseCoin', () => {
  it('reports as-of the last closed candle and keeps the live candle separate', () => {
    const daily = series(400, (i) => 100 + i, true);
    const r = analyseCoin(coin('alt', 'ALT', daily), ctxWith())!;
    expect(r.asOf).toBe(new Date(daily[398]!.openTime).toISOString().slice(0, 10));
    expect(r.closeUsd).toBe(daily[398]!.close);
    expect(r.live?.closeUsd).toBe(daily[399]!.close);
  });

  it('returns null when nothing has closed yet', () => {
    expect(analyseCoin(coin('alt', 'ALT', series(1, () => 1, true)), ctxWith())).toBeNull();
  });

  it('never compares BTC against itself', () => {
    const r = analyseCoin(coin('bitcoin', 'BTC', btcDaily), ctxWith())!;
    expect(r.btc.coinBtcInTrend).toBeNull();
    expect(r.btc.preferBtc).toBeNull();
    // ...and the points it cannot earn are removed from the maximum, not counted as zero.
    // (Other cells may also be unavailable on a short synthetic series, so this is an
    // upper bound rather than an equality.)
    expect(r.score.breakdown.find((b) => b.label === 'coin/BTC above Kijun')?.counted).toBe(false);
    expect(r.score.max).toBeLessThanOrEqual(100 - params.score.coinBtcInTrend);
    expect(r.score.unavailable).toBeGreaterThanOrEqual(params.score.coinBtcInTrend);
  });

  it('flags preferBtc only when BTC is in trend and the coin is not beating it', () => {
    // A coin falling hard while BTC rises: its ratio series is clearly below its Kijun.
    const laggard = series(400, (i) => 1000 - i * 2);
    const withBtcUp = analyseCoin(coin('alt', 'ALT', laggard), ctxWith({ btcInTrend: true }))!;
    expect(withBtcUp.btc.coinBtcInTrend).toBe(false);
    expect(withBtcUp.btc.preferBtc).toBe(true);

    // Same coin, but BTC itself is below its own Kijun: rotating to BTC is no safe haven.
    const withBtcDown = analyseCoin(coin('alt', 'ALT', laggard), ctxWith({ btcInTrend: false }))!;
    expect(withBtcDown.btc.preferBtc).toBe(false);
  });

  it('marks a rising coin as in trend and a falling one as not', () => {
    expect(analyseCoin(coin('a', 'A', series(400, (i) => 100 + i * 2)), ctxWith())!.inTrend).toBe(true);
    expect(analyseCoin(coin('b', 'B', series(400, (i) => 1000 - i * 2)), ctxWith())!.inTrend).toBe(false);
  });

  it('detects a drop below the daily Kijun on the reference candle only', () => {
    // Rise for a long time, then one violent down candle that breaks the Kijun.
    const daily = series(400, (i) => 100 + i);
    const last = daily[399]!;
    daily[399] = { ...last, open: last.open, high: last.open, low: 50, close: 60 };
    const r = analyseCoin(coin('c', 'C', daily), ctxWith())!;
    expect(r.droppedOutToday).toBe(true);
    expect(r.kijun.daily.crossedBelowToday).toBe(true);
    expect(r.kijun.daily.crossedAboveToday).toBe(false);
  });

  it('uses exactly the six EMA cells Bowie asked for, and never the daily EMA21', () => {
    const r = analyseCoin(coin('a', 'A', series(400, (i) => 100 + i)), ctxWith())!;
    const labels = r.ema.map((e) => `${e.period}${e.timeframe}`).sort();
    expect(labels).toEqual(['100daily', '100weekly', '21monthly', '21weekly', '55daily', '55weekly'].sort());
    expect(r.ema.some((e) => e.period === 21 && e.timeframe === 'daily')).toBe(false);
    expect(r.ema).toHaveLength(emaCells(params).length);
  });

  it('refuses to score an EMA that has not converged', () => {
    // 120 daily candles is far too few for a weekly EMA100 to mean anything.
    const r = analyseCoin(coin('young', 'YOUNG', series(120, (i) => 100 + i)), ctxWith())!;
    const weekly100 = r.ema.find((e) => e.period === 100 && e.timeframe === 'weekly')!;
    expect(weekly100.state).not.toBe('ok');
    expect(r.score.breakdown.find((b) => b.label === 'EMA100 weekly')?.counted).toBe(false);
    expect(r.score.unavailable).toBeGreaterThan(0);
  });

  it('keeps points, max and unavailable consistent with the breakdown', () => {
    for (const shape of [(i: number) => 100 + i, (i: number) => 1000 - i * 2, (i: number) => 100 + Math.sin(i / 9) * 30]) {
      const r = analyseCoin(coin('x', 'X', series(400, shape)), ctxWith())!;
      const counted = r.score.breakdown.filter((b) => b.counted);
      expect(r.score.points).toBeCloseTo(counted.reduce((s, b) => s + b.got, 0), 6);
      expect(r.score.max).toBeCloseTo(counted.reduce((s, b) => s + b.of, 0), 6);
      expect(r.score.max + r.score.unavailable).toBeCloseTo(100, 6);
      expect(r.score.points).toBeLessThanOrEqual(r.score.max + 1e-9);
    }
  });

  it('exposes the auxiliary line without letting it touch the cloud or the score', () => {
    const r = analyseCoin(coin('a', 'A', series(400, (i) => 100 + i)), ctxWith())!;
    expect(r.kijunAux).not.toBeNull();
    expect(r.score.breakdown.some((b) => b.label.toLowerCase().includes('aux'))).toBe(false);
  });

  it('marks a coin as owned by symbol', () => {
    const r = analyseCoin(coin('a', 'A', series(400, (i) => 100 + i)), ctxWith({ owned: new Set(['A']) }))!;
    expect(r.owned).toBe(true);
  });

  it('records why a young coin is missing values instead of guessing', () => {
    const r = analyseCoin(coin('a', 'A', series(60, (i) => 100 + i)), ctxWith())!;
    expect(r.cloud.daily.position).toBe('unknown');
    expect(r.dataQuality.notes.join(' ')).toMatch(/daily candles/);
  });
});

describe('assignSections', () => {
  const base = { droppedOutToday: false, owned: false, inTrend: false, btc: { preferBtc: false } };
  const row = (symbol: string, over: Partial<typeof base>) => ({ ...base, ...over, symbol }) as unknown as CoinSignals;

  it('puts each coin in exactly one section, most urgent first', () => {
    const s = assignSections([
      row('AAA', { inTrend: true }),
      row('BBB', { inTrend: true, btc: { preferBtc: true } }),
      row('CCC', { droppedOutToday: true }),
      row('DDD', { owned: true }),
      // owned AND dropped out -> the dropout is the thing to see
      row('EEE', { owned: true, droppedOutToday: true }),
      // not in trend, not owned, not a dropout -> appears nowhere
      row('FFF', {}),
    ]);
    expect(s).toEqual({
      buyCandidates: ['AAA'],
      preferBtc: ['BBB'],
      droppedOut: ['CCC', 'EEE'],
      owned: ['DDD'],
    });
  });
});

describe('qualifiesForStrategy', () => {
  const mk = (over: Record<string, unknown>) =>
    ({ symbol: 'ALT', inTrend: true, btc: { coinBtcInTrend: true }, ...over }) as unknown as CoinSignals;

  it('needs both the USD Kijun and the BTC-pair Kijun for an altcoin', () => {
    expect(qualifiesForStrategy(mk({}), 'BTC')).toBe(true);
    expect(qualifiesForStrategy(mk({ inTrend: false }), 'BTC')).toBe(false);
    expect(qualifiesForStrategy(mk({ btc: { coinBtcInTrend: false } }), 'BTC')).toBe(false);
    expect(qualifiesForStrategy(mk({ btc: { coinBtcInTrend: null } }), 'BTC')).toBe(false);
  });

  it('needs only the USD Kijun for BTC itself', () => {
    expect(qualifiesForStrategy(mk({ symbol: 'BTC', btc: { coinBtcInTrend: null } }), 'BTC')).toBe(true);
    expect(qualifiesForStrategy(mk({ symbol: 'BTC', inTrend: false, btc: { coinBtcInTrend: null } }), 'BTC')).toBe(false);
  });
});
