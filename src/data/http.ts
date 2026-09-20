/**
 * The only place in the codebase that talks to the network.
 *
 * Every exchange and data provider used here punishes impatience. Binance escalates a
 * rate-limit breach from HTTP 429 to HTTP 418 - an IP ban lasting two minutes up to three
 * days - so a naive retry loop can lock the tracker out for longer than it has been alive.
 * CoinGecko's keyless tier starts returning 429 after roughly four rapid calls.
 */

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Attempts INCLUDING the first one. */
  attempts?: number;
  /** Base delay for exponential backoff, doubled each attempt. */
  baseDelayMs?: number;
  timeoutMs?: number;
  /** Called with every response, before status handling - used for rate-limit accounting. */
  onResponse?: (res: Response) => void;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Status codes where retrying is sensible. 418 is deliberately absent: it means banned. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { headers = {}, attempts = 4, baseDelayMs = 800, timeoutMs = 20_000, onResponse } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'cryptotracker/0.1', ...headers },
        signal: controller.signal,
      });
      onResponse?.(res);

      if (res.ok) return (await res.json()) as T;

      const body = await res.text().catch(() => '');

      // An IP ban must never be retried into a longer ban.
      if (res.status === 418) {
        throw new HttpError(418, url, `IP banned by the exchange. Retry-After: ${res.headers.get('retry-after') ?? 'unknown'}. ${body}`);
      }
      if (!RETRYABLE.has(res.status) || attempt === attempts) {
        throw new HttpError(res.status, url, body);
      }

      // Honour the server's own instruction over our backoff curve.
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** (attempt - 1);
      await sleep(wait);
      continue;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastError = err;
      if (attempt === attempts) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`fetch failed after ${attempts} attempts: ${url} (${String(lastError)})`);
}

/**
 * Runs `tasks` with at most `limit` in flight. Results keep the input order.
 *
 * Concurrency is the rate-limit lever: Binance allows ~3000 kline calls per minute, but the
 * point is to stay far below any threshold rather than to discover exactly where it is.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return out;
}
