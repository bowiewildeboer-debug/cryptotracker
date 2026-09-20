# Cryptotracker — Voortgang & Overdracht

> **Dit is het enige bestand dat je hoeft te lezen om verder te gaan waar we gebleven waren.**
> Lees daarna alleen de doc's die de openstaande chunk noemt. Niet de hele codebase inlezen.

Laatst bijgewerkt: **2026-09-20** · Sessie 1

---

## 1. Wat bouwen we

Een persoonlijke crypto **trendwatcher** voor Bowie. Elke dag (+ wekelijks/maandelijks) een
rapport met de CMC top-100 (excl. stablecoins), beoordeeld op een **eigen Ichimoku-setup** en
**EMA 21/55/100**, met als doel: welke munten staan er technisch gunstig bij om te kopen.

Daarnaast lopen er **twee gesimuleerde portefeuilles** mee, beide gestart met €10.000 op
2026-09-20: een HODL-benchmark (alles kopen naar marktcap, nooit meer aanraken) en de strategie
zelf. Puur informatief — er wordt nooit iets echt verhandeld.

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
| 2 | Indicator-engine + tests | ✅ klaar | `src/indicators/*`, `src/data/aggregate.ts` — 41 tests groen |
| 2b | Portefeuille-simulatie + tests | ✅ klaar | `src/analysis/portfolio.ts` — 22 tests groen |
| 3 | Datalaag: coinlijst, symbol-mapping, klines | ✅ klaar | `src/data/*` — live geverifieerd tegen Binance en CoinGecko |
| 4 | Analyse: signaal-tabel + BTC-filter + dag-diff | ✅ klaar | `src/analysis/signals.ts`, `src/pipeline.ts`, `data/latest.json` |
| 5 | Rapportgeneratie (week/maand-varianten) | 🟡 volgende | `src/report/*` |
| 6 | Web-app (PWA) — tabel + portefeuillegrafiek | ⬜ open | `web/` |
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
| G | Kijun of Tenkan voor het BTC-paar | — | ✅ **Kijun**, overal |
| H | 15 échte top-100-munten staan niet op Binance (HYPE #10, XMR #12, CRO, KAS, PI, FLR…) | — | ✅ **akkoord** — zo laten, wordt in het rapport getoond |
| I | CoinGecko demo-key | — | ✅ **geregeld**, staat in `.env` (gitignored) → run ging van 63s naar 3s |
| J | `data/latest.json` is ~380 KB per dag; dagelijks committen = ~140 MB/jaar | Chunk 8 | ⚠️ oplossen met een roulerend venster van 120 dagen |

---

## 7. Werk in uitvoering

_Chunk 5_ — week- en maandrapport. Contract: `docs/SPEC.md` §8.5. De dagelijkse variant
draait al volledig (`npx tsx src/cli.ts`); week en maand gebruiken dezelfde motor met een
andere referentiecandle. Niets half-af achtergelaten.

**Draaien:** `npx tsx src/cli.ts` (volledig, ~15s) of `--limit 20 --dry-run` voor snel testen.

**Verificatiescripts** (draaien tegen de echte API, geen mocks):
`npx tsx scripts/verify-binance.ts` en `npx tsx scripts/verify-universe.ts`.

---

## 8. Logboek

- **2026-09-20 s1** — Onderzoek (5 agents, alles live getest) afgerond. Kernconclusies:
  Binance werkt vanuit NL zonder key; weekly/monthly zelf aggregeren is exact; het
  `{coin}/BTC`-paar bestaat voor de meeste munten niet en moet synthetisch (gemeten fout op
  Kijun-35: 0,8%, signaalafwijking 3–5%). Repo-skelet + specs opgezet.
- **2026-09-20 s1** — Open punt A opgelost via de Pine-broncode: het script is KryptoNight's
  "Ichimoku Kinko Hyo Cloud – no offset – no repaint"; de auxiliary voedt geen enkele formule.
  Web-push-ontwerp vastgelegd (GitHub Pages + secret, geen backend). Chunk 1 afgerond.
- **2026-09-20 s1** — Chunk 2 af: Donchian, Ichimoku, EMA, predicaten en week/maand-aggregatie,
  41 tests groen. EMA draagt een exacte foutgrens mee i.p.v. een vuistregel, zodat een
  niet-geconvergeerde EMA nooit een groen vinkje kan opleveren.
- **2026-09-20 s1** — Nieuwe eis van Bowie: twee meelopende portefeuilles (€10.000 vanaf
  2026-09-20). Verdeelregel vastgelegd in `docs/SPEC.md` §11. Chunk 2b af, 22 tests groen.
  Belangrijk gevolg van de regel: kwalificeert er géén top-10-munt, dan staat minstens de
  helft van de portefeuille in stablecoins — dat volgt rechtstreeks uit de 5%-cap.
- **2026-09-20 s1** — Open punten E/F/G beantwoord. Cloudverschuiving is **35** bars (uit
  Bowie's eigen chart: 20 sep → 25 okt), traditionele verschoven cloud, en de BTC-poort van de
  portefeuille gebruikt de Kijun net als het rapport.
- **2026-09-20 s1** — Chunk 3 af en **live geverifieerd**, geen mocks:
  · 170 week- en 38 maandcandles exact gelijk aan Binance's eigen `1w`/`1M` → het ontwerp
    "alleen daily ophalen" is bewezen;
  · paginering voorbij de 1000-grens werkt, 1368 symbolen, slechts **38 BTC-paren**;
  · EURUSDT bestaat (1,1549), dus euro-waardering kan;
  · de prijscontrole ving een echte ticker-botsing: CoinGecko's `AI` (Artificial Inu) is een
    **andere munt** dan Binance's `AIUSDT` — bij een simpele ticker-match was dit stilzwijgend
    de verkeerde grafiek geworden.
- **2026-09-20 s1** — Chunk 4 af. Volledige pijplijn draait op echte data: 100 munten in ~15s
  (universe 2,7s · candles 12,3s · analyse 0,2s). Eerste echte uitkomst: 60 koopkandidaten,
  23× "liever BTC", 2 uitgevallen, BTC zelf boven zijn daily Kijun.
  Twee bugs gevonden en gefixt door het écht te draaien: BTC kreeg het label "liever BTC"
  (BTC/BTC is per definitie 1,0 en valt dus op "gelijk aan de Kijun"), en de scoreonderdelen
  telden door afronding op tot 99,98 in plaats van 100.
  Portefeuillestart gezet op **2026-09-19**: de laatste gesloten dagcandle op de dag dat Bowie
  "vandaag" zei. Anders blijft de simulatie tot de volgende run leeg.
