import { describe, it, expect } from 'vitest';
import { targetWeights, simulate, type UniverseCoin, type DayInput, type PortfolioConfig } from '../src/analysis/portfolio.ts';

const WCFG = { topRankCount: 10, topMinWeight: 0.5, altMaxWeight: 0.05 };

const CFG: PortfolioConfig = {
  ...WCFG,
  startDate: '2026-09-20',
  startCapitalEur: 10_000,
  feeRate: 0.0015,
  minTradeUsd: 1,
};

/** `n` coins ranked 1..n, market cap halving as rank grows. */
function universe(n: number): UniverseCoin[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    symbol: `C${i + 1}`,
    rank: i + 1,
    marketCapUsd: 1_000_000 / Math.pow(1.5, i),
  }));
}

const yes = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, true]));
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('targetWeights - Bowie’s allocation rule', () => {
  const uni = universe(30);

  it('gives the top 10 the whole portfolio when no altcoin qualifies', () => {
    const tw = targetWeights(uni, yes(['c1', 'c2', 'c3']), WCFG);
    expect(tw.cashWeight).toBeCloseTo(0, 12);
    expect(sum(tw.weights)).toBeCloseTo(1, 12);
    expect(tw.altCount).toBe(0);
  });

  it('splits the top-10 share pro rata by market cap', () => {
    const tw = targetWeights(uni, yes(['c1', 'c2']), WCFG);
    const mc1 = uni[0]!.marketCapUsd;
    const mc2 = uni[1]!.marketCapUsd;
    expect(tw.weights.get('c1')! / tw.weights.get('c2')!).toBeCloseTo(mc1 / mc2, 10);
  });

  it('caps each coin outside the top 10 at 5% and splits them evenly', () => {
    const tw = targetWeights(uni, yes(['c1', 'c11', 'c12', 'c13']), WCFG);
    for (const id of ['c11', 'c12', 'c13']) expect(tw.weights.get(id)).toBeCloseTo(0.05, 12);
    expect(tw.weights.get('c1')).toBeCloseTo(1 - 0.15, 12);
    expect(tw.cashWeight).toBeCloseTo(0, 12);
  });

  it('never lets altcoins exceed 50% in total, however many qualify', () => {
    // universe(30) has exactly 20 coins ranked 11..30, so these counts all exist.
    for (const count of [10, 11, 15, 20]) {
      const altIds = Array.from({ length: count }, (_, i) => `c${11 + i}`);
      const tw = targetWeights(uni, yes(['c1', ...altIds]), WCFG);
      const altSum = altIds.reduce((s, id) => s + (tw.weights.get(id) ?? 0), 0);
      expect(altSum).toBeLessThanOrEqual(0.5 + 1e-12);
      expect(tw.weights.get('c1')).toBeGreaterThanOrEqual(0.5 - 1e-12);
      for (const id of altIds) expect(tw.weights.get(id)!).toBeLessThanOrEqual(0.05 + 1e-12);
    }
  });

  it('shares the altcoin budget evenly once more than ten of them qualify', () => {
    const altIds = Array.from({ length: 20 }, (_, i) => `c${11 + i}`);
    const tw = targetWeights(uni, yes(altIds.concat('c1')), WCFG);
    for (const id of altIds) expect(tw.weights.get(id)).toBeCloseTo(0.5 / 20, 12);
  });

  it('parks the top-10 share in cash when no top-10 coin qualifies', () => {
    const tw = targetWeights(uni, yes(['c11', 'c12', 'c13']), WCFG);
    expect(sum(tw.weights)).toBeCloseTo(0.15, 12);
    expect(tw.cashWeight).toBeCloseTo(0.85, 12);
  });

  it('goes fully to stablecoins when nothing qualifies at all', () => {
    const tw = targetWeights(uni, {}, WCFG);
    expect(tw.weights.size).toBe(0);
    expect(tw.cashWeight).toBe(1);
  });

  it('always allocates exactly 100% between coins and cash', () => {
    const cases: string[][] = [[], ['c1'], ['c5', 'c30'], ['c1', 'c2', 'c11'], universe(30).map((c) => c.id)];
    for (const ids of cases) {
      const tw = targetWeights(uni, yes(ids), WCFG);
      expect(sum(tw.weights) + tw.cashWeight).toBeCloseTo(1, 12);
    }
  });
});

describe('simulate', () => {
  const uni = universe(12);
  const flatPrices = Object.fromEntries(uni.map((c) => [c.id, 100]));

  function day(date: string, opts: Partial<DayInput> = {}): DayInput {
    return {
      date,
      eurUsd: 1.1,
      universe: uni,
      priceUsd: flatPrices,
      qualifies: yes(['c1']),
      ...opts,
    };
  }

  it('converts the starting euros at the first day’s rate and charges one fee on the HODL buy', () => {
    const r = simulate([day('2026-09-20')], CFG);
    const startUsd = 10_000 * 1.1;
    // The fee is charged on what is BOUGHT, not on the starting cash: x + x*fee = capital,
    // so the invested amount is capital / (1 + fee), not capital * (1 - fee).
    const invested = startUsd / (1 + CFG.feeRate);
    expect(r.series[0]!.hodlUsd).toBeCloseTo(invested, 6);
    expect(r.stats.hodl.totalFeesUsd).toBeCloseTo(invested * CFG.feeRate, 6);
    expect(r.series[0]!.hodlUsd + r.stats.hodl.totalFeesUsd).toBeCloseTo(startUsd, 6);
    expect(r.series[0]!.hodlEur).toBeCloseTo(invested / 1.1, 6);
  });

  it('never trades the HODL book again after the first day', () => {
    const days = ['2026-09-20', '2026-09-21', '2026-09-28', '2026-10-05'].map((d) => day(d));
    const r = simulate(days, CFG);
    const hodlTrades = r.trades.filter((t) => t.portfolio === 'hodl');
    expect(new Set(hodlTrades.map((t) => t.date))).toEqual(new Set(['2026-09-20']));
  });

  it('holds the HODL book flat when prices do not move, and tracks them when they do', () => {
    const doubled = Object.fromEntries(uni.map((c) => [c.id, 200]));
    const r = simulate([day('2026-09-20'), day('2026-09-21', { priceUsd: doubled })], CFG);
    expect(r.series[1]!.hodlUsd).toBeCloseTo(r.series[0]!.hodlUsd * 2, 6);
  });

  it('goes fully to cash when nothing qualifies, and the cash does not move with the market', () => {
    const crash = Object.fromEntries(uni.map((c) => [c.id, 10]));
    const r = simulate(
      [day('2026-09-20', { qualifies: {} }), day('2026-09-21', { qualifies: {}, priceUsd: crash })],
      CFG,
    );
    expect(r.series[0]!.cashWeight).toBeCloseTo(1, 10);
    expect(r.series[1]!.strategyUsd).toBeCloseTo(r.series[0]!.strategyUsd, 6);
    // ...while the HODL benchmark takes the full 90% hit.
    expect(r.series[1]!.hodlUsd).toBeCloseTo(r.series[0]!.hodlUsd * 0.1, 6);
    expect(r.stats.strategy.daysFullyInCash).toBe(2);
  });

  it('rebalances when the qualifying set changes', () => {
    const r = simulate(
      [day('2026-09-20'), day('2026-09-21', { qualifies: yes(['c1', 'c2']) }), day('2026-09-22', { qualifies: yes(['c1', 'c2']) })],
      CFG,
    );
    expect(r.series.map((s) => s.rebalanced)).toEqual([true, true, false]);
    expect(r.trades.some((t) => t.reason === 'qualifying set changed')).toBe(true);
  });

  it('rebalances on the first valuation day of a new UTC week even when nothing changed', () => {
    // 2026-09-20 is a Sunday, 2026-09-21 a Monday -> a new week starts.
    const r = simulate([day('2026-09-20'), day('2026-09-21'), day('2026-09-22')], CFG);
    expect(r.series[1]!.rebalanced).toBe(true);
    expect(r.series[2]!.rebalanced).toBe(false);
  });

  it('does not trade at all on a quiet day inside the same week', () => {
    const r = simulate([day('2026-09-21'), day('2026-09-22'), day('2026-09-23')], { ...CFG, startDate: '2026-09-21' });
    const later = r.trades.filter((t) => t.date !== '2026-09-21');
    expect(later).toEqual([]);
  });

  it('charges the fee on both sides of a rotation', () => {
    const r = simulate(
      [day('2026-09-20', { qualifies: yes(['c1']) }), day('2026-09-21', { qualifies: yes(['c2']) })],
      CFG,
    );
    const rotation = r.trades.filter((t) => t.date === '2026-09-21');
    expect(rotation.some((t) => t.side === 'sell' && t.id === 'c1')).toBe(true);
    expect(rotation.some((t) => t.side === 'buy' && t.id === 'c2')).toBe(true);
    for (const t of rotation) expect(t.feeUsd).toBeCloseTo(t.notionalUsd * CFG.feeRate, 9);
  });

  it('never spends money it does not have', () => {
    const days = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10);
      const picks = i % 3 === 0 ? ['c1', 'c11'] : i % 3 === 1 ? ['c2', 'c3', 'c12'] : [];
      return day(d, { qualifies: yes(picks) });
    });
    const r = simulate(days, CFG);
    for (const p of r.series) {
      expect(p.cashUsd).toBeGreaterThanOrEqual(-1e-6);
      expect(p.strategyUsd).toBeGreaterThan(0);
      expect(p.cashWeight).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('carries a missing price forward and flags the position stale instead of valuing it at zero', () => {
    const missing = { ...flatPrices };
    delete (missing as Record<string, number>)['c1'];
    const r = simulate([day('2026-09-20'), day('2026-09-21', { priceUsd: missing })], CFG);
    // c1 still counts at its carried-forward price, so the book does not crater.
    expect(r.series[1]!.hodlUsd).toBeCloseTo(r.series[0]!.hodlUsd, 6);
    expect(r.holdings.hodl.find((p) => p.id === 'c1')?.stale).toBe(true);
  });

  it('reports a drawdown and a return that match the euro series', () => {
    const half = Object.fromEntries(uni.map((c) => [c.id, 50]));
    const back = Object.fromEntries(uni.map((c) => [c.id, 150]));
    const r = simulate(
      [day('2026-09-20'), day('2026-09-21', { priceUsd: half }), day('2026-09-22', { priceUsd: back })],
      CFG,
    );
    expect(r.stats.hodl.maxDrawdownPct).toBeCloseTo(50, 6);
    expect(r.stats.hodl.returnPct).toBeCloseTo(50, 6);
  });

  it('values in euros using each day’s own rate', () => {
    const r = simulate([day('2026-09-20'), day('2026-09-21', { eurUsd: 2.2 })], CFG);
    // USD value unchanged, but a euro now buys twice as many dollars -> half the euros.
    expect(r.series[1]!.hodlEur).toBeCloseTo(r.series[0]!.hodlEur / 2, 6);
  });

  it('ignores days before the start date and rejects an empty window', () => {
    const r = simulate([day('2026-09-01'), day('2026-09-20')], CFG);
    expect(r.series.map((s) => s.date)).toEqual(['2026-09-20']);
    expect(() => simulate([day('2026-09-01')], CFG)).toThrow(/start date/);
  });

  it('is deterministic: replaying the same inputs gives byte-identical output', () => {
    const days = Array.from({ length: 40 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 8, 20 + i)).toISOString().slice(0, 10);
      const picks = ['c1', 'c2', 'c11', 'c12'].filter((_, k) => (i + k) % 2 === 0);
      const prices = Object.fromEntries(uni.map((c, k) => [c.id, 100 + Math.sin(i / 3 + k) * 20]));
      return day(d, { qualifies: yes(picks), priceUsd: prices });
    });
    expect(JSON.stringify(simulate(days, CFG))).toBe(JSON.stringify(simulate(days, CFG)));
  });
});
