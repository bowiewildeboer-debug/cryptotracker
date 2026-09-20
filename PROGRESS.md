# Cryptotracker — Voortgang & Overdracht

> **Dit is het enige bestand dat je hoeft te lezen om verder te gaan waar we gebleven waren.**
> Lees daarna alleen de doc's die de openstaande chunk noemt. Niet de hele codebase inlezen.

Laatst bijgewerkt: **2026-09-20** · Sessie 1

---

## 1. Wat bouwen we

Een persoonlijke crypto **trendwatcher** voor Bowie. Elke dag (+ wekelijks/maandelijks) een
rapport met de CMC top-100 (excl. stablecoins), beoordeeld op een **eigen Ichimoku-setup** en
**EMA 21/55/100**, met als doel: welke munten staan er technisch gunstig bij om te kopen.

Volledige functionele eisen: [`docs/SPEC.md`](docs/SPEC.md) — dat is het contract, niet dit bestand.

---

## 2. Vastgelegde keuzes (niet opnieuw bediscussiëren)

| Onderwerp | Keuze | Waarom |
|---|---|---|
| Ranglijst top-100 | CoinGecko `/coins/markets` als primair, CMC optioneel | Geen API-key nodig om te starten; CMC kan er later bij |
| Candles (OHLCV) | **Binance `data-api.binance.vision`**, alléén `interval=1d` | Gratis, geen key, niet geo-geblokkeerd in NL, 6000 gewicht/min |
| Weekly/monthly candles | **Zelf aggregeren uit daily** | Bewezen bit-exact gelijk aan Binance native `1w`/`1M` (50/50 en 34/34 match) |
| `{coin}/BTC` paar | **Synthetisch berekenen** uit COIN/USDT ÷ BTC/USDT | Slechts ~49% van de top-100 heeft een écht BTC-paar op Binance, 60% op álle beurzen samen |
| Scheduler | GitHub Actions (cron) | Gratis, betrouwbaar genoeg, account `bowiewildeboer-debug` |
| Opslag | JSON-bestanden in de repo (git = gratis historie) | Geen database nodig; "gister wel, vandaag niet" is letterlijk een diff |
| Notificaties | **Web Push (PWA)** — door gebruiker gekozen | Telegram/e-mail zijn gedocumenteerd als fallback, niet gebouwd |
| Web-app hosting | **GitHub Pages** (publieke repo — privé vereist GitHub Pro) | Blijft volledig binnen GitHub, €0 |
| Push-subscription opslag | Eenmalig plakken in een GitHub Actions *secret* | Geen backend, geen token in de browser (zie RESEARCH §7) |
| Taal code | TypeScript op Node 24 | Node 24.12 staat al lokaal |

Volledige onderbouwing + alle geverifieerde API-feiten: [`docs/RESEARCH.md`](docs/RESEARCH.md).

---

## 3. Jouw Ichimoku-instellingen

```
Tenkan-sen ................... 13
Kijun-sen .................... 35   ← belangrijkste factor
Kijun-sen (auxiliary) ........ 55   ← doet niets aan de cloud, alleen een getekende lijn
Senkou Span B ................ 55
-Chikou Span / +Senkou Span A  35   (displacement)
Displacement: additional bars   1   (aanname: standaardwaarde)
```

Je draait het TradingView-script **"Ichimoku Kinko Hyo Cloud – no offset – no repaint"**
van **KryptoNight**. Uit de Pine-broncode blijkt:

```
Senkou Span A = (Tenkan 13 + Kijun 35) / 2      ← de auxiliary zit hier NIET in
Senkou Span B = (HH55 + LL55) / 2
beide verschoven met 35 - 1 = 34 bars
auxiliary     = (HH55 + LL55) / 2 op de huidige candle, onverschoven
```

De auxiliary is dus letterlijk dezelfde lijn als Senkou Span B, maar dan zonder de verschuiving
naar voren — een trage vlakke steun/weerstand. Hij wordt wél berekend, maar telt niet mee.

---

## 4. Chunk-planning

Elke chunk is los afrondbaar en test-baar. Na elke chunk wordt dit bestand bijgewerkt.

| # | Chunk | Status | Levert op |
|---|---|---|---|
| 0 | Onderzoek databronnen & infra | ✅ klaar | `docs/RESEARCH.md` |
| 1 | Repo-skelet, specs, config | ✅ klaar | `docs/SPEC.md`, `config/`, `package.json` |
| 2 | Indicator-engine + tests | 🟡 bezig | `src/indicators/*`, groene unit-tests tegen bekende waarden |
| 3 | Datalaag: coinlijst, symbol-mapping, klines, cache | ⬜ open | `src/data/*`, lokale cache met echte candles |
| 4 | Analyse: signaal-tabel + BTC-filter + dag-diff | ⬜ open | `src/analysis/*`, `data/latest.json` |
| 5 | Rapportgeneratie (dag/week/maand) | ⬜ open | `src/report/*` |
| 6 | Web-app (PWA) — tabel, mobiel + laptop | ⬜ open | `web/` |
| 7 | Web Push notificaties | ⬜ open | `src/notify/*`, service worker |
| 8 | GitHub Actions: cron + deploy | ⬜ open | `.github/workflows/*` |
| 9 | Validatie tegen jouw TradingView-chart | ⬜ open | Handmatige check van 5 munten |

---

## 5. Hoe je verder gaat na een tokenlimiet

1. Lees **dit bestand** (§4 → welke chunk is 🟡 of de eerste ⬜).
2. Lees **`docs/SPEC.md`** §§ die die chunk noemt.
3. Lees de bestanden die in §7 "Werk in uitvoering" staan.
4. Werk de chunk af, draai `npm test`, werk §4 en §7 hier bij, commit.

**Niet doen:** de hele `src/` inlezen om "context op te bouwen". De specs zijn het contract.

---

## 6. Open punten

| Id | Vraag | Blokkeert | Status |
|---|---|---|---|
| A | Rol van "Kijun-sen (auxiliary) = 55" | Chunk 2 | ✅ **opgelost** — puur een getekende lijn, zit in geen enkele formule |
| B | Repo publiek of privé | Chunk 8 | ✅ **besloten** — publiek, want GitHub Pages is alleen gratis bij een publieke repo. Holdings gaan naar een secret, niet de repo |
| C | Welke munten bezit je? | Chunk 4 | ❓ vraag aan Bowie, kan later |
| D | iPhone of Android? | Chunk 7 | ❓ vraag aan Bowie |
| E | Lees je de **verschoven** cloud of de **no-offset** cloud van dat script? | Chunk 4 (weergave) | ❓ vraag aan Bowie — beide worden berekend, `cloudMode` schakelt |
| F | Staat "Displacement: additional bars" bij jou op 1? | Chunk 2 | ❓ vraag aan Bowie — bepaalt of de shift 34 of iets anders is |

---

## 7. Werk in uitvoering

_Chunk 2_ — indicator-engine in `src/indicators/`. Contract staat in `docs/SPEC.md` §5.
Niets half-af achtergelaten.

---

## 8. Logboek

- **2026-09-20 s1** — Onderzoek (5 agents, alles live getest) afgerond. Kernconclusies:
  Binance werkt vanuit NL zonder key; weekly/monthly zelf aggregeren is exact; het
  `{coin}/BTC`-paar bestaat voor de meeste munten niet en moet synthetisch (gemeten fout op
  Kijun-35: 0,8%, signaalafwijking 3–5%). Repo-skelet + specs opgezet.
- **2026-09-20 s1** — Open punt A opgelost via de Pine-broncode: het script is KryptoNight's
  "Ichimoku Kinko Hyo Cloud – no offset – no repaint"; de auxiliary voedt geen enkele formule.
  Web-push-ontwerp vastgelegd (GitHub Pages + secret, geen backend). Chunk 1 afgerond.
