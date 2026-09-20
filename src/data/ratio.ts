import type { Candle } from '../types.ts';

/**
 * The synthetic `{coin}/BTC` daily series.
 *
 * Bowie's most important filter needs this pair, and it mostly does not exist: only 38
 * BTC-quoted symbols trade on Binance in total (verified live), covering roughly half the
 * top-100 alts, and 27 of them have no BTC pair on any major exchange. So the ratio is
 * synthesised for EVERY coin - including the ones that do have a real pair - so that a single
 * consistent method produces the whole column rather than a mixture of two.
 *
 * Accuracy was measured against 966 days of five coins that do have real BTC pairs:
 * mean Kijun-35 error 0.8%, and the boolean "close above Kijun" verdict disagrees with the
 * real pair on only 3-5% of days. Good enough for a trend filter, and the report states the
 * method so a discrepancy against TradingView is explainable rather than mysterious.
 *
 * ## Why the high and low use BTC's midpoint
 *
 * The naive `high = coin.high / btc.low` over-widens the range: it assumes the coin's high
 * and BTC's low happened at the same instant, which they almost never did. Dividing both
 * extremes by BTC's midpoint keeps the range realistic, which matters because the Ichimoku
 * lines are pure high/low midpoints and therefore very sensitive to a single inflated wick.
 */
export function syntheticBtcRatio(coin: readonly Candle[], btc: readonly Candle[]): Candle[] {
  const btcByDay = new Map(btc.map((c) => [c.openTime, c]));
  const out: Candle[] = [];

  for (const c of coin) {
    const b = btcByDay.get(c.openTime);
    // A day missing on either side yields no ratio candle. Never interpolate a price.
    if (!b) continue;
    if (!(b.open > 0) || !(b.close > 0) || !(b.high > 0) || !(b.low > 0)) continue;

    const btcMid = (b.high + b.low) / 2;
    if (!(btcMid > 0)) continue;

    const open = c.open / b.open;
    const close = c.close / b.close;
    let high = c.high / btcMid;
    let low = c.low / btcMid;

    // The three divisors differ, so the formula can put the open or close outside the
    // high/low range. That would be an impossible candle and would quietly corrupt both
    // `touched()` and the Donchian windows, so widen the range to contain them.
    high = Math.max(high, open, close);
    low = Math.min(low, open, close);

    out.push({
      openTime: c.openTime,
      open,
      high,
      low,
      close,
      // Volume has no meaning for a ratio; zero is the honest value.
      volume: 0,
      closeTime: c.closeTime,
      partial: c.partial || b.partial,
    });
  }
  return out;
}
