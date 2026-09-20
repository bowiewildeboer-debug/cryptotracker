/** A single OHLCV candle. All timestamps are UTC milliseconds. */
export interface Candle {
  /** Open time, UTC ms. For daily candles this is always 00:00:00.000 UTC. */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Close time, UTC ms (inclusive-exclusive boundary minus 1ms, Binance convention). */
  closeTime: number;
  /** True when this bucket is still forming (today / this week / this month). */
  partial: boolean;
}

export type Timeframe = 'daily' | 'weekly' | 'monthly';

/** A series that may be undefined before enough history exists. */
export type Series = (number | null)[];

export interface IchimokuParams {
  tenkan: number;
  kijun: number;
  kijunAux: number;
  senkouB: number;
  displacement: number;
  extraBars: number;
  senkouASource: 'tenkan+kijun' | 'tenkan+kijunAux' | 'kijun+kijunAux';
  cloudMode: 'displaced' | 'noOffset';
}
