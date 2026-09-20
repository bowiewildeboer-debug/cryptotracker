# Research — verified findings

Everything here was checked on **2026-09-20**. The ✅ items were **tested live from a Dutch
machine**, not merely read in documentation. Do not re-research these; if something breaks,
re-verify that one item and update this file with a date.

---

## 1. Candle data — Binance is the answer

| Fact | Status |
|---|---|
| `https://data-api.binance.vision` and `https://api.binance.com` both return HTTP 200 from a Netherlands IP | ✅ tested |
| Endpoint: `GET /api/v3/klines?symbol=&interval=&startTime=&endTime=&limit=` | ✅ |
| **No API key, no account, no signature.** Rate limits are per IP | ✅ |
| Intervals include native `1d`, `1w`, `1M` (and `1s`…`12h`, `3d`) | ✅ |
| `1w` opens **Monday 00:00:00 UTC**, closes Sunday 23:59:59.999 UTC | ✅ tested on 4 candles |
| `1M` is a **true calendar month in UTC**, not rolling 30 days | ✅ tested on 3 candles |
| Max 1000 candles per request. `limit=1500` **silently returns 1000** — it does not error | ✅ tested |
| Weight 2 per klines call; IP budget **6000 weight / minute** (from `/api/v3/exchangeInfo`) | ✅ |
| Response header `x-mbx-used-weight-1m` reports current consumption | ✅ |
| Violations escalate: HTTP 429 → **HTTP 418 = IP ban, 2 minutes up to 3 days**. Honour `Retry-After` | ✅ docs |
| Binance spot history starts **2017-08-17** → at most 110 monthly candles for any coin | ✅ |
| Binance has 1368 TRADING spot symbols; **493 quote USDT but only 38 quote BTC** | ✅ tested |

**Geo-risk:** Binance exited the Netherlands as a *company* in 2023, and other NL-hosted
servers have reported HTTP 451. It works today from this machine and from GitHub's runners must
be re-tested. Keep the kline fetcher behind an interface from day one.

### 1.1 Weekly/monthly aggregation from daily is exact ✅

400 Binance `ETHUSDT` daily candles were aggregated into weeks (Monday-anchored, UTC) and
compared to Binance's native `1w`: **50 of 50 weeks matched OHLC and volume to the cent.**
Monthly: **34 of 34 complete months matched** (only the truncated first month differed, as
expected). → Fetch `1d` only; build `1w`/`1M` locally. One code path, one cache, one budget.

### 1.2 Fallback exchanges

| Exchange | Endpoint | Key? | Gotcha |
|---|---|---|---|
| KuCoin | `GET https://api.kucoin.com/api/v1/market/candles?symbol=BTC-USDT&type=1week\|1month` | no | ⚠ field order is `[time, open, **close**, high, low, volume, turnover]` — close before high/low |
| Bybit | `GET https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=D\|W\|M` | no | newest-first ordering; weekly aligns to Monday UTC like Binance |
| OKX | `GET https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1W` | no | ⚠ **default `1D/1W/1M` bars are aligned to Hong Kong time (UTC+8)** — measured exactly 8h offset |
| CryptoCompare / CCData | — | **yes** | both returned HTTP 401 without a key in 2026; every tutorial claiming keyless access is out of date |

KuCoin is the single best BTC-pair supplement to Binance (+6 coins); Kraken adds 3.

---

## 2. The `{coin}/BTC` problem — and the measured solution

**Real BTC pairs barely exist any more.**

* Binance: **33 of 67** top-100 alts have a BTC pair (~49%).
* Pooling Binance + KuCoin + Kraken + Gate + MEXC + OKX + Bybit: **40 of 67 (60%)**.
* **27 top-100 alts have no BTC pair on any of them:** HYPE, RAIN, CC, GRAM, SHIB, M, CRO, ENA,
  ONDO, ASTER, PUMP, AKE, WLFI, MORPHO, BTW, PEPE, SKY, VVV, LIT, POL, PI, JST, QNT, JUP,
  ETHFI, AERO, APT.
* BTC-quote symbols on Binance have shrunk sharply over recent years — only 38 remain.

**Synthesis, measured over 966 days on five coins that do have real pairs:** ✅

```
close = coin_close / btc_close
high  = coin_high  / ((btc_high + btc_low) / 2)
low   = coin_low   / ((btc_high + btc_low) / 2)
```

* mean Kijun-35 error: **0.8%**
* the boolean `close > Kijun` signal disagrees with the real pair on **3–5% of days**

Dividing high by BTC's *low* and low by BTC's *high* (the naive ratio-of-extremes) over-widens
the range and distorts the Donchian midpoint; the midpoint divisor above is better.

---

## 3. Coin ranking & symbol resolution

### CoinMarketCap

| Fact | Status |
|---|---|
| Free "Basic": $0, **15 000 credits/month**, 50 req/min, 63 endpoints | ✅ |
| Base `https://pro-api.coinmarketcap.com`, header `X-CMC_PRO_API_KEY` | ✅ |
| `GET /v3/cryptocurrency/listings/latest` **is** on the free tier; 1 credit per 250 coins → ~30 credits/month | ✅ |
| Returns `cmc_rank` and `tags` when you pass `aux=cmc_rank,tags` | ✅ |
| ⚠ The `tag` query param only accepts `all\|defi\|filesharing` — **live HTTP 400** confirms you cannot server-side filter stablecoins. Fetch `aux=tags` and filter client-side on the exact tag `stablecoin` | ✅ tested |
| Historical OHLCV `/v2/cryptocurrency/ohlcv/historical` is **not** on Basic or Builder ($29); minimum is Startup **$79/mo** | ✅ |

→ CMC is a **ranking source only**, never a candle source. Skip the paid tiers entirely: the
only thing $79/mo buys is OHLCV that Binance gives away with deeper history.

### CoinGecko

| Fact | Status |
|---|---|
| Demo plan: 10 000 credits/month, 100 calls/min, `api.coingecko.com` + header `x-cg-demo-api-key` | ✅ |
| **Keyless is unusable** — HTTP 429 after ~4 rapid calls (shared IP pool). A free Demo key is effectively mandatory | ✅ tested |
| `GET /coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1` gives `market_cap_rank` | ✅ |
| `GET /coins/markets?vs_currency=usd&category=stablecoins` returns a clean exclusion set (15 hits inside the current top 100) | ✅ |
| ⚠ **Never use CoinGecko for candles.** `/coins/{id}/ohlc` auto-coarsens to **4-day bars past 30 days**, free history ~1 year. A Kijun-35 would silently be computed over 140 days | ✅ |
| Symbol mapping: `GET /coins/{id}/tickers?exchange_ids=binance,okx,bybit` returns `base`, `target`, `market.identifier`, `coin_id`; `base + target` **is** the Binance spot symbol | ✅ tested |

### ⚠ The wrong-coin trap (live, not theoretical)

The current top 100 contains **`LIT` = Lighter**, while Binance/OKX/Bybit all list a `LIT`
that is **Litentry**. Any ticker-string match silently charts the wrong asset and produces a
confident, wrong buy signal. Only CoinGecko-`coin_id` / contract-address resolution is safe.
The mapping table needs a manual-override column and an alert when a mapping changes.

### Exclusions

Today's top 100 holds ~32 non-trending assets: stablecoins (USDT, USDC, DAI, USDe, FDUSD,
PYUSD…), wrapped/LST (WBTC, WETH, WEETH, WSTETH, STETH, cbBTC), tokenized RWA funds
(FIGR_HELOC, BUIDL, USYC, EURSAFO, JAAA, USTB, EUTBL, BCAP) and exchange tokens (LEO, WBT, OKB,
BGB, GT, KCS, HTX). ~68 real coins remain → **request 250, not 100**.

⚠ Do not substring-match `"stablecoin"`: the tag `stablecoin-protocol` marks real trend assets
(ENA, SKY, FF, STABLE). Use exact tag equality plus a hand-maintained deny/allow list.

---

## 4. Indicator maths — matching TradingView exactly

### 4.0 Which indicator Bowie actually runs ✅ (resolved 2026-09-20)

**"Ichimoku Kinko Hyo Cloud – no offset – no repaint"** by TradingView user **KryptoNight**
(published as both indicator and strategy; several forks exist). Identified from a verbatim
match of all five input titles plus the `9 / 26 / 52 / 52 / 26` default fingerprint, then
confirmed by reading the raw Pine source.

```pine
donchian(len) => avg(lowest(len), highest(len))     // (highest high + lowest low) / 2
conversion   = donchian(conversion_prd)             // Tenkan
baseline     = donchian(baseline_prd)               // Kijun
baselineA    = donchian(baselineA_prd)              // auxiliary Kijun — PLOTTED ONLY
leadingSpanA = avg(conversion, baseline)            // <-- primary Kijun, NOT the auxiliary
leadingSpanB = donchian(leadingSpan_2prd)
displ        = displacement - extra_bars            // 26 - 1 = 25 by default; 35 - 1 = 34 here
```

* `baselineA` appears in **no** `fill()`, **no** span calculation and **no** entry/exit
  condition — it is assigned and passed to two `plot()` calls, nothing else.
* Because its default (52) equals the Senkou Span B default (52), the auxiliary **is** the
  Senkou Span B series drawn at the current bar with zero displacement — a slow flat S/R level.
* `fill(spanA, spanB)` is the **only** cloud; there is no second cloud involving the auxiliary.
* ⚠ The script renders a standard displaced cloud **and** a "no offset" variant. Those are two
  different answers to "is price in the cloud". → `SPEC.md` open point E.
* ⚠ `extra_bars` is a sixth input Bowie did not report. Default 1 → shift 34. If he ever
  changed it, the shift changes with it.

### 4.1 TradingView's built-in Ichimoku (for reference)

TradingView's built-in Ichimoku is a thin Pine script. All four lines use a **Donchian
midpoint** over **high and low** (never close), in a window that **includes the current bar**:

```
donchian(len) = (ta.highest(high, len) + ta.lowest(low, len)) / 2
```

* Tenkan = `donchian(9)`, Kijun = `donchian(26)`, Senkou B = `donchian(52)`.
* **Senkou A = (Tenkan + Kijun) / 2 — always.** There is no built-in TradingView variant that
  omits Tenkan. Hiding the Tenkan line does not remove it from the maths.
* Tenkan and Kijun are never displaced.
* One input (labelled "Lagging Span", default 26) drives both shifts.

### ⚠ The off-by-one that will look like a bug

TradingView plots the spans with `offset = displacement - 1` and Chikou with
`offset = -displacement + 1`. With the default 26, the cloud is actually **25 bars** forward.
For Bowie's `displacement = 35` the cloud above today's candle is the Senkou pair computed
**34 bars ago**. A naive 35-bar shift puts the entire cloud column one bar out of sync.

### EMA

`alpha = 2/(n+1)`, `ema_t = alpha*src_t + (1-alpha)*ema_{t-1}`. Pine does not document its seed
and returns `na` during warm-up. The seed choice is immaterial **if you warm up**: influence
decays as `(1-alpha)^k`, so EMA(100) is within ~4.5e-5 relative after 500 bars and ~2e-9 after
1000. → seed with `sma(n)` and gate on a computed error bound (see `SPEC.md` §5.2).

### History requirements

| Indicator | Bars needed | Reality |
|---|---|---|
| Daily Kijun-35 / cloud | 55 + 34 = 89 days | fine for everything |
| Weekly cloud (Senkou B 55 + shift 34) | 89 weeks ≈ 1.7 yr | fine for most |
| Monthly EMA21 | 21 months min, ~42 for convergence | fine for most |
| ~~Monthly Ichimoku~~ | ~~90 months = 7.5 yr~~ | **impossible** — Binance has 110 months total; SOL has 74, SUI 41, TAO 30 |

→ The decision to use monthly for **EMA21 only** is what makes this project feasible.

---

## 5. Hosting & scheduling

| Option | Verdict |
|---|---|
| **GitHub Actions** | ✅ **Best scheduler.** Private repo = 2000 free Linux min/month (a 4-min daily job ≈ 120). Public = unlimited. Min cron 5 min, max job 6 h. ⚠ scheduled runs drift **5–30 min** at `:00` → schedule at `:17`. ⚠ 60-day inactivity auto-disable is documented **for public repos only** |
| **GitHub Pages** | ⚠ free only for **public** repos; a private repo needs GitHub Pro |
| Cloudflare Workers (free) as the *fetcher* | ❌ **50 subrequests and 10 ms CPU per invocation** kills a 300-call job |
| Cloudflare Workers/Pages as the *server* | ✅ static assets free & unlimited, 100k dynamic req/day, KV 100k reads/1k writes per day, D1 5 GB |
| Vercel Hobby cron | ❌ once-per-day only and fires anywhere within the hour (±59 min) |
| Windows Task Scheduler | ⚠ secondary only. Laptop is a single point of failure; `StartWhenAvailable` queues with a 10-min delay; default conditions block on battery; `WakeToRun` cannot power on a shut-down machine |
| Fly.io | ❌ no free tier since 2024-10-07 (≈$2.02/mo) |
| Render free | ❌ no cron jobs at all |
| Railway Hobby | $5/mo |
| Oracle Always Free | ❌ reclaims instances idle <20% CPU over 7 days — exactly this workload |

**Scheduling notes:** run at `17 1 * * *` (01:17 UTC = ~75 min after daily close), plus
`workflow_dispatch`. Pin `runs-on: ubuntu-latest` (Windows runners burn minutes at 2×, macOS
10×) and set `timeout-minutes: 15` — a hung call can otherwise run for 6 hours.

**Repo size:** committing ~500 KB/day of JSON is ~180 MB/year. Keep `latest.json` plus a
rolling 120-day history, or squash an orphan `data` branch periodically.

---

## 6. Notifications

Bowie chose **Web Push (PWA)**. Detailed mechanics land in §7 below.

### ⚠ Known web-push failure modes (do not design these away)

* **iOS subscriptions die silently** — deleting the Home Screen icon, clearing site data or
  revoking permission produces no server-side signal until the next send returns 404/410.
* **A silent push (one that shows no visible notification) causes iOS to revoke the
  subscription outright.** Every push must display something.
* On iOS the PWA must be **added to the Home Screen** before push works at all.

### Fallback channels, documented so they are a ~15-minute add-on

* **Telegram** — `POST https://api.telegram.org/bot<TOKEN>/sendMessage` with
  `{chat_id, text, parse_mode:"HTML"}`. Bot via @BotFather, `chat_id` from `/getUpdates`.
  Works on iPhone, Android and the Windows desktop app. No subscription that expires.
  ⚠ 4096-char limit — Telegram **rejects** an over-long message rather than truncating.
  ⚠ a bot cannot initiate a conversation; you must press `/start` once, and a block yields 403.
* **E-mail** — Gmail SMTP + app password via nodemailer (500/day, no signup) is simplest when
  mailing yourself. Brevo free (300/day, no card) is the best free API tier.
  ⚠ Resend's "3000/month" is hard-capped at 100/day and needs a verified domain.
* **ntfy.sh** — one `curl -d "text" https://ntfy.sh/<long-random-topic>`, 10 minutes, free,
  no account. ⚠ the topic name *is* the password — never put holdings in the body.

---

## 7. Web Push on GitHub Pages — verified design

Viable for a single user with **no backend at all**.

| Fact | Status |
|---|---|
| HTTPS with a valid cert is automatic on `*.github.io` | ✅ |
| `sw.js` must sit at the **published root**; its scope is then `/<repo>/`. You cannot widen it to `/` — GitHub Pages cannot send the `Service-Worker-Allowed` header | ✅ |
| Use **relative** URLs everywhere (`./sw.js`, `"start_url": "./"`) so the app works on any path | ✅ |
| VAPID keys: `npx web-push generate-vapid-keys`. Public key (87–88 chars) ships in the client and is safe to commit; private key lives in an Actions secret | ✅ |
| `applicationServerKey` **must** be a `Uint8Array`, not the base64 string | ✅ |
| `userVisibleOnly: true` is mandatory on Chrome/Edge/Firefox | ✅ |
| Payload ceiling: **3993 bytes of plaintext**. Budget ~3000 and assert on it | ✅ |
| `event.waitUntil(showNotification(...))` in the `push` handler is **mandatory** | ✅ |
| Send options that matter: `TTL: 86400` (a sleeping laptop still gets it on wake), `urgency: 'normal'`, `topic: 'daily'` (collapses an undelivered previous report) | ✅ |
| HTTP 201 from the push service means *accepted*, **not displayed** | ✅ |
| Dead subscription returns **404 or 410** — handle both | ✅ |
| `pushsubscriptionchange` fires in Firefox and **never in Chrome** | ✅ |
| `requestPermission()` must be called from a **click handler**; once denied the browser never asks again | ✅ |

### Subscription persistence — decided

**Paste the `PushSubscription` JSON once into a repository secret** (`PUSH_SUBSCRIPTION_PHONE`,
`PUSH_SUBSCRIPTION_LAPTOP`). Simplest and safest by a wide margin: zero extra infrastructure,
zero credentials in the browser, encrypted at rest, invisible in logs.

Its one weakness — silent expiry — is closed by two mechanisms, both free:

1. **Drift detector in the app**: on every open, compare `getSubscription()` against the value
   in `localStorage`; if it changed, show a banner asking for a re-paste.
2. **410 → GitHub Issue**: on 404/410 the Actions job opens an issue with the built-in
   `GITHUB_TOKEN`, which GitHub e-mails to Bowie as a re-pair prompt.

Realistic re-paste frequency: desktop Chrome roughly never, iPhone a few times a year.

**Rejected:** a `contents:write` PAT in browser storage — `https://<user>.github.io` is a single
origin **shared by every Pages project on the account** (path is not part of an origin), so any
XSS in any unrelated project of his could read that token and rewrite this repo's secrets,
including `VAPID_PRIVATE_KEY`. Also rejected: `repository_dispatch` (same PAT, and it does not
actually solve storage). A Cloudflare Worker + KV is the only fully self-healing option and is
the documented upgrade path if iOS rotation becomes annoying.

### Safari declarative web push

Including `"web_push": 8030` at the top level of the payload, with the notification under a
`notification` key (`title`, `body`, `navigate`, `app_badge`), makes Safari 18.4+ display it
declaratively while every other platform still goes through the service worker. One payload
shape covers all platforms — the SW handler must tolerate both shapes.

### ⚠ Verify before building the rest

Publish a throwaway Pages site with just a subscribe button and the service worker, add it to
the iPhone Home Screen, subscribe, and fire one push with `npx web-push send-notification`.
That settles the iOS/EU question empirically. Sources conflict badly: Apple publicly reversed
the EU removal, but stale articles still claim otherwise.
