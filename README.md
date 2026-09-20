# Cryptotracker

Een persoonlijke crypto-trendwatcher. Elke ochtend een overzicht van de top 100 (zonder
stablecoins), beoordeeld op jouw eigen Ichimoku-instellingen en EMA 21/55/100, met daarnaast
twee meelopende portefeuillesimulaties.

* **Wat het meet en waarom** → [`docs/SPEC.md`](docs/SPEC.md)
* **Waar we staan en hoe verder** → [`PROGRESS.md`](PROGRESS.md)
* **Geverifieerde API-feiten** → [`docs/RESEARCH.md`](docs/RESEARCH.md)

---

## In één keer live zetten

### 1. Repo aanmaken en pushen

De repo moet **publiek** zijn: GitHub Pages is alleen gratis bij publieke repo's. Er staat
niets gevoeligs in — je API-sleutels gaan naar *Secrets*, en welke munten je bezit blijft in
je browser.

```bash
gh repo create cryptotracker --public --source=. --push
```

### 2. Pages aanzetten

GitHub → **Settings → Pages → Source: GitHub Actions**. Verder niets instellen.

### 3. Secrets toevoegen

GitHub → **Settings → Secrets and variables → Actions → New repository secret**.
De waarden staan in je lokale `.env` (dat bestand gaat nooit mee naar GitHub).

| Secret | Waarvoor |
|---|---|
| `COINGECKO_API_KEY` | De ranglijst ophalen. Zonder key duurt een run 63 s in plaats van 3 s. |
| `VAPID_PUBLIC_KEY` | Meldingen — hoort bij de sleutel in `web/push-config.js`. |
| `VAPID_PRIVATE_KEY` | Meldingen. **Deze is geheim.** |
| `VAPID_SUBJECT` | `mailto:jouw@adres.nl` |
| `PUSH_SUBSCRIPTION_PHONE` | Vul je in stap 5 in. |
| `PUSH_SUBSCRIPTION_LAPTOP` | Idem, optioneel. |

`CMC_API_KEY` is optioneel; zonder die sleutel gebruikt de tracker CoinGecko's ranglijst.

### 4. Eerste run

**Actions → daily report → Run workflow.** Na een paar minuten staat de app op
`https://<jouw-account>.github.io/cryptotracker/`. Daarna draait hij elke nacht om 01:17 UTC
vanzelf.

### 5. Meldingen aanzetten

1. Open de app op je telefoon, in Chrome.
2. Menu → **Toevoegen aan startscherm**, en open hem daarna vanaf dat icoon.
3. Onderaan: **Meldingen op dit apparaat** → **Meldingen aanzetten**.
4. Kopieer de sleutel die verschijnt en zet hem in de secret `PUSH_SUBSCRIPTION_PHONE`.
5. Tik in de app op **Ik heb hem in GitHub gezet**.

Herhaal stap 3–5 op je laptop met `PUSH_SUBSCRIPTION_LAPTOP` als je het daar ook wilt.

> Een push-abonnement kan vervallen — meestal als je de app van je startscherm haalt of je
> sitegegevens wist. De app merkt dat bij de eerstvolgende keer openen, en de nachtrun opent
> een GitHub-issue (die je per mail krijgt) zodra een melding niet meer aankomt. Je komt er dus
> niet pas na drie weken stilte achter.

---

## Lokaal draaien

```bash
npm install
cp .env.example .env     # en vul je sleutels in
```

| Commando | Wat het doet |
|---|---|
| `npx tsx src/cli.ts` | Volledige run, ~15 s, schrijft `data/` |
| `npx tsx src/cli.ts --report all` | Plus het week- en maandrapport |
| `npx tsx src/cli.ts --limit 20 --dry-run` | Snel testen, schrijft niets weg |
| `npm test` | 95 unit-tests |
| `npm run build && npm run serve` | De app op http://localhost:5173 |
| `npm run verify` | Controleert de echte API's: bereikbaarheid, candle-aggregatie, symboolmapping |

`npm run verify` is de moeite waard als iets raars lijkt: het vergelijkt onder meer de
zelfgebouwde week- en maandcandles met die van Binance zelf, kandelaar voor kandelaar.

---

## Hoe het werkt

```
CoinGecko  ──► ranglijst + stablecoinfilter ─┐
                                             ├─► universum (100 munten)
Binance    ──► /exchangeInfo + /ticker/price ─┘         │
                                                        ▼
Binance    ──► dagelijkse candles (alleen 1d) ──► week/maand zelf aggregeren
                                                        │
                                                        ▼
                                    Ichimoku · EMA · {munt}/BTC-ratio
                                                        │
                                          ┌─────────────┼─────────────┐
                                          ▼             ▼             ▼
                                   data/latest.json  portefeuille  melding
```

Drie ontwerpkeuzes die het uitleggen waard zijn:

**Alleen dagcandles ophalen.** Week- en maandcandles worden lokaal berekend. Dat is
geverifieerd: 170 weken en 38 maanden kwamen tot op de cent overeen met die van Binance zelf.
Eén ophaalpad, één cache, één limiet — en geen last van beurzen die het oneens zijn over waar
een week begint.

**Het `{munt}/BTC`-paar wordt berekend, niet opgehaald.** Er bestaan in totaal nog maar 38
BTC-paren op Binance, goed voor ongeveer de helft van de top-100. De ratio is simpelweg
`munt/USDT ÷ BTC/USDT`; alleen high en low worden door het *middelpunt* van BTC's dagrange
gedeeld, omdat de naïeve variant de range kunstmatig oprekt en de Kijun daar gevoelig voor is.

**Tickers worden nooit blind vertrouwd.** CoinGecko's `AI` is een andere munt dan Binance's
`AIUSDT`. Elke koppeling wordt daarom gecontroleerd tegen de prijs die Binance zelf teruggeeft;
klopt die niet, dan wordt het uitgezocht of de munt valt af. Zonder die controle zou je een
overtuigend koopsignaal krijgen voor een munt die je niet bedoelde.

---

## Wat dit niet is

Geen financieel advies, geen shortsignalen, geen orderuitvoering. De twee portefeuilles zijn
simulaties; er wordt nooit iets verhandeld. Beslissingen blijven van jou.
