import { describe, it, expect } from 'vitest';
import { donchian } from '../src/indicators/donchian.ts';
import { ema } from '../src/indicators/ema.ts';
import { compare, touched, crossedBelow, crossedAbove } from '../src/indicators/predicates.ts';
import { ichimoku, cloudStateAt, positionVsCloud } from '../src/indicators/ichimoku.ts';
import type { IchimokuParams } from '../src/types.ts';
import { dailySeries, flatBars, candle, MONDAY_2024_01_01 as MON, type Ohlc } from './helpers.ts';

/** Bowie's own settings, from config/params.json. */
const BOWIE: IchimokuParams = {
  tenkan: 13,
  kijun: 35,
  kijunAux: 55,
  senkouB: 55,
  displacement: 35,
  extraBars: 1,
  senkouASource: 'tenkan+kijun',
  cloudMode: 'displaced',
};

describe('donchian', () => {
  const bars = dailySeries(MON, [
    [10, 12, 8, 11],
    [11, 15, 9, 14],
    [14, 16, 13, 15],
    [15, 15, 5, 6],
    [6, 20, 6, 19],
  ]);

  it('is the midpoint of the highest high and lowest low, over a window including bar t', () => {
    // len 3 at t=2: highs 12,15,16 -> 16 ; lows 8,9,13 -> 8  ; mid 12
    // len 3 at t=3: highs 15,16,15 -> 16 ; lows 9,13,5 -> 5  ; mid 10.5
    // len 3 at t=4: highs 16,15,20 -> 20 ; lows 13,5,6 -> 5  ; mid 12.5
    expect(donchian(bars, 3)).toEqual([null, null, 12, 10.5, 12.5]);
  });

  it('returns null until len-1 bars exist', () => {
    expect(donchian(bars, 5)).toEqual([null, null, null, null, 12.5]);
    expect(donchian(bars, 6)).toEqual([null, null, null, null, null]);
  });

  it('uses high and low, never close', () => {
    const a = dailySeries(MON, [[1, 10, 0, 1], [1, 10, 0, 9]]);
    const b = dailySeries(MON, [[1, 10, 0, 9], [1, 10, 0, 1]]);
    expect(donchian(a, 2)).toEqual(donchian(b, 2));
    expect(donchian(a, 2)[1]).toBe(5);
  });

  it('agrees with a naive reference implementation on a jagged series', () => {
    const rows: Ohlc[] = [];
    let p = 100;
    for (let i = 0; i < 300; i++) {
      p += Math.sin(i * 1.7) * 9 + Math.cos(i * 0.31) * 4;
      rows.push([p, p + Math.abs(Math.sin(i)) * 6, p - Math.abs(Math.cos(i * 2)) * 7, p]);
    }
    const jagged = dailySeries(MON, rows);
    for (const len of [1, 2, 13, 35, 55]) {
      const fast = donchian(jagged, len);
      const slow = jagged.map((_, t) => {
        if (t < len - 1) return null;
        const w = jagged.slice(t - len + 1, t + 1);
        return (Math.max(...w.map((x) => x.high)) + Math.min(...w.map((x) => x.low))) / 2;
      });
      expect(fast).toEqual(slow);
    }
  });

  it('rejects a non-positive length', () => {
    expect(() => donchian(bars, 0)).toThrow(RangeError);
  });
});

describe('ema', () => {
  it('seeds with the SMA at index n-1 and is null before that', () => {
    const r = ema([2, 4, 6, 8], 3);
    expect(r.values[0]).toBeNull();
    expect(r.values[1]).toBeNull();
    expect(r.values[2]).toBe(4); // sma(2,4,6)
    expect(r.values[3]).toBe(6); // alpha 0.5 -> 0.5*8 + 0.5*4
  });

  it('returns an all-null series when there are fewer bars than the period', () => {
    const r = ema([1, 2], 5);
    expect(r.values).toEqual([null, null]);
    expect(r.uncertainty).toBeNull();
  });

  it('uncertainty is an EXACT bound on seed-induced error, not a heuristic', () => {
    const src = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 40 + i * 0.6);
    const period = 55;
    const r = ema(src, period);

    const seedWindow = src.slice(0, period);
    const runFromSeed = (seed: number) => {
      const alpha = 2 / (period + 1);
      let v = seed;
      for (let t = period; t < src.length; t++) v = alpha * src[t]! + (1 - alpha) * v;
      return v;
    };
    // The true seed is unknown but must lie inside the seed window's range; the spread
    // between the two extreme seeds is precisely what `uncertainty` claims it is.
    const spread = runFromSeed(Math.max(...seedWindow)) - runFromSeed(Math.min(...seedWindow));
    expect(r.uncertainty).toBeCloseTo(spread, 10);
  });

  it('uncertainty decays geometrically as history grows', () => {
    const src = Array.from({ length: 600 }, (_, i) => 100 + Math.sin(i / 11) * 30);
    const short = ema(src.slice(0, 120), 100).uncertainty as number;
    const long = ema(src, 100).uncertainty as number;
    expect(long).toBeLessThan(short);
    expect(long / short).toBeLessThan(0.01);
  });

  it('is flat on a flat series and then has zero uncertainty', () => {
    const r = ema(new Array(300).fill(42), 100);
    expect(r.values[299]).toBeCloseTo(42, 12);
    expect(r.uncertainty).toBe(0);
  });
});

describe('predicates', () => {
  const bar = candle(MON, 10, 15, 5, 12);

  it('separates above / below / at, and never reads "not below" as "above"', () => {
    expect(compare(12, 10)).toBe('above');
    expect(compare(12, 14)).toBe('below');
    expect(compare(12, 12)).toBe('at');
    expect(compare(12, null)).toBe('unknown');
  });

  it('widens the neutral band by the level uncertainty', () => {
    expect(compare(100, 99)).toBe('above');
    expect(compare(100, 99, 2)).toBe('at'); // inside the EMA's own uncertainty -> undecidable
    expect(compare(100, 99, 0.5)).toBe('above');
  });

  it('keeps touch independent of above/below: a candle can be above AND have touched', () => {
    expect(touched(bar, 5)).toBe(true); // exactly the low
    expect(touched(bar, 15)).toBe(true); // exactly the high
    expect(touched(bar, 10)).toBe(true);
    expect(touched(bar, 4.99)).toBe(false);
    expect(touched(bar, 15.01)).toBe(false);
    expect(touched(bar, null)).toBe(false);
    // the wick-down-to-the-Kijun support test Bowie asked for:
    expect(compare(bar.close, 6)).toBe('above');
    expect(touched(bar, 6)).toBe(true);
  });

  it('compares each bar against its OWN level when detecting a cross', () => {
    expect(crossedBelow(11, 10, 9, 10.5)).toBe(true);
    expect(crossedAbove(11, 10, 9, 10.5)).toBe(false);
    // Reusing today's level for yesterday would flip both of these:
    expect(crossedBelow(11, 12, 13, 12)).toBe(false);
    expect(crossedAbove(11, 12, 13, 12)).toBe(true);
  });

  it('treats a missing level as no cross rather than as a cross', () => {
    expect(crossedBelow(11, null, 9, 10)).toBe(false);
    expect(crossedAbove(11, 10, 9, null)).toBe(false);
  });
});

describe('ichimoku', () => {
  const rows: Ohlc[] = [];
  for (let i = 0; i < 400; i++) {
    const p = 100 + Math.sin(i / 23) * 35 + i * 0.25;
    rows.push([p, p + 5, p - 5, p]);
  }
  const bars = dailySeries(MON, rows);
  const ich = ichimoku(bars, BOWIE);

  it('uses shift = displacement - extraBars, which is 34 for Bowie and not 35', () => {
    expect(ich.shift).toBe(34);
    expect(ichimoku(bars, { ...BOWIE, extraBars: 0 }).shift).toBe(35);
  });

  it('computes Senkou Span A from Tenkan and the PRIMARY Kijun, never the auxiliary', () => {
    const t = 399;
    expect(ich.senkouARaw[t]).toBeCloseTo((ich.tenkan[t] as number + (ich.kijun[t] as number)) / 2, 12);
    // the auxiliary is donchian(55) at the current bar: identical to the undisplaced Span B
    expect(ich.kijunAux[t]).toBe(ich.senkouBRaw[t]);
    expect(ich.senkouARaw[t]).not.toBeCloseTo((ich.tenkan[t] as number + (ich.kijunAux[t] as number)) / 2, 6);
  });

  it('aligns the displaced cloud to the spans computed `shift` bars earlier', () => {
    for (const t of [200, 300, 399]) {
      const a = ich.senkouARaw[t - 34] as number;
      const b = ich.senkouBRaw[t - 34] as number;
      expect(ich.cloudTopDisplaced[t]).toBe(Math.max(a, b));
      expect(ich.cloudBottomDisplaced[t]).toBe(Math.min(a, b));
    }
  });

  it('exposes the no-offset variant separately and selects between them via cloudMode', () => {
    expect(ich.cloudTop).toBe(ich.cloudTopDisplaced);
    const noOffset = ichimoku(bars, { ...BOWIE, cloudMode: 'noOffset' });
    expect(noOffset.cloudTop).toBe(noOffset.cloudTopNoOffset);
    expect(noOffset.cloudTopNoOffset[399]).toBe(
      Math.max(ich.senkouARaw[399] as number, ich.senkouBRaw[399] as number),
    );
    // The two readings genuinely differ - this is why open point E matters.
    expect(noOffset.cloudTopNoOffset[399]).not.toBe(ich.cloudTopDisplaced[399]);
  });

  it('honours senkouASource when it is switched away from the resolved default', () => {
    const alt = ichimoku(bars, { ...BOWIE, senkouASource: 'kijun+kijunAux' });
    expect(alt.senkouARaw[399]).toBeCloseTo((ich.kijun[399] as number + (ich.kijunAux[399] as number)) / 2, 12);
  });

  it('keeps the cloud undefined until enough history exists', () => {
    // senkouB needs 55 bars (first value at index 54), displaced by 34 -> index 88.
    expect(ich.cloudTopDisplaced[87]).toBeNull();
    expect(ich.cloudTopDisplaced[88]).not.toBeNull();
  });

  it('lags the chikou span backwards by the same shift', () => {
    expect(ich.chikou[100]).toBe(bars[134]?.close);
    expect(ich.chikou[bars.length - 1]).toBeNull();
  });

  it('always takes the cloud top as the max of the two spans, across every twist', () => {
    expect(positionVsCloud(10, 8, 5)).toBe('above');
    expect(positionVsCloud(6, 8, 5)).toBe('in');
    expect(positionVsCloud(4, 8, 5)).toBe('below');
    expect(positionVsCloud(4, null, 5)).toBe('unknown');
    for (let t = 88; t < bars.length; t++) {
      expect(ich.cloudTopDisplaced[t] as number).toBeGreaterThanOrEqual(ich.cloudBottomDisplaced[t] as number);
    }
  });

  it('rejects a negative shift', () => {
    expect(() => ichimoku(bars, { ...BOWIE, extraBars: 99 })).toThrow(RangeError);
  });
});

describe('cloudStateAt', () => {
  /**
   * A 120-bar base series whose cloud at the final bars has real thickness.
   *
   * The cloud at index 119 is built from the spans at index 85, so the windows that matter
   * are 73..85 (tenkan), 51..85 (kijun) and 31..85 (senkou B). A single deep low at index 40
   * falls inside the 55-window but outside the 35-window, which pulls Span B below Span A and
   * gives the cloud thickness. Bars 118 and 119 are past index 85, so rewriting them cannot
   * move the cloud - which is what lets the tests place a touch deliberately.
   */
  function baseSeries(): Ohlc[] {
    const rows: Ohlc[] = Array.from({ length: 120 }, (_, i) => (i < 80 ? [30, 32, 28, 30] : [60, 62, 58, 60]));
    rows[40] = [30, 32, 10, 30];
    return rows;
  }

  it('has a cloud with genuine thickness at the final bar', () => {
    const bars = dailySeries(MON, baseSeries());
    const ich = ichimoku(bars, BOWIE);
    expect(ich.cloudTop[119] as number).toBeGreaterThan(ich.cloudBottom[119] as number);
  });

  it('labels a boundary touch from above as support and from below as resistance', () => {
    const rows = baseSeries();
    const probe = ichimoku(dailySeries(MON, rows), BOWIE);
    const top = probe.cloudTop[119] as number;
    const bottom = probe.cloudBottom[119] as number;

    // Previous bar clearly above the cloud; final bar wicks down onto the cloud top.
    const supportRows = [...rows];
    supportRows[118] = [top + 20, top + 22, top + 18, top + 20];
    supportRows[119] = [top + 15, top + 18, top - 1, top + 10];
    const supportBars = dailySeries(MON, supportRows);
    const sAbove = cloudStateAt(supportBars, ichimoku(supportBars, BOWIE), 119);
    expect(sAbove.touchedTop).toBe(true);
    expect(sAbove.boundaryTest).toBe('support');

    // Previous bar clearly below the cloud; final bar wicks up onto the cloud bottom.
    const resistRows = [...rows];
    resistRows[118] = [bottom - 20, bottom - 18, bottom - 22, bottom - 20];
    resistRows[119] = [bottom - 15, bottom + 1, bottom - 18, bottom - 10];
    const resistBars = dailySeries(MON, resistRows);
    const sBelow = cloudStateAt(resistBars, ichimoku(resistBars, BOWIE), 119);
    expect(sBelow.touchedBottom).toBe(true);
    expect(sBelow.boundaryTest).toBe('resistance');
  });

  it('calls a touch neutral when the previous bar was inside the cloud', () => {
    const rows = baseSeries();
    const probe = ichimoku(dailySeries(MON, rows), BOWIE);
    const top = probe.cloudTop[119] as number;
    const bottom = probe.cloudBottom[119] as number;
    const mid = (top + bottom) / 2;

    rows[118] = [mid, mid + 0.1, mid - 0.1, mid];
    rows[119] = [mid, top, mid - 1, mid];
    const bars = dailySeries(MON, rows);
    const st = cloudStateAt(bars, ichimoku(bars, BOWIE), 119);
    expect(st.position).toBe('in');
    expect(st.touchedTop).toBe(true);
    expect(st.boundaryTest).toBe('inside');
  });

  it('emits one twist flag instead of two touches when the cloud has no thickness', () => {
    const bars = flatBars(MON, 120, 50, 50, 50, 50);
    const st = cloudStateAt(bars, ichimoku(bars, BOWIE), 119);
    expect(st.top).toBe(st.bottom);
    expect(st.touchedTop).toBe(false);
    expect(st.touchedBottom).toBe(false);
    expect(st.touchedTwist).toBe(true);
  });

  it('reports unknown rather than guessing when there is not enough history', () => {
    const bars = flatBars(MON, 40, 50, 55, 45, 50);
    const st = cloudStateAt(bars, ichimoku(bars, BOWIE), 39);
    expect(st.position).toBe('unknown');
    expect(st.top).toBeNull();
  });
});
