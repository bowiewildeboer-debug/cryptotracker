import type { Candle } from '../types.ts';
import { aggregate } from '../data/aggregate.ts';
import { analyseCoin, primaryOf, type CoinInput, type CoinSignals, type MarketContext } from '../analysis/signals.ts';

/**
 * Weekly and monthly reports.
 *
 * They are not a separate engine. The daily analysis already answers every question; a weekly
 * report is the same analysis run as it stood at the close of the last COMPLETED week, and a
 * monthly one at the close of the last completed month. Running it twice - once at the latest
 * boundary and once at the boundary before it - also gives the "what changed this period"
 * section for free, computed from candles rather than from a previous run's output, so it
 * survives a missed run.
 *
 * Unlike the daily report these never use an in-progress bucket: a weekly verdict that can
 * still flip before Sunday is not a weekly verdict.
 */
export type PeriodTimeframe = 'weekly' | 'monthly';

/**
 * The daily candles up to and including the end of the `n`-th most recent COMPLETED period.
 * `back = 0` is the latest completed period, `back = 1` the one before it.
 */
export function truncateToClosedPeriod(daily: readonly Candle[], tf: PeriodTimeframe, back = 0): Candle[] {
  const closedDaily = daily.filter((c) => !c.partial);
  const buckets = aggregate(closedDaily, tf).filter((b) => !b.partial);
  const bucket = buckets[buckets.length - 1 - back];
  if (!bucket) return [];
  return closedDaily.filter((c) => c.closeTime <= bucket.closeTime);
}

export interface PeriodChange {
  symbol: string;
  name: string;
  what:
    | 'entered-kijun'
    | 'left-kijun'
    | 'entered-cloud-above'
    | 'left-cloud-above'
    | 'entered-ema21'
    | 'left-ema21'
    | 'started-beating-btc'
    | 'stopped-beating-btc';
}

/**
 * "In trend" means something different per report.
 *
 * A weekly report is judged on the WEEKLY Kijun - using the daily one would just be a daily
 * report with a stale date. The monthly timeframe carries only the EMA21 (see SPEC 3.1: a
 * monthly Ichimoku would need 90 monthly candles, which almost nothing has), so the monthly
 * report is judged on that.
 */
function periodVerdict(c: CoinSignals, tf: PeriodTimeframe): boolean | null {
  const p = primaryOf(c);
  if (tf === 'weekly') {
    return p.kijun.weekly.verdict === 'unknown' ? null : p.kijun.weekly.verdict === 'above';
  }
  const cell = p.ema.find((e) => e.period === 21 && e.timeframe === 'monthly');
  if (!cell || (cell.verdict !== 'above' && cell.verdict !== 'below')) return null;
  return cell.verdict === 'above';
}

export interface PeriodicReport {
  timeframe: PeriodTimeframe;
  /** End date of the completed period this report describes. */
  periodEnd: string;
  previousPeriodEnd: string | null;
  coins: CoinSignals[];
  changes: PeriodChange[];
  inTrend: string[];
  notInTrend: string[];
}

export interface PeriodicInput extends Omit<CoinInput, 'daily'> {
  daily: readonly Candle[];
}

export function buildPeriodicReport(
  coins: readonly PeriodicInput[],
  ctx: MarketContext,
  tf: PeriodTimeframe,
): PeriodicReport {
  const btcNow = truncateToClosedPeriod(ctx.btcDaily, tf, 0);
  const btcPrev = truncateToClosedPeriod(ctx.btcDaily, tf, 1);

  const analyse = (back: number, btcDaily: readonly Candle[]): Map<string, CoinSignals> => {
    const out = new Map<string, CoinSignals>();
    if (btcDaily.length === 0) return out;
    for (const c of coins) {
      const daily = truncateToClosedPeriod(c.daily, tf, back);
      if (daily.length === 0) continue;
      const row = analyseCoin({ ...c, daily }, { ...ctx, btcDaily });
      if (row) out.set(c.id, row);
    }
    return out;
  };

  const now = analyse(0, btcNow);
  const prev = analyse(1, btcPrev);

  const changes: PeriodChange[] = [];
  for (const [id, cur] of now) {
    const before = prev.get(id);
    if (!before) continue;
    const push = (what: PeriodChange['what']) => changes.push({ symbol: cur.symbol, name: cur.name, what });

    const vNow = periodVerdict(cur, tf);
    const vBefore = periodVerdict(before, tf);
    if (vNow !== null && vBefore !== null && vNow !== vBefore) {
      if (tf === 'weekly') push(vNow ? 'entered-kijun' : 'left-kijun');
      else push(vNow ? 'entered-ema21' : 'left-ema21');
    }

    if (tf === 'weekly') {
      const nowCloud = primaryOf(cur).cloud.weekly;
      const beforeCloud = primaryOf(before).cloud.weekly;
      const aboveNow = nowCloud.position === 'above';
      const aboveBefore = beforeCloud.position === 'above';
      if (aboveNow !== aboveBefore && nowCloud.position !== 'unknown' && beforeCloud.position !== 'unknown') {
        push(aboveNow ? 'entered-cloud-above' : 'left-cloud-above');
      }
    }

    if (cur.btc.coinBtcInTrend !== null && before.btc.coinBtcInTrend !== null && cur.btc.coinBtcInTrend !== before.btc.coinBtcInTrend) {
      push(cur.btc.coinBtcInTrend ? 'started-beating-btc' : 'stopped-beating-btc');
    }
  }

  const rows = [...now.values()].sort((a, b) => b.score.points - a.score.points || a.rank - b.rank);

  return {
    timeframe: tf,
    periodEnd: rows[0]?.asOf ?? '',
    previousPeriodEnd: [...prev.values()][0]?.asOf ?? null,
    coins: rows,
    changes,
    inTrend: rows.filter((c) => periodVerdict(c, tf) === true).map((c) => c.symbol),
    notInTrend: rows.filter((c) => periodVerdict(c, tf) === false).map((c) => c.symbol),
  };
}
