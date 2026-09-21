# Cryptotracker — Voortgang & Overdracht

> **Dit is het enige bestand dat je hoeft te lezen om verder te gaan waar we gebleven waren.**
> Lees daarna alleen de doc's die de openstaande chunk noemt. Niet de hele codebase inlezen.

Laatst bijgewerkt: **2026-09-21** · Sessie 2

🟢 **Live:** https://bowiewildeboer-debug.github.io/cryptotracker/
📦 **Repo:** https://github.com/bowiewildeboer-debug/cryptotracker (publiek)
⏰ Draait elke nacht om 01:17 UTC.

---

## 1. Wat bouwen we

Een persoonlijke crypto **trendwatcher** voor Bowie. Elke dag (+ wekelijks/maandelijks) een
rapport met de CMC top-100 (excl. stablecoins), beoordeeld op een **eigen Ichimoku-setup** en
**EMA 21/55/100**, met als doel: welke munten staan er technisch gunstig bij om te kopen.

**De basismetric is het muntpaar tegen BTC.** Elke munt wordt volledig dubbel doorgerekend:
een keer op de dollarkoers en een keer op de synthetische {munt}/BTC-koers. Staat BTC zelf
boven zijn daily Kijun-sen, dan is de BTC-set leidend voor score en bakje; staat BTC eronder,
dan de dollar-set. Elke munt valt in precies een van vier bakjes: **Buitenkans**,
**Winst pakken**, **Verkopen** of **Houden**.

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
| 5 | Rapportgeneratie (week/maand-varianten) | ✅ klaar | `src/report/periodic.ts` |
| 6 | Web-app (PWA) — tabel + portefeuillegrafiek | ✅ klaar | `web/` — getest in de browser, mobiel en desktop |
| 7 | Web Push notificaties | ✅ klaar | `src/notify/push.ts`, `web/push.js`, `scripts/send-push.ts` |
| 8 | GitHub Actions: cron + deploy | ✅ klaar | `.github/workflows/daily.yml`, `README.md` |
| 8b | Publiceren: repo, Pages, secrets, eerste run | ✅ klaar | Live, eerste twee dagen data binnen |
| 9 | BTC-basis, vier bakjes, legenda | ✅ klaar | `src/analysis/metrics.ts`, herbouwde `signals.ts` en `web/app.js` |
| 10 | Validatie tegen jouw TradingView-chart | 🟡 volgende | Handmatige check van 5 munten |

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
| J | Repo-groei door dagelijks een groot bestand te committen | — | ✅ **opgelost** — `latest.json` wordt niet meer gecommit maar direct naar Pages gepubliceerd; alleen de dagsnapshots (~11 KB) gaan de repo in |
| K | Eerste live run | — | ✅ **klaar** — draait, 100 munten, ~35 s per run |
| L | Meldingen koppelen op je Android-toestel | — | ❓ **actie voor Bowie** — app op beginscherm, dan stap 5 uit `README.md` |
| M | Drempel voor Buitenkans / Winst pakken | — | 🟡 **afstelbaar** — staat op 20 in `config/params.json`. Bij 0 vulde Buitenkans zich met 45 van de 100 munten; bij 20 zijn het er 38 en zit er niets meer in op een drie dagen oude tik van een weekly EMA. Als het nog te veel voelt: hoger zetten, of `retestWindowDays` naar 2 |
| N | Auxiliary (55) uit de uitvoer | — | ✅ **gedaan** — de lijn wordt nog wel binnen Ichimoku berekend (het is een van de keuzes voor Senkou A), maar staat niet meer in `latest.json` of in de app |

---

## 7. Werk in uitvoering

_Chunk 10_ — validatie tegen Bowie's eigen TradingView-chart. Dit is de laatste stap en
alleen Bowie kan hem zetten: hij leest voor 3–5 munten de Kijun-sen, de cloudgrenzen en één
EMA van zijn scherm, en die leggen we naast `data/latest.json`.

Verwacht: kleine afwijkingen, want TradingView gebruikt mogelijk een ander paar of een andere
databron dan Binance-USDT, en Ichimoku-lijnen zijn pure high/low-middelpunten en dus gevoelig
voor één afwijkende wiek. Een afwijking van meer dan een procent op de Kijun wijst op iets
structureels (verkeerde verschuiving, verkeerd paar).

Niets half-af achtergelaten.

**Draaien:**
- `npx tsx src/cli.ts` — volledige run (~15s), schrijft `data/`
- `npx tsx src/cli.ts --report all` — plus week- en maandrapport
- `npx tsx src/cli.ts --limit 20 --dry-run` — snel testen zonder wegschrijven
- `npm run build && npm run serve` — app op http://localhost:5173

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
- **2026-09-20 s1** — Chunk 5 af (week/maand). Daarbij een te strenge eigen regel weggehaald:
  EMA-cellen werden alleen geteld als de EMA volledig geconvergeerd was, bovenop een
  vergelijking die de onzekerheid al meerekende. Beoordeelde maandsignalen gingen van 8 naar
  20 van de 25.
- **2026-09-20 s1** — Chunk 6 af: de app draait, in de browser getest op desktop én mobiel.
  Drie dingen gevonden door te kijken in plaats van te vertrouwen: de service worker serveerde
  een oude `app.js` uit cache (nu network-first, anders zie jij na een update dagen de oude
  versie), het verschil tussen beide portefeuilles toonde "+€ -0,00" door negatieve nul, en de
  grafiek zette bij één meetpunt twee stippen op verschillende hoogtes terwijl de bedragen
  tot op de cent gelijk waren.
- **2026-09-21 s1** — Chunk 7 en 8 af. Web push werkt zonder backend: het abonnement wordt
  eenmalig in een GitHub-secret geplakt, en het verlopen ervan wordt van twee kanten opgevangen
  (de app vergelijkt bij elke opening, de nachtrun opent een issue bij een 404/410).
  Bewust níet gekozen: een schrijftoken in de browser — `github.io` is één origin die alle
  Pages-projecten van een account delen.
  Workflow draait dagelijks om 01:17 UTC, draait eerst de tests, commit alleen de dagsnapshot
  en publiceert de app als artefact.
- **2026-09-21 s1** — **Live gezet.** Commit-e-mailadres op verzoek van Bowie uit de hele
  historie gehaald (nu het GitHub-noreply-adres) vóór de push, inclusief de back-upref die
  `filter-branch` achterlaat — die bevatte het oude adres nog.
  Eerste CI-run faalde op HTTP 401 bij CoinGecko: de secrets waren met `gh secret set --body -`
  gezet, en die vlag zet de **letterlijke waarde `-`** in plaats van van stdin te lezen. Zichtbaar
  doordat GitHub overal `--` maskeerde in de log (`npx tsx src/cli.ts ***report all`).
  Opnieuw gezet via stdin; tweede run geslaagd.
  Let op: lokaal gaf de foute sleutel gewoon HTTP 200 — CoinGecko is alleen streng vanaf
  datacenter-IP's. Zo'n fout is dus niet lokaal te reproduceren.
- **2026-09-21 s2** — **Grote herziening: BTC is de basis geworden.** Elke munt wordt nu dubbel
  doorgerekend — dezelfde Kijun, cloud en EMA's op de dollarkoers én op de synthetische
  {munt}/BTC-koers — en welke van de twee telt, hangt af van BTC zelf. Beide sets zitten altijd
  in `latest.json`, dus de knop "Tegen BTC / In dollars" in de app schakelt zonder nieuwe run.
  De score meet nu op de leidende basis, met 20 punten "bevestiging" als de munt óók op de
  andere basis boven zijn daily Kijun staat — dat onderscheidt een munt die zowel bitcoin als
  de dollar verslaat van een die alleen wint op de basis die vandaag toevallig geldt.
  Nieuw: drie bakjes-tabbladen (Buitenkans / Winst pakken / Verkopen) met een eigen kans- en
  winstscore, een legenda, een BTC-balk in de kop, en een niveautabel per munt met het
  percentage dat de koers moet bewegen om elk niveau te raken. "Liever BTC" en "Uitgevallen"
  zijn vervallen, en de Auxiliary (55) staat niet meer in de uitvoer.
  Eén ding pas zichtbaar geworden door het écht te draaien: zonder ondergrens vulde Buitenkans
  zich met 45 van de 100 munten, omdat er altijd wel íets binnen een paar procent van een koers
  ligt. Vandaar `minOpportunity` / `minTakeProfit` op 20 (open punt M).
  Analyse werd 6x zwaarder (vier momentopnamen per basis, om "raakte hij de weekly Kijun drie
  dagen geleden?" te kunnen beantwoorden met de weekly Kijun van die dag) en duurt nu 2,4 s in
  plaats van 0,2 s — ruim binnen de marge van een nachtrun van ~35 s.
