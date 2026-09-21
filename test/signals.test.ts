import { describe, it, expect } from 'vitest';
import {
  analyseCoin,
  primaryOf,
  referenceIndex,
  type MarketContext,
  type CoinInput,
  type CoinSignals,
} from '../src/analysis/signals.ts';
import { opportunityScore, takeProfitScore, type LevelRef, type MetricSet } from '../src/analysis/metrics.ts';
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

/** BTC below its own Kijun, so the USD set is the primary one. */
const usdCtx = (over: Partial<MarketContext> = {}) => ctxWith({ btcInTrend: false, ...over });

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
    // The live line also carries its own distance to the reference close.
    expect(r.live?.changePct).toBeCloseTo(((daily[399]!.close - daily[398]!.close) / daily[398]!.close) * 100, 9);
  });

  it('returns null when nothing has closed yet', () => {
    expect(analyseCoin(coin('alt', 'ALT', series(1, () => 1, true)), ctxWith())).toBeNull();
  });

  it('always carries both bases, and scores on the one BTC’s own trend selects', () => {
    const daily = series(400, (i) => 100 + i * 2);
    const onBtc = analyseCoin(coin('alt', 'ALT', daily), ctxWith({ btcInTrend: true }))!;
    expect(onBtc.primaryBase).toBe('btc');
    expect(primaryOf(onBtc)).toBe(onBtc.btcPair);
    expect(onBtc.usd).not.toBeNull();

    const onUsd = analyseCoin(coin('alt', 'ALT', daily), ctxWith({ btcInTrend: false }))!;
    expect(onUsd.primaryBase).toBe('usd');
    expect(primaryOf(onUsd)).toBe(onUsd.usd);
    // Same candles, different frame of reference - so the two scores may legitimately differ.
    expect(onUsd.btcPair).not.toBeNull();
  });

  it('never compares BTC against itself, and falls back to the dollar base for it', () => {
    const r = analyseCoin(coin('bitcoin', 'BTC', btcDaily), ctxWith())!;
    expect(r.btcPair).toBeNull();
    expect(r.primaryBase).toBe('usd');
    expect(r.btc.coinBtcInTrend).toBeNull();
    expect(r.btc.preferBtc).toBeNull();
    // ...and the confirmation points it cannot earn are removed from the maximum.
    expect(r.score.breakdown.find((b) => b.label === 'confirmation')?.counted).toBe(false);
    expect(r.score.max).toBeLessThanOrEqual(100 - params.score.confirmation);
    expect(r.score.unavailable).toBeGreaterThanOrEqual(params.score.confirmation);
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

  it('marks a rising coin as in trend and a falling one as not, on either base', () => {
    for (const ctx of [ctxWith(), usdCtx()]) {
      expect(analyseCoin(coin('a', 'A', series(400, (i) => 100 + i * 2)), ctx)!.inTrend).toBe(true);
      expect(analyseCoin(coin('b', 'B', series(400, (i) => 1000 - i * 2)), ctx)!.inTrend).toBe(false);
    }
  });

  it('detects a drop below the daily Kijun on the reference candle only', () => {
    // Rise for a long time, then one violent down candle that breaks the Kijun.
    const daily = series(400, (i) => 100 + i);
    const last = daily[399]!;
    daily[399] = { ...last, open: last.open, high: last.open, low: 50, close: 60 };
    const r = analyseCoin(coin('c', 'C', daily), usdCtx())!;
    expect(r.droppedOutToday).toBe(true);
    expect(r.usd.kijun.daily.crossedBelowToday).toBe(true);
    expect(r.usd.kijun.daily.crossedAboveToday).toBe(false);
  });

  it('uses exactly the six EMA cells Bowie asked for, and never the daily EMA21', () => {
    const r = analyseCoin(coin('a', 'A', series(400, (i) => 100 + i)), usdCtx())!;
    for (const set of [r.usd, r.btcPair!]) {
      const labels = set.ema.map((e) => `${e.period}${e.timeframe}`).sort();
      expect(labels).toEqual(['100daily', '100weekly', '21monthly', '21weekly', '55daily', '55weekly'].sort());
      expect(set.ema.some((e) => e.period === 21 && e.timeframe === 'daily')).toBe(false);
      expect(set.ema).toHaveLength(emaCells(params).length);
    }
  });

  it('refuses to score an EMA that has no value at all', () => {
    // 120 daily candles is only 18 weeks, so a weekly EMA100 cannot exist.
    const r = analyseCoin(coin('young', 'YOUNG', series(120, (i) => 100 + i)), usdCtx())!;
    const weekly100 = r.usd.ema.find((e) => e.period === 100 && e.timeframe === 'weekly')!;
    expect(weekly100.value).toBeNull();
    expect(weekly100.verdict).toBe('unknown');
    expect(r.score.breakdown.find((b) => b.label === 'EMA100 weekly')?.counted).toBe(false);
    expect(r.score.unavailable).toBeGreaterThan(0);
  });

  it('still scores an unconverged EMA when the price is far enough away to be certain', () => {
    // 400 daily candles is 57 weeks. A weekly EMA21 there has real seed uncertainty left,
    // but on a steadily compounding series the price is above it under ANY seed, so the
    // verdict is not in doubt and the cell must count.
    const r = analyseCoin(coin('a', 'A', series(400, (i) => 100 * Math.pow(1.01, i))), usdCtx())!;
    const cell = r.usd.ema.find((e) => e.period === 21 && e.timeframe === 'weekly')!;
    expect(cell.state).not.toBe('na');
    expect(cell.uncertainty as number).toBeGreaterThan(0);
    expect(cell.verdict).toBe('above');
    expect(r.score.breakdown.find((b) => b.label === 'EMA21 weekly')?.counted).toBe(true);
  });

  it('leaves a cell uncounted when the uncertainty genuinely straddles the price', () => {
    // A weekly EMA55 on the same 57 weeks has only two bars of warm-up, so the seed still
    // dominates and no honest verdict is possible.
    const r = analyseCoin(coin('a', 'A', series(400, (i) => 100 * Math.pow(1.01, i))), usdCtx())!;
    const cell = r.usd.ema.find((e) => e.period === 55 && e.timeframe === 'weekly')!;
    expect(cell.verdict).toBe('at');
    expect(r.score.breakdown.find((b) => b.label === 'EMA55 weekly')?.counted).toBe(false);
  });

  it('keeps points, max and unavailable consistent with the breakdown', () => {
    const shapes = [(i: number) => 100 + i, (i: number) => 1000 - i * 2, (i: number) => 100 + Math.sin(i / 9) * 30];
    for (const ctx of [ctxWith(), usdCtx()]) {
      for (const shape of shapes) {
        const r = analyseCoin(coin('x', 'X', series(400, shape)), ctx)!;
        const counted = r.score.breakdown.filter((b) => b.counted);
        expect(r.score.points).toBeCloseTo(counted.reduce((s, b) => s + b.got, 0), 6);
        expect(r.score.max).toBeCloseTo(counted.reduce((s, b) => s + b.of, 0), 6);
        expect(r.score.max + r.score.unavailable).toBeCloseTo(100, 6);
        expect(r.score.points).toBeLessThanOrEqual(r.score.max + 1e-9);
      }
    }
  });

  it('no longer exposes the auxiliary 55 line anywhere', () => {
    const r = analyseCoin(coin('a', 'A', series(400, (i) => 100 + i)), usdCtx())!;
    expect('kijunAux' in r).toBe(false);
    expect(JSON.stringify(r).toLowerCase()).not.toContain('aux');
  });

  it('marks a coin as owned by symbol', () => {
    const r = analyseCoin(coin('a', 'A', series(400, (i) => 100 + i)), ctxWith({ owned: new Set(['A']) }))!;
    expect(r.owned).toBe(true);
  });

  it('records why a young coin is missing values instead of guessing', () => {
    const r = analyseCoin(coin('a', 'A', series(60, (i) => 100 + i)), usdCtx())!;
    expect(r.usd.cloud.daily.position).toBe('unknown');
    expect(r.dataQuality.notes.join(' ')).toMatch(/dagcandles/);
  });
});

describe('buckets', () => {
  it('sends a coin below its daily Kijun to verkopen, towards BTC while BTC still holds', () => {
    const falling = series(400, (i) => 1000 - i * 2);
    const btcUp = analyseCoin(coin('b', 'B', falling), ctxWith({ btcInTrend: true }))!;
    expect(btcUp.bucket).toBe('verkopen');
    expect(btcUp.sellInto).toBe('btc');
    expect(btcUp.bucketReason).toMatch(/naar BTC/);

    const btcDown = analyseCoin(coin('b', 'B', falling), ctxWith({ btcInTrend: false }))!;
    expect(btcDown.bucket).toBe('verkopen');
    expect(btcDown.sellInto).toBe('eur');
    expect(btcDown.bucketReason).toMatch(/naar euro/);
  });

  it('calls a fresh, held test of the daily Kijun a buitenkans', () => {
    // A long rise, then a candle that wicks all the way down to the Kijun and still closes
    // at the top: the textbook support test.
    const daily = series(400, (i) => 100 + i);
    const last = daily[399]!;
    daily[399] = { ...last, low: 400 };
    const r = analyseCoin(coin('c', 'C', daily), usdCtx())!;

    const kij = r.usd.levels.find((l) => l.key === 'kijun-daily')!;
    expect(kij.verdict).toBe('above');
    expect(kij.retest).toEqual({ barsAgo: 0, kind: 'retest' });
    expect(r.opportunity.points).toBeGreaterThan(0);
    expect(r.bucket).toBe('buitenkans');
  });

  it('does not count a test the candle failed to hold', () => {
    // Same wick, but this time the candle closes BELOW the line. That is a break, not a test.
    const daily = series(400, (i) => 100 + i);
    const last = daily[399]!;
    daily[399] = { ...last, low: 400, close: 420 };
    const r = analyseCoin(coin('c', 'C', daily), usdCtx())!;
    expect(r.usd.levels.find((l) => l.key === 'kijun-daily')!.retest).toBeNull();
    expect(r.opportunity.points).toBe(0);
  });

  it('leaves a quiet coin in houden', () => {
    // A steady rise that never comes back to any line and has nothing overhead.
    const r = analyseCoin(coin('q', 'Q', series(400, (i) => 100 * Math.pow(1.004, i))), usdCtx())!;
    expect(r.usd.kijun.daily.verdict).toBe('above');
    expect(r.bucket).toBe('houden');
    expect(r.sellInto).toBeNull();
  });
});

describe('opportunityScore and takeProfitScore', () => {
  const level = (over: Partial<LevelRef>): LevelRef => ({
    key: 'kijun-daily',
    label: 'Kijun-sen daily',
    family: 'kijun',
    timeframe: 'daily',
    weight: 40,
    value: 100,
    uncertainty: 0,
    verdict: 'above',
    gapPct: -5,
    touchedByRef: false,
    retest: null,
    approaching: false,
    ...over,
  });
  const set = (levels: LevelRef[]) => ({ levels } as unknown as MetricSet);

  it('rewards a fresher retest more than an older one', () => {
    const fresh = opportunityScore(set([level({ retest: { barsAgo: 0, kind: 'retest' } })]), params).points;
    const old = opportunityScore(set([level({ retest: { barsAgo: 2, kind: 'retest' } })]), params).points;
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(0);
  });

  it('values a retest of an established level above a first reclaim', () => {
    const retest = opportunityScore(set([level({ retest: { barsAgo: 0, kind: 'retest' } })]), params).points;
    const reclaim = opportunityScore(set([level({ retest: { barsAgo: 0, kind: 'reclaim' } })]), params).points;
    expect(reclaim).toBeCloseTo(retest * params.levels.reclaimFactor, 5);
  });

  it('adds up several tested levels, and caps the total at 100', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      level({ key: `k${i}`, weight: 40, retest: { barsAgo: 0, kind: 'retest' } }),
    );
    expect(opportunityScore(set(many), params).points).toBe(100);
  });

  it('ignores levels below the price when looking for resistance', () => {
    expect(takeProfitScore(set([level({ gapPct: -5, approaching: false })]), params).points).toBe(0);
  });

  it('weighs an overhead level more heavily the closer it is', () => {
    const close = takeProfitScore(set([level({ gapPct: 0.5, approaching: true })]), params).points;
    const far = takeProfitScore(set([level({ gapPct: 2.5, approaching: true })]), params).points;
    expect(close).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });

  it('counts an overhead level the candle already tapped in full', () => {
    const tapped = takeProfitScore(set([level({ gapPct: 8, approaching: false, touchedByRef: true })]), params);
    expect(tapped.points).toBe(40);
    expect(tapped.contributions[0]!.detail).toMatch(/raakt dit niveau nu/);
  });
});

describe('assignSections', () => {
  const row = (symbol: string, over: Partial<CoinSignals>) =>
    ({ symbol, bucket: 'houden', owned: false, inTrend: false, ...over }) as unknown as CoinSignals;

  it('puts every coin in exactly one bucket, with owned and buy candidates alongside', () => {
    const s = assignSections([
      row('AAA', { bucket: 'buitenkans', inTrend: true }),
      row('BBB', { bucket: 'winst-pakken', inTrend: true }),
      row('CCC', { bucket: 'verkopen' }),
      row('DDD', { bucket: 'houden', inTrend: true, owned: true }),
      row('EEE', { bucket: 'houden', inTrend: true }),
    ]);
    expect(s).toEqual({
      buitenkans: ['AAA'],
      winstPakken: ['BBB'],
      verkopen: ['CCC'],
      houden: ['DDD', 'EEE'],
      buyCandidates: ['AAA', 'BBB', 'EEE'],
      owned: ['DDD'],
    });
    // Every coin lands in exactly one bucket list.
    const bucketed = [...s.buitenkans, ...s.winstPakken, ...s.verkopen, ...s.houden];
    expect(bucketed).toHaveLength(5);
    expect(new Set(bucketed).size).toBe(5);
  });
});

describe('qualifiesForStrategy', () => {
  const mk = (over: Record<string, unknown>) =>
    ({ symbol: 'ALT', usd: { inTrend: true }, btc: { coinBtcInTrend: true }, ...over }) as unknown as CoinSignals;

  it('needs both the USD Kijun and the BTC-pair Kijun for an altcoin', () => {
    expect(qualifiesForStrategy(mk({}), 'BTC')).toBe(true);
    expect(qualifiesForStrategy(mk({ usd: { inTrend: false } }), 'BTC')).toBe(false);
    expect(qualifiesForStrategy(mk({ btc: { coinBtcInTrend: false } }), 'BTC')).toBe(false);
    expect(qualifiesForStrategy(mk({ btc: { coinBtcInTrend: null } }), 'BTC')).toBe(false);
  });

  it('needs only the USD Kijun for BTC itself', () => {
    expect(qualifiesForStrategy(mk({ symbol: 'BTC', btc: { coinBtcInTrend: null } }), 'BTC')).toBe(true);
    expect(qualifiesForStrategy(mk({ symbol: 'BTC', usd: { inTrend: false }, btc: { coinBtcInTrend: null } }), 'BTC')).toBe(false);
  });
});
