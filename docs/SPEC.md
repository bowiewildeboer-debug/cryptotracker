# Cryptotracker — Functional & Technical Spec

This document is **the contract**. Code must match it; if reality forces a change, change this
document in the same commit. Written in English because it is an implementation contract;
`PROGRESS.md` (Dutch) is the user-facing status document.

Version 1.0 · 2026-09-20

---

## 1. Purpose

A personal, single-user crypto **trend watcher**. It never shorts. It answers one question per
coin: *is this coin technically in an uptrend worth buying, or should I be in BTC instead?*

---

## 2. Universe

The **CoinMarketCap top 100 by market cap**, excluding assets that cannot meaningfully trend.

### 2.1 Ranking source

1. **Primary:** CoinGecko `GET https://api.coingecko.com/api/v3/coins/markets`
   `?vs_currency=usd&order=market_cap_desc&per_page=250&page=1`
   Header `x-cg-demo-api-key` (free Demo key — effectively mandatory, keyless hits HTTP 429
   after ~4 calls).
2. **Optional:** CoinMarketCap `GET https://pro-api.coinmarketcap.com/v3/cryptocurrency/listings/latest`
   `?start=1&limit=250&convert=USD&aux=cmc_rank,tags`, header `X-CMC_PRO_API_KEY`.
   Enabled by setting `CMC_API_KEY`. Costs 1 credit/day of 15 000/month.

Fetch **250**, not 100, so that after exclusions a full 100 tradeable coins remain.

### 2.2 Exclusions

A coin is excluded if any of:

| Rule | Source |
|---|---|
| In CoinGecko category `stablecoins` | `GET /coins/markets?vs_currency=usd&category=stablecoins` (refresh weekly) |
| CMC `tags` contains exactly `stablecoin` | only when CMC is enabled |
| CMC `tags` contains exactly `wrapped-tokens`, `liquid-staking` or `tokenized-gold` | idem |
| Listed in `config/exclusions.json → deny` | manual |
| No resolvable USDT spot pair on any supported exchange | symbol resolution (§4.2) |

**Do not** exclude on a substring match of `"stablecoin"` — the tag `stablecoin-protocol`
marks real trend assets (ENA, SKY, FF) and must be kept. Use exact tag equality.

`config/exclusions.json → allow` overrides every automatic exclusion, per coin id.

Every exclusion decision is written to the run log with its reason. If a coin's exclusion
reason **changes between runs**, that is logged at warn level.

---

## 3. Indicator parameters

Bowie's chart runs the TradingView script **"Ichimoku Kinko Hyo Cloud – no offset – no repaint"**
by user **KryptoNight** — identified from a verbatim match of all five input labels plus the
`9 / 26 / 52 / 52 / 26` default fingerprint, and confirmed against the raw Pine source.

| Label on his chart | Value | Config key |
|---|---|---|
| Conversion Line Period – Tenkan-Sen | 13 | `ichimoku.tenkan` |
| Base Line Period – Kijun-Sen | **35** | `ichimoku.kijun` |
| Base Line Period – Kijun-Sen (auxiliary) | 55 | `ichimoku.kijunAux` |
| Lagging Span 2 Periods – Senkou Span B | 55 | `ichimoku.senkouB` |
| Displacement: (-) Chikou Span; (+) Senkou Span A | 35 | `ichimoku.displacement` |
| Displacement: additional bars | **0** *(derived from his chart, see below)* | `ichimoku.extraBars` |

**The auxiliary base line feeds nothing.** In the Pine source `baselineA` is assigned
`donchian(55)` and then passed to two `plot()` calls only — it appears in no `fill()`, in no
span calculation and in no entry/exit condition. Because its default (52) equals the Senkou
Span B default (52), it is simply the Senkou Span B line drawn at the current bar with zero
forward displacement: a slow, flat support/resistance reference. Bowie copied 55 into both
fields, preserving exactly that relationship.

→ It is computed and exposed as an optional extra level, but it never affects the cloud or the
score. `ichimoku.senkouASource` remains configurable for safety, resolved to `"tenkan+kijun"`.

**The shift is 35, not 34** — resolved empirically from Bowie's own chart. He reports that on
20 September the cloud extends to 25 October, which is exactly 35 calendar days (and crypto
trades every day, so bars equal days). A shift of 34 would end the cloud on 24 October.
So `extraBars = 0` in his settings, and `SHIFT = displacement - extraBars = 35`.

He reads the **traditional displaced cloud**, projected forward — `cloudMode = "displaced"`.
The no-offset variant is still computed and kept in the output for reference, but it drives
neither the table nor the score. Chunk 9 confirms the shift numerically against a concrete
cloud value read off his chart.

EMAs: periods **21, 55, 100**, on close.

### 3.1 Which indicator is used on which timeframe

This matrix is exact and deliberate — cells marked `–` are **never** shown and never scored.

| | Daily | Weekly | Monthly |
|---|:---:|:---:|:---:|
| Kijun-sen (35) | ✅ | ✅ | – |
| Cloud (Senkou A / B) | ✅ | ✅ | – |
| EMA 21 | – | ✅ | ✅ |
| EMA 55 | ✅ | ✅ | – |
| EMA 100 | ✅ | ✅ | – |

→ 2 Kijun cells, 2 cloud cells, 6 EMA cells. **Monthly is used for EMA21 only.**
This is what makes the project feasible: a monthly Ichimoku with Senkou B 55 + 35 displacement
would need 90 monthly candles (7.5 years), which almost no top-100 coin has.

---

## 4. Data

### 4.1 Candles

**Single source: Binance.** `GET https://data-api.binance.vision/api/v3/klines`

* `?symbol=<SYM>&interval=1d&limit=1000` (+ `startTime` for pagination)
* No API key, no account. Weight 2/call. IP budget 6000 weight/min.
* Verified reachable from the Netherlands (HTTP 200, 2026-09-20).
* **Only `interval=1d` is ever requested.** Weekly and monthly are aggregated locally (§4.3).
  This was verified bit-exact against Binance's native `1w`/`1M` (50/50 weeks, 34/34 months).

Fallbacks behind the same interface, used only when Binance lacks the symbol:
OKX `/api/v5/market/candles` (⚠ default bars are UTC+8 aligned — must request UTC),
Bybit `/v5/market/kline`, KuCoin `/api/v1/market/candles` (⚠ field order is
`[time, open, close, high, low, volume, turnover]` — close before high/low).

History target: **up to 3000 daily candles** (≈8.2 years, Binance spot starts 2017-08-17),
which is 3 paginated calls per symbol. First run ≈300 calls ≈600 weight — ~10% of one minute's
budget. No persistent candle cache is kept in CI; a local disk cache exists for development.

Rate-limit handling is mandatory: read the `x-mbx-used-weight-1m` response header, back off
before 6000, and always honour `Retry-After`. Ignoring it escalates HTTP 429 → HTTP 418 =
**IP ban of 2 minutes up to 3 days.**

### 4.2 Symbol resolution

Never match on ticker string. The current top 100 contains `LIT` = *Lighter*, while Binance's
`LITUSDT` is *Litentry* — a live, verified wrong-coin trap.

1. Resolve CoinGecko `id` → exchange symbol via
   `GET /coins/{id}/tickers?exchange_ids=binance,okx,bybit`.
2. Pick the highest-volume ticker with `target == "USDT"` and a green `trust_score`.
3. Exchange symbol = `base + target` (verified: `BTC`+`USDT` → `BTCUSDT`).
4. Persist to `config/symbol-map.json` with a `manualOverride` field. Refresh weekly.
5. Re-read `/api/v3/exchangeInfo` every run; a symbol that disappeared must degrade to
   "insufficient data", never crash.

### 4.3 Weekly / monthly aggregation

From UTC daily candles only:

* **Week** anchor: Monday 00:00:00 UTC → Sunday 23:59:59.999 UTC.
* **Month** anchor: calendar month in UTC.
* `open` = first day's open, `high` = max of highs, `low` = min of lows,
  `close` = last day's close, `volume` = sum.
* All boundary maths in **UTC**. A naive local (CET/CEST) grouping shifts every weekly boundary
  by 1–2 hours and pulls Sunday-evening candles into the wrong week.
* The newest weekly/monthly bucket is marked `partial: true` when it is still forming.

### 4.4 The `{coin}/BTC` series — synthetic by design

Bowie's most important filter needs a `{coin}/BTC` daily series. **It mostly does not exist:**
only 33 of 67 top-100 alts have a BTC pair on Binance (~49%), and pooling seven exchanges
still reaches only 40/67 (60%). 27 top-100 alts have no BTC pair anywhere.

Therefore the ratio series is **synthesised uniformly for every coin**, including coins that do
have a real pair, so one consistent method produces the whole column:

```
ratio.open  = coin.open  / btc.open
ratio.close = coin.close / btc.close
btcMid      = (btc.high + btc.low) / 2
ratio.high  = coin.high / btcMid
ratio.low   = coin.low  / btcMid
```

Measured against 966 days of five coins that *do* have real BTC pairs: mean Kijun-35 error
**0.8%**, and the boolean `close > Kijun` signal disagrees with the real pair on only
**3–5% of days**. Good enough for a trend filter, and the UI states the method.

Both series must be aligned on UTC day before dividing; a day missing on either side yields no
ratio candle for that day.

---

## 5. Indicator maths

Implement exactly this. Deviating by one bar produces a table that silently disagrees with
Bowie's chart.

### 5.1 Ichimoku

```
donchian(len, t) = ( max(high[t-len+1 .. t]) + min(low[t-len+1 .. t]) ) / 2     // includes bar t

tenkan[t]   = donchian(13, t)
kijun[t]    = donchian(35, t)
kijunAux[t] = donchian(55, t)                      // plot-only reference level, never scored
senkouB[t]  = donchian(55, t)                      // raw, undisplaced
senkouA[t]  = (tenkan[t] + kijun[t]) / 2           // raw, undisplaced — per senkouASource

D     = 35                     // the "Displacement: (-) Chikou; (+) Senkou A" input
E     = 0                      // the "Displacement: additional bars" input, per his chart
SHIFT = D - E = 35             // ← the script plots spans at offset = displacement - extraBars

// cloudMode = "displaced"  (default, classic Ichimoku)
cloudTop(t)    = max( senkouA[t-SHIFT], senkouB[t-SHIFT] )
cloudBottom(t) = min( senkouA[t-SHIFT], senkouB[t-SHIFT] )

// cloudMode = "noOffset"
cloudTop(t)    = max( senkouA[t], senkouB[t] )
cloudBottom(t) = min( senkouA[t], senkouB[t] )

chikou(t)      = close[t+SHIFT]                    // null for the last SHIFT bars
```

`SHIFT = D - E` must be a **named constant with this comment**. Using `D` instead puts the whole
cloud column one bar out of sync with what Bowie sees, and it will be reported as a bug.
Both cloud modes are always computed and both are present in the output JSON; `cloudMode`
only decides which one the table and the score use.

Senkou A and Senkou B swap order at every Kumo twist, so cloud top/bottom must always be
`max`/`min`, never "A is the top".

### 5.2 EMA

```
alpha  = 2 / (n + 1)
ema[n-1] = sma(close, n)                           // SMA seed at index n-1
ema[t]   = alpha * close[t] + (1 - alpha) * ema[t-1]
ema[t]   = null  for t < n-1
```

**Convergence state** — never render a green check from an unconverged EMA. Instead of a
rule-of-thumb bar count, compute the actual bound:

```
warmup    = bars - n                               // bars after the seed
seedError = | sma_seed - ema_last |
bound     = (1 - alpha)^warmup * seedError / lastClose

state = "ok"          when bars >= n and bound < 0.001     (<0.1% of price)
      = "provisional" when bars >= n and bound < 0.01      (<1%)
      = "na"          otherwise (including bars < n)
```

`na` renders `–`. `provisional` renders the value greyed with a `~` prefix and scores **0**.
Without this, most alts would get a fake green tick on weekly EMA100 computed from 30 bars.

### 5.3 Primitive predicates

Defined once, used everywhere. `eps = 1e-9 * |level|` (float noise only).

```
touched(bar, level) = level != null && bar.low - eps <= level && level <= bar.high + eps
above(bar, level)   = level != null && bar.close >  level + eps
below(bar, level)   = level != null && bar.close <  level - eps
```

Anything neither `above` nor `below` is **at** — rendered neutral, never green.
`touched` is reported as a **separate flag** from `above`/`below`: a candle can be above the
Kijun *and* have touched it (wick down to the line = a support test), which is exactly the
signal Bowie asked for.

### 5.4 Cloud state

```
aboveCloud(t) = close[t] > cloudTop(t)
inCloud(t)    = cloudBottom(t) <= close[t] <= cloudTop(t)
belowCloud(t) = close[t] < cloudBottom(t)

touchedCloudTop(t)    = touched(bar[t], cloudTop(t))
touchedCloudBottom(t) = touched(bar[t], cloudBottom(t))
```

Support vs resistance is decided by the **previous** bar's state, not the current one:

* touched a boundary while `aboveCloud(t-1)` → **support test**
* touched a boundary while `belowCloud(t-1)` → **resistance test**
* touched while `inCloud(t-1)` → **inside the cloud**, neutral

If `cloudTop == cloudBottom` (a twist bar), emit a single `touchedTwist` flag, never two.

### 5.5 Cross detection

```
crossedBelowToday = above(bar[t-1], kijun[t-1]) && !above(bar[t], kijun[t])
crossedAboveToday = !above(bar[t-1], kijun[t-1]) && above(bar[t], kijun[t])
```

Each bar is always compared against **its own** indicator value. Never apply today's Kijun to
yesterday's candle. This is computed from the candle series, not from the previous run's
output, so it is self-healing after a missed run.

### 5.6 Cross-timeframe evaluation

"Did yesterday's *daily* candle touch the *weekly* Kijun?" requires the weekly Kijun **as it
stood at the close of that day**: rebuild the partial weekly candle from only the days up to
and including that day, compute the weekly Kijun on that series, then apply `touched(dailyBar, weeklyKijun)`.

The same procedure applies to every HTF level in the daily touch-set.

---

## 6. Which candle is "now"

The job runs at 01:17 UTC, so today's daily candle is ~1 hour old and meaningless. Define:

| Symbol | Meaning |
|---|---|
| `C0` | the **last closed** daily candle — the report's reference day |
| `C1` | the daily candle before `C0` |
| `CLIVE` | the in-progress daily candle (today, UTC) |

* All ✓/✗ states, all touch flags and all scoring are computed on **`C0`**.
* "was above yesterday, not today" = `above(C1, kijun[C1]) && !above(C0, kijun[C0])`.
* `CLIVE` is shown in one clearly separate, greyed **"live"** column so the app is still useful
  when opened at 20:00. It never affects scoring or notifications.
* Weekly and monthly: the daily report uses the **in-progress** weekly/monthly candle for its
  current-state columns (this is what TradingView shows live) and marks those cells with a
  `~` provisional badge plus "closes in Nd". The **weekly report** uses only the last closed
  weekly candle; the **monthly report** only the last closed monthly candle.
* A push notification must never state an in-progress HTF flag without the word "voorlopig".

---

## 7. The BTC-relative filter

Bowie's own words: *"Als het tradingpaar {coin}/btc nog onder de kijun-sen daily zit maar btc
zelf zit wél boven de daily kijun-sen, dan zit ik liever in btc."*

```
btcInTrend      = above(BTCUSDT.C0, BTCUSDT.kijunD)
coinBtcInTrend  = above(COINBTC.C0,  COINBTC.kijunD)         // synthetic series, §4.4

preferBtc       = btcInTrend && !coinBtcInTrend
outperformsBtc  = coinBtcInTrend
```

`preferBtc` demotes a coin into its own report section — it is not removed, because Bowie still
wants to see it. For BTC itself both flags are `null`.

When `btcInTrend` is **false** (BTC itself is below its daily Kijun) the filter is inactive and
the report says so in one line at the top; in that regime rotating to BTC is not a safe haven.

---

## 8. Report

### 8.1 Row inclusion — daily report

A coin appears if **any** of:

* **A. In trend** — `above(C0, kijunD)`
* **B. Dropped out** — `crossedBelowToday` on the daily Kijun
* **C. Owned** — listed in `config/holdings.json`, regardless of state

### 8.2 Sections

| # | Section | Contents |
|---|---|---|
| 1 | 🟢 **Koopkandidaten** | A, not `preferBtc` — sorted by score desc |
| 2 | 🟠 **In trend, maar liever BTC** | A and `preferBtc` — sorted by score desc |
| 3 | 🔴 **Vandaag uitgevallen** | B — was above the daily Kijun yesterday, is not today |
| 4 | 💼 **Mijn posities** | C — always, with its own state, whatever it is |

A coin in section 3 or 4 is not repeated in 1 or 2.

### 8.3 Columns

| Column | Content |
|---|---|
| `#` | CMC / CoinGecko market-cap rank |
| Coin | symbol + name |
| Prijs | `C0.close`, 24h % change |
| **Kijun D** | ✓/✗ above · `•` if `C0` touched it · `↓` if crossed below today |
| **Kijun W** | ✓/✗ above (provisional badge) · `•` if `C0` touched the weekly Kijun |
| **Cloud D** | `▲` above / `≈` in / `▼` below · `⌃`/`⌄` if `C0` touched top/bottom · S/R label |
| **Cloud W** | idem, provisional |
| **EMA21 W** | ✓/✗/~/– · `•` if `C0` touched it |
| **EMA21 M** | ✓/✗/~/– · `•` if `C0` touched it |
| **EMA55 D** | ✓/✗/~/– · `•` if `C0` touched it |
| **EMA55 W** | ✓/✗/~/– · `•` if `C0` touched it |
| **EMA100 D** | ✓/✗/~/– · `•` if `C0` touched it |
| **EMA100 W** | ✓/✗/~/– · `•` if `C0` touched it |
| **vs BTC** | ✓ outperforms / ⚠ prefer BTC · `(syn)` when the pair is synthetic |
| **Score** | 0–100 (§8.4) with "n pts n/a" annotation |
| Live | greyed current-price state vs daily Kijun |

The "touched an EMA" signal covers exactly the six used cells — the daily EMA21 is excluded,
as Bowie specified, because he does not use it.

### 8.4 Score

Transparent and fully additive, so any cell can be traced back from the total.

| Component | Points |
|---|---:|
| Above daily Kijun | 25 |
| Above weekly Kijun | 15 |
| `coinBtcInTrend` (above daily Kijun on the BTC pair) | 20 |
| Cloud daily: above 12 / in 4 / below 0 | 12 |
| Cloud weekly: above 8 / in 3 / below 0 | 8 |
| Each of the 6 EMA cells above (3.33 each) | 20 |
| **Total** | **100** |

`provisional` and `na` cells score **0** and their maximum is subtracted from the denominator,
which is reported as `score 72/100 (8 n.v.t.)`. A coin is never silently rewarded or punished
for missing history.

### 8.5 Weekly and monthly reports

Same engine, different reference candle and a different change window:

* **Weekly** — runs Monday 01:17 UTC. Reference = last closed weekly candle. Adds a
  "veranderd t.o.v. vorige week" section (entered/left the weekly Kijun trend, entered/left the
  weekly cloud).
* **Monthly** — runs on the 1st at 01:17 UTC. Reference = last closed monthly candle. The only
  monthly indicator is EMA21, so this report is short: above/below monthly EMA21 and the
  changes versus last month, plus a weekly-state recap.

### 8.6 Output artefacts

```
data/latest.json              full analysis of the most recent daily run
data/history/YYYY-MM-DD.json  daily snapshot, rolling 120 days
data/reports/daily-YYYY-MM-DD.json
data/reports/weekly-YYYY-Www.json
data/reports/monthly-YYYY-MM.json
data/meta.json                run timestamp, param set, source health, exclusion log
```

Every artefact embeds the full parameter set that produced it, including
`ichimoku.senkouASource`, so an old report stays interpretable after a config change.

---

## 9. App

A static PWA, installable on iPhone/Android and on the Windows laptop, reading the JSON
artefacts. Requirements:

* Readable on a phone: the wide table collapses into per-coin cards below 720px.
* Sections from §8.2 as tabs/anchors; sort and filter client-side.
* A prominent **"data van <timestamp> UTC"** badge — GitHub cron drifts 5–30 minutes and can
  skip a run; stale data must never look fresh.
* Holdings (§8.1 C) editable in the app and persisted, so no code change is needed to mark a
  coin as owned.
* Offline-capable: the service worker caches the shell and the last fetched JSON.
* Dark and light mode, following the system setting.

---

## 10. Notifications

**Web Push (PWA)**, chosen by Bowie. VAPID keys in GitHub Secrets, sent with the `web-push`
npm package at the end of the job.

The notifier is an interface with one implementation today; Telegram and e-mail are documented
in `docs/RESEARCH.md` and can be added as extra implementations without touching the pipeline.

Push payload: short summary (number of buy candidates, number of dropouts, top 3 by score) plus
a deep link into the app. Known constraint: on iOS the PWA must be added to the Home Screen
first. Full mechanics: see the web-push section of `docs/RESEARCH.md`.

---

## 11. Portfolio simulation

Two simulated portfolios run alongside the report, both starting with **€10 000 on
2026-09-20** (`portfolio.startDate`, `portfolio.startCapitalEur`). They answer one question:
*what does following the rules actually buy me over just holding everything?*

**This is a tracker, not a trading system.** Nothing is ever executed. Both portfolios are
informational simulations.

### 11.1 Common conventions

| Convention | Value |
|---|---|
| Internal currency | **USD** (all candle data is USDT-quoted) |
| Display currency | **EUR**, via Binance `EURUSDT` daily close |
| Valuation moment | the daily close of `C0` (§6) |
| Transaction fee | **0.15%** of the absolute notional traded, on both buys and sells |
| Cash | held as a **USD stablecoin** — it therefore carries EUR/USD exchange-rate exposure, which is shown separately |
| Start | €10 000 converted to USD at the `EURUSDT` close of the start date |

**The portfolio state is derived, never incrementally mutated.** Every run replays the whole
history from the start date out of the committed daily universe snapshots plus candle data.
A missed run therefore heals itself on the next run instead of corrupting the series. When a
day's universe snapshot is missing, the previous day's ranks and market caps are carried
forward and the gap is logged.

Both portfolios start on 2026-09-20 by explicit choice — there is no historical backtest.
The indicators themselves still use all available history.

### 11.2 Portfolio A — "HODL" benchmark

Buy once, never touch again.

* On the start date, buy the **entire universe** (§2, top 100 after exclusions) weighted by
  market cap on that date.
* One 0.15% fee on the initial purchase.
* Units are then **fixed forever**. No rebalancing, no reaction to index changes — that is
  what buy-and-hold means, and it is what makes it an honest benchmark.
* `value(t) = Σ unitsᵢ × closeᵢ(t)`
* If a coin stops trading, its last available price is carried forward and the position is
  flagged `stale` in the output. It is never silently dropped.

### 11.3 Portfolio B — "Strategy"

#### Qualification on day `t`

| Asset | Qualifies when |
|---|---|
| BTC | `close_BTC(t) > kijunDaily_BTC(t)` |
| any altcoin `X` | `close_X(t) > kijunDaily_X(t)` **and** `close_X/BTC(t) > kijunDaily_X/BTC(t)` |

The altcoin gate uses the **Kijun-sen (35)** of the `{coin}/BTC` series — the synthetic ratio
of §4.4 — the same line as the `preferBtc` report flag (§7), so the table and the portfolio
can never disagree about whether a coin is beating BTC.

#### Target weights

Let `T` = qualifying coins ranked **1–10**, `A` = qualifying coins ranked **11+**.
Ranks are within the *filtered* universe, so stablecoins and wrapped assets never occupy a
top-10 slot.

```
wA_each  = |A| > 0 ? min(0.05, 0.50 / |A|) : 0     // max 5% per coin, max 50% in total
wA_total = |A| * wA_each
wT_total = 1 - wA_total                            // so T always gets at least 50%
```

* `A` is split **evenly**: every coin outside the top 10 gets the same weight, capped at 5%.
  With more than 10 qualifying altcoins each simply gets less than 5%, never more in total.
* `wT_total` is split **pro rata by market cap** across `T`.
* **If `T` is empty, `wT_total` stays in cash.** It is a direct consequence of the rules, not
  a special case: altcoins can never hold more than 50% between them, so with no qualifying
  top-10 coin the portfolio is at least half in stablecoins.
* If nothing qualifies at all, the portfolio is **100% stablecoin**. Explicitly allowed.

#### Rebalancing

Traded on a day when **either**:

1. the qualifying set changed — a coin entered or left, or
2. it is the first valuation day of a new UTC week (§4.3 week anchor).

Between rebalances the positions simply drift with price; no trading, no fees.

### 11.4 Output

`data/portfolio.json`:

```
startDate, startCapitalEur, feeRate, params
eurUsd:    { date -> rate }
series:    [ { date, hodlEur, hodlUsd, strategyEur, strategyUsd, cashUsd, qualifyingCount } ]
holdings:  { hodl: [...], strategy: [...] }     // current units, weight, value, stale flag
trades:    [ { date, symbol, side, notionalUsd, feeUsd, reason } ]
stats:     { since start: return %, max drawdown %, best/worst day, days in cash, total fees }
```

Both curves, the cash share and the qualifying-coin count are charted in the app, plus a
plain "strategy vs hodl" difference in euros — the number Bowie actually wants to look at.

---

## 12. Non-goals

* No shorting signals, no leverage, no order execution.
* No intraday timeframes (< 1 day).
* No monthly Ichimoku (§3.1).
* No price prediction, no backtest engine, no portfolio P&L.
* This is a decision-support tool. It produces no financial advice.
