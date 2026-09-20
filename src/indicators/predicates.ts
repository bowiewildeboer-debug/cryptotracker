import type { Candle } from '../types.ts';

/**
 * A comparison outcome. `at` means the close sits on the level (within float noise, or
 * within the level's own uncertainty); `unknown` means the level does not exist yet.
 *
 * Only `above` ever earns a green tick. `at` and `unknown` are neutral and score 0 —
 * never treat "not below" as "above".
 */
export type Verdict = 'above' | 'below' | 'at' | 'unknown';

/** Float-noise tolerance, scaled to the magnitude of the level. */
function eps(level: number): number {
  return 1e-9 * Math.abs(level);
}

/**
 * Where does the candle's CLOSE sit relative to `level`?
 *
 * `uncertainty` widens the neutral band — pass an EMA's `uncertainty` here so an
 * unconverged EMA can never produce a confident verdict. Pass 0 for Ichimoku lines,
 * which are exact once enough bars exist.
 */
export function compare(close: number, level: number | null, uncertainty = 0): Verdict {
  if (level === null || !Number.isFinite(level)) return 'unknown';
  const band = eps(level) + Math.abs(uncertainty);
  if (close > level + band) return 'above';
  if (close < level - band) return 'below';
  return 'at';
}

export function isAbove(close: number, level: number | null, uncertainty = 0): boolean {
  return compare(close, level, uncertainty) === 'above';
}

/**
 * Did the candle touch the level? `[level-u, level+u]` intersecting `[low, high]` counts.
 *
 * This is deliberately independent of `compare`: a candle can be ABOVE the Kijun and have
 * TOUCHED it in the same bar (a wick down to the line = a support test), which is exactly
 * the signal Bowie asked for. Never fold the two together.
 */
export function touched(bar: Candle, level: number | null, uncertainty = 0): boolean {
  if (level === null || !Number.isFinite(level)) return false;
  const band = eps(level) + Math.abs(uncertainty);
  return bar.low - band <= level + band && level - band <= bar.high + band;
}

/**
 * Did the close cross from above the level to not-above it, between two bars?
 *
 * Each bar is compared against ITS OWN level value. Never apply today's indicator value
 * to yesterday's candle.
 */
export function crossedBelow(
  prevClose: number,
  prevLevel: number | null,
  currClose: number,
  currLevel: number | null,
): boolean {
  return isAbove(prevClose, prevLevel) && !isAbove(currClose, currLevel);
}

export function crossedAbove(
  prevClose: number,
  prevLevel: number | null,
  currClose: number,
  currLevel: number | null,
): boolean {
  return !isAbove(prevClose, prevLevel) && isAbove(currClose, currLevel);
}
