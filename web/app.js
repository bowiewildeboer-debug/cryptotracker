/**
 * Cryptotracker - static front end.
 *
 * No framework and no build step: the whole app is three files that GitHub Pages can serve
 * as-is, which keeps deployment to "copy the folder". It reads one JSON file produced by the
 * nightly job and renders it.
 *
 * The report carries TWO complete indicator sets per coin: one on the USD candles (`usd`) and
 * one on the synthetic {coin}/BTC candles (`btcPair`). Which one leads is decided by BTC
 * itself and travels in `primaryBase`; the base switch in the tab bar lets you override that
 * and look at the other one without a new run.
 *
 * Holdings live in localStorage, not in the repo. The repo is public (that is what makes
 * Pages free), and which coins you own is nobody else's business. Everything the app needs
 * to highlight them it can do client-side; `config/holdings.json` exists only so the push
 * notification can mention them, and the app offers the JSON to paste there.
 */

import { pushSupported, enablePush, subscriptionDrift, currentSubscription, markPasted, unsubscribe } from './push.js';

const DATA_URL = './data/latest.json';
const HOLDINGS_KEY = 'cryptotracker.holdings.v1';
const TAB_KEY = 'cryptotracker.tab.v1';
const BASE_KEY = 'cryptotracker.base.v1';

const state = {
  report: null,
  tab: 'buitenkans',
  /** 'auto' follows the report's own primaryBase; 'usd' and 'btc' force one. */
  base: 'auto',
  holdings: new Set(),
};

/* ------------------------------------------------------------------ storage */

function loadHoldings() {
  try {
    const raw = localStorage.getItem(HOLDINGS_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set(); // private mode, blocked storage, corrupt value - never fatal
  }
}

function saveHoldings() {
  try {
    localStorage.setItem(HOLDINGS_KEY, JSON.stringify([...state.holdings]));
  } catch {
    /* ignore */
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ helpers */

/** Wraps a node in a <td>, because `append` returns undefined and cannot be chained. */
const td = (node, className) => {
  const cell = el('td', className);
  if (node) cell.append(node);
  return cell;
};

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

function money(n, digits) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  const d = digits ?? (Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 3 : 6);
  return n.toLocaleString('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/**
 * A price in whichever base is on screen. BTC ratios are tiny - an altcoin at 0,00002341 BTC
 * rounds to 0,000023 with the USD rule and loses two meaningful digits, so they get eight.
 */
const price = (n, base) => (base === 'btc' ? money(n, 8) : money(n));
const unit = (base) => (base === 'btc' ? '₿' : '$');

const eur = (n) =>
  Number.isFinite(n) ? n.toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }) : '-';

/** Signed percentage in Dutch notation. Zero gets no sign at all. */
const pct = (n, digits = 2) => {
  if (!Number.isFinite(n)) return '-';
  const v = Math.abs(n) < 0.5 / 10 ** digits ? 0 : n;
  return `${v > 0 ? '+' : ''}${v.toLocaleString('nl-NL', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
};

function hoursSince(isoDate) {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : Infinity;
}

/** The coin's own view of whether it is owned, from local storage rather than the report. */
const isOwned = (coin) => state.holdings.has(coin.symbol);

/**
 * The metric set to render for this coin, honouring the base switch.
 *
 * Falls back to USD whenever the BTC set does not exist - BTC itself, and any coin with no
 * overlapping history - so forcing the BTC view never blanks out rows.
 */
function setFor(coin) {
  const wanted = state.base === 'auto' ? coin.primaryBase : state.base;
  return wanted === 'btc' && coin.btcPair ? coin.btcPair : coin.usd;
}

/** Is the coin being shown on the base the report itself scored it on? */
const onPrimary = (coin) => setFor(coin).base === coin.primaryBase;

/* ------------------------------------------------------------------ buckets */

const BUCKETS = {
  buitenkans: { label: 'Buitenkans', cls: 'b-kans', icon: '◆' },
  'winst-pakken': { label: 'Winst pakken', cls: 'b-winst', icon: '▲' },
  verkopen: { label: 'Verkopen', cls: 'b-verkoop', icon: '▼' },
  houden: { label: 'Houden', cls: 'b-houden', icon: '=' },
};

function bucketBadge(coin) {
  const b = BUCKETS[coin.bucket] ?? BUCKETS.houden;
  const span = el('span', `bucket ${b.cls}`);
  span.append(el('i', null, b.icon), document.createTextNode(b.label));
  if (coin.bucket === 'verkopen' && coin.sellInto) {
    span.append(el('em', null, coin.sellInto === 'btc' ? '→ BTC' : '→ €'));
  }
  span.title = coin.bucketReason;
  return span;
}

/* ------------------------------------------------------------------ cells */

function kijunCell(cell) {
  const span = el('span');
  if (!cell || cell.verdict === 'unknown') {
    span.append(el('span', 'na', '–'));
    return span;
  }
  span.append(el('span', cell.verdict === 'above' ? 'yes' : 'no', cell.verdict === 'above' ? '✓' : '✗'));
  // A candle can be above the line AND have touched it: the wick-down support test.
  if (cell.touchedByRef) span.append(el('span', 'touch', ' •'));
  if (cell.crossedBelowToday) span.append(el('span', 'no', ' ↓'));
  if (cell.crossedAboveToday) span.append(el('span', 'yes', ' ↑'));
  return span;
}

const CLOUD_GLYPH = { above: '▲', in: '≈', below: '▼', unknown: '–' };
const CLOUD_CLASS = { above: 'yes', in: 'prov', below: 'no', unknown: 'na' };

function cloudCell(cell) {
  const span = el('span');
  span.append(el('span', CLOUD_CLASS[cell.position], CLOUD_GLYPH[cell.position]));
  if (cell.touchedTwist) span.append(el('span', 'touch', ' ⋈'));
  else {
    if (cell.touchedTop) span.append(el('span', 'touch', ' ⌃'));
    if (cell.touchedBottom) span.append(el('span', 'touch', ' ⌄'));
  }
  return span;
}

function emaCell(cell) {
  const span = el('span');
  if (cell.verdict === 'unknown') span.append(el('span', 'na', '–'));
  else if (cell.verdict === 'above') span.append(el('span', cell.state === 'ok' ? 'yes' : 'prov', cell.state === 'ok' ? '✓' : '~✓'));
  else if (cell.verdict === 'below') span.append(el('span', cell.state === 'ok' ? 'no' : 'prov', cell.state === 'ok' ? '✗' : '~✗'));
  else span.append(el('span', 'prov', '·'));
  if (cell.touchedByRef) span.append(el('span', 'touch', ' •'));
  return span;
}

/** How this coin looks on the base that is NOT on screen - the score's confirmation cell. */
function otherBaseCell(coin) {
  const shown = setFor(coin);
  const other = shown.base === 'btc' ? coin.usd : coin.btcPair;
  if (!other) return el('span', 'na', '–');
  const v = other.kijun.daily.verdict;
  const word = other.base === 'btc' ? 'BTC' : 'USD';
  if (v === 'unknown') return el('span', 'na', '–');
  return el('span', `pill ${v === 'above' ? 'ok' : 'warnp'}`, `${v === 'above' ? '✓' : '✗'} ${word}`);
}

function scoreCell(coin) {
  const wrap = el('td', 'num score-bar');
  const share = coin.score.max > 0 ? (coin.score.points / coin.score.max) * 100 : 0;
  const fill = el('div', 'fill');
  fill.style.width = `${Math.max(0, Math.min(100, share))}%`;
  wrap.append(fill, el('span', null, `${coin.score.points.toFixed(0)}/${coin.score.max.toFixed(0)}`));
  return wrap;
}

/** The extra score that matters for the tab you are on, as a compact bar. */
function extraCell(value, cls) {
  const wrap = el('td', 'num score-bar');
  const fill = el('div', `fill ${cls}`);
  fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  wrap.append(fill, el('span', null, value.toFixed(0)));
  return wrap;
}

function starButton(coin, onChange) {
  const b = el('button', `star${isOwned(coin) ? ' on' : ''}`, isOwned(coin) ? '★' : '☆');
  b.title = isOwned(coin) ? 'Je bezit deze munt - klik om te verwijderen' : 'Markeer als bezit';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOwned(coin)) state.holdings.delete(coin.symbol);
    else state.holdings.add(coin.symbol);
    saveHoldings();
    onChange();
  });
  return b;
}

/* ------------------------------------------------------------------ sections */

const EMA_LABEL = (c) => `${c.period}${c.timeframe === 'daily' ? 'D' : c.timeframe === 'weekly' ? 'W' : 'M'}`;

const TABS = [
  {
    id: 'buitenkans',
    label: 'Buitenkans',
    extra: 'kans',
    note:
      'Boven de daily Kijun-sen én in de afgelopen dagen een geslaagde test van een belangrijk niveau: ' +
      'de koers kwam terug tot op de lijn en sloot er toch weer bóven. Hoe verser de test en hoe zwaarder het niveau, hoe hoger de kansscore.',
  },
  {
    id: 'winst-pakken',
    label: 'Winst pakken',
    extra: 'winst',
    note:
      'Boven de daily Kijun-sen, maar de koers loopt van onderaf tegen een belangrijk niveau aan. ' +
      'Dat is waar een stijging vaak stokt — het spiegelbeeld van een buitenkans.',
  },
  {
    id: 'verkopen',
    label: 'Verkopen',
    note: 'Onder de daily Kijun-sen. Er staat bij waar de opbrengst heen moet: naar BTC zolang BTC zelf boven zijn Kijun staat, anders naar euro.',
  },
  { id: 'buy', label: 'Koopkandidaten', note: 'Alles boven de daily Kijun-sen dat je nog niet bezit, ongeacht bakje.' },
  { id: 'owned', label: 'Mijn posities', note: 'Munten die je met de ster hebt gemarkeerd. Dit blijft op dit apparaat.' },
  { id: 'portfolio', label: 'Portefeuille', note: '' },
  { id: 'all', label: 'Alles', note: 'De volledige lijst, gesorteerd op score.' },
];

function coinsFor(tab) {
  const all = state.report?.coins ?? [];
  switch (tab) {
    case 'buitenkans':
      return [...all.filter((c) => c.bucket === 'buitenkans')].sort((a, b) => b.opportunity.points - a.opportunity.points);
    case 'winst-pakken':
      return [...all.filter((c) => c.bucket === 'winst-pakken')].sort((a, b) => b.takeProfit.points - a.takeProfit.points);
    case 'verkopen':
      return all.filter((c) => c.bucket === 'verkopen');
    case 'buy':
      return all.filter((c) => c.inTrend && !isOwned(c));
    case 'owned':
      return all.filter((c) => isOwned(c));
    case 'all':
      return all;
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ rendering */

function renderTabs() {
  const nav = document.getElementById('tabs');
  nav.replaceChildren();
  for (const t of TABS) {
    const b = el('button', 'tab');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(state.tab === t.id));
    b.append(document.createTextNode(t.label));
    if (t.id !== 'portfolio') b.append(el('span', 'count', String(coinsFor(t.id).length)));
    b.addEventListener('click', () => {
      state.tab = t.id;
      remember(TAB_KEY, t.id);
      render();
    });
    nav.append(b);
  }
}

const BASE_CHOICES = [
  ['auto', 'Automatisch'],
  ['btc', 'Tegen BTC'],
  ['usd', 'In dollars'],
];

function renderBaseSwitch() {
  const host = document.getElementById('base-switch');
  host.replaceChildren();
  const auto = state.report.btcInTrend ? 'tegen BTC' : 'in dollars';
  host.append(el('span', 'base-label', 'Meten'));
  for (const [id, label] of BASE_CHOICES) {
    const b = el('button', 'seg');
    b.setAttribute('aria-selected', String(state.base === id));
    b.textContent = id === 'auto' ? `Automatisch (${auto})` : label;
    b.addEventListener('click', () => {
      state.base = id;
      remember(BASE_KEY, id);
      render();
    });
    host.append(b);
  }
}

function renderHeader() {
  const r = state.report;
  const fresh = document.getElementById('freshness');
  const age = hoursSince(r.asOf);
  // GitHub's cron drifts and can skip a run entirely, so stale data must never look current.
  const stale = age > 48;
  fresh.className = `freshness${stale ? ' stale' : ''}`;
  fresh.textContent = stale
    ? `⚠ Gegevens van ${r.asOf} — dat is ${Math.floor(age / 24)} dagen oud, de laatste run is waarschijnlijk mislukt`
    : `Slotkoersen van ${r.asOf} (UTC) · berekend ${new Date(r.generatedAt).toLocaleString('nl-NL')}`;

  // The single most important line in the app: it decides both which base everything is
  // measured against and where the money goes when something has to be sold.
  const btc = document.getElementById('btc-line');
  btc.className = `btc-state ${r.btcInTrend ? 'up' : 'down'}`;
  btc.replaceChildren();
  btc.append(el('span', 'dot'), el('b', null, r.btcInTrend ? 'BTC boven zijn daily Kijun-sen' : 'BTC onder zijn daily Kijun-sen'));
  btc.append(
    el(
      'span',
      'why',
      r.btcInTrend
        ? 'Alles wordt gemeten tegen BTC · verkoop een altcoin naar BTC'
        : 'Alles wordt gemeten in dollars · verkoop een altcoin naar euro',
    ),
  );

  const p = r.params;
  document.getElementById('params').textContent =
    `Ichimoku ${p.tenkan}/${p.kijun}/${p.senkouB}, verschuiving ${p.displacement}−${p.extraBars}=${p.displacement - p.extraBars} bars, ` +
    `cloud ${p.cloudMode === 'displaced' ? 'traditioneel verschoven' : 'no-offset'} · Senkou A = (${p.senkouASource})` +
    (p.levels ? ` · retest-venster ${p.levels.retestWindowDays} dagen · nabij = binnen ${p.levels.approachPct}%` : '');

  const warn = state.report.universe.warnings ?? [];
  const box = document.getElementById('warnings-box');
  box.hidden = warn.length === 0;
  document.getElementById('warn-count').textContent = String(warn.length);
  const ul = document.getElementById('warnings');
  ul.replaceChildren(...warn.map((w) => el('li', null, w)));
}

function renderTable(coins, tab) {
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const sample = coins[0] ?? state.report.coins[0];
  const emaCols = sample ? setFor(sample).ema : [];
  const base = sample ? setFor(sample).base : 'usd';
  const showBucket = tab.id === 'owned' || tab.id === 'all' || tab.id === 'buy';

  const head = el('tr');
  const cols = ['', '#', 'Munt', `Koers ${unit(base)}`, 'Δ%', 'Kijun D', 'Kijun W', 'Cloud D', 'Cloud W'];
  for (const h of cols) head.append(el('th', h.startsWith('Koers') || h === 'Δ%' ? 'num' : null, h));
  for (const c of emaCols) head.append(el('th', null, `EMA${EMA_LABEL(c)}`));
  head.append(el('th', null, base === 'btc' ? 'ook in $' : 'ook vs BTC'));
  if (showBucket) head.append(el('th', null, 'Bakje'));
  if (tab.extra) head.append(el('th', 'num', tab.extra === 'kans' ? 'Kans' : 'Winst'));
  head.append(el('th', 'num', 'Score'));
  const thead = el('thead');
  thead.append(head);
  table.append(thead);

  const body = el('tbody');
  for (const coin of coins) {
    const m = setFor(coin);
    const tr = el('tr');
    if (!onPrimary(coin)) tr.classList.add('off-base');
    tr.append(td(starButton(coin, render)));
    tr.append(el('td', 'rank', String(coin.rank)));

    const sym = el('td', 'sym');
    sym.append(document.createTextNode(coin.symbol), el('span', 'name', coin.name));
    tr.append(sym);

    tr.append(el('td', 'num', price(m.close, m.base)));
    const chg = el('td', 'num');
    chg.append(
      coin.changePct === null
        ? el('span', 'na', '-')
        : el('span', coin.changePct >= 0 ? 'yes' : 'no', pct(coin.changePct, 1).replace('%', '')),
    );
    tr.append(chg);

    tr.append(td(kijunCell(m.kijun.daily)));
    tr.append(td(kijunCell(m.kijun.weekly)));
    tr.append(td(cloudCell(m.cloud.daily)));
    tr.append(td(cloudCell(m.cloud.weekly)));
    for (const cell of m.ema) tr.append(td(emaCell(cell)));
    tr.append(td(otherBaseCell(coin)));
    if (showBucket) tr.append(td(bucketBadge(coin)));
    if (tab.extra) tr.append(extraCell(tab.extra === 'kans' ? coin.opportunity.points : coin.takeProfit.points, tab.extra));
    tr.append(scoreCell(coin));

    tr.addEventListener('click', () => showDetail(coin));
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function renderCards(coins, tab) {
  const wrap = el('div', 'cards');
  for (const coin of coins) {
    const m = setFor(coin);
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    head.append(el('span', 'symbol', coin.symbol), el('span', 'name', coin.name), el('span', 'rank', `#${coin.rank}`));
    card.append(head);

    card.append(bucketBadge(coin));

    const p = el('div', 'card-price');
    p.append(
      document.createTextNode(`${unit(m.base)}${price(m.close, m.base)}  `),
      coin.changePct === null ? el('span', 'na', '') : el('span', coin.changePct >= 0 ? 'yes' : 'no', pct(coin.changePct, 1)),
    );
    card.append(p);

    const grid = el('div', 'card-grid');
    const row = (label, node) => {
      const d = el('div');
      d.append(el('span', null, label), node);
      grid.append(d);
    };
    row('Kijun D', kijunCell(m.kijun.daily));
    row('Kijun W', kijunCell(m.kijun.weekly));
    row('Cloud D', cloudCell(m.cloud.daily));
    row('Cloud W', cloudCell(m.cloud.weekly));
    for (const cell of m.ema) row(`EMA ${EMA_LABEL(cell)}`, emaCell(cell));
    row(m.base === 'btc' ? 'Ook in $' : 'Ook vs BTC', otherBaseCell(coin));
    card.append(grid);

    const foot = el('div', 'card-foot');
    foot.append(starButton(coin, render));
    if (tab.extra) {
      foot.append(el('span', `chip ${tab.extra}`, `${tab.extra === 'kans' ? 'kans' : 'winst'} ${(tab.extra === 'kans' ? coin.opportunity.points : coin.takeProfit.points).toFixed(0)}`));
    }
    const score = el('span', null, `score ${coin.score.points.toFixed(0)}/${coin.score.max.toFixed(0)}`);
    score.style.marginLeft = 'auto';
    score.style.fontFamily = 'var(--mono)';
    foot.append(score);
    card.append(foot);

    card.addEventListener('click', (e) => {
      if (!(e.target instanceof HTMLButtonElement)) showDetail(coin);
    });
    wrap.append(card);
  }
  return wrap;
}

/* ------------------------------------------------------------------ portfolio */

function lineChart(series, keys, colors) {
  const W = 760;
  const H = 260;
  const PAD = { l: 52, r: 12, t: 12, b: 24 };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');

  const values = series.flatMap((p) => keys.map((k) => p[k])).filter(Number.isFinite);
  if (values.length === 0) return svg;
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;

  const x = (i) => PAD.l + (series.length === 1 ? (W - PAD.l - PAD.r) / 2 : (i / (series.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);

  const mk = (tag, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };

  for (let g = 0; g <= 3; g++) {
    const v = min + ((max - min) * g) / 3;
    svg.append(mk('line', { x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v), stroke: 'currentColor', opacity: 0.12 }));
    const label = mk('text', { x: PAD.l - 8, y: y(v) + 4, 'text-anchor': 'end', fill: 'currentColor', opacity: 0.55, 'font-size': 11 });
    label.textContent = `€${Math.round(v).toLocaleString('nl-NL')}`;
    svg.append(label);
  }

  keys.forEach((key, ki) => {
    const pts = series.map((p, i) => [x(i), y(p[key])]).filter(([, yy]) => Number.isFinite(yy));
    if (pts.length === 1) {
      svg.append(mk('circle', { cx: pts[0][0], cy: pts[0][1], r: 4, fill: colors[ki] }));
      return;
    }
    svg.append(
      mk('path', {
        d: pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' '),
        fill: 'none',
        stroke: colors[ki],
        'stroke-width': 2,
        'stroke-linejoin': 'round',
      }),
    );
  });

  return svg;
}

function renderPortfolio() {
  const pf = state.report.portfolio;
  const wrap = el('div');
  if (!pf || pf.series.length === 0) {
    wrap.append(el('p', 'section-note', 'De simulatie is nog niet gestart. Zodra de eerste dag verwerkt is verschijnt hier de vergelijking.'));
    return wrap;
  }

  const last = pf.series[pf.series.length - 1];
  // Round before formatting, and collapse JavaScript's negative zero, or a difference of a
  // millionth of a cent renders as a red "+€ -0,00".
  const rawDiff = last.strategyEur - last.hodlEur;
  const diff = Math.abs(rawDiff) < 0.005 ? 0 : Math.round(rawDiff * 100) / 100;
  const days = pf.series.length;

  const stats = el('div', 'pf-grid');
  const stat = (label, value, sub, cls) => {
    const s = el('div', 'stat');
    s.append(el('div', 'label', label));
    s.append(el('div', `value${cls ? ` ${cls}` : ''}`, value));
    if (sub) s.append(el('div', 'sub', sub));
    stats.append(s);
  };
  const tone = (n) => (Math.abs(n) < 0.005 ? null : n > 0 ? 'yes' : 'no');
  stat('Strategie', eur(last.strategyEur), `${pct(pf.stats.strategy.returnPct)} sinds start`, tone(pf.stats.strategy.returnPct));
  stat('Alles kopen en vasthouden', eur(last.hodlEur), `${pct(pf.stats.hodl.returnPct)} sinds start`, tone(pf.stats.hodl.returnPct));
  stat('Verschil', `${diff > 0 ? '+' : ''}${eur(diff)}`, 'strategie min vasthouden', tone(diff));
  stat('Nu belegd', `${Math.round((1 - last.cashWeight) * 100)}%`, `${last.qualifyingCount} munten · ${Math.round(last.cashWeight * 100)}% stablecoin`);

  wrap.append(stats);

  const chart = el('div', 'chart');
  // With a single day there is no line to draw, and auto-scaling a flat series magnifies
  // rounding noise into a chart that appears to show a large gap. Say so instead.
  if (days >= 2) chart.append(lineChart(pf.series, ['hodlEur', 'strategyEur'], ['#8d97ad', '#4a9eff']));
  const legend = el('div', 'legend');
  const item = (color, text) => {
    const s = el('span');
    const i = el('i');
    i.style.background = color;
    s.append(i, document.createTextNode(text));
    return s;
  };
  if (days >= 2) legend.append(item('#4a9eff', 'Strategie'), item('#8d97ad', 'Alles kopen en vasthouden'));
  legend.append(
    el('span', null, `${days} ${days === 1 ? 'dag' : 'dagen'} sinds ${pf.config.startDate} · start ${eur(pf.config.startCapitalEur)} · ${(pf.config.feeRate * 100).toLocaleString('nl-NL', { minimumFractionDigits: 2 })}% kosten per transactie`),
  );
  chart.append(legend);
  wrap.append(chart);

  if (days === 1) {
    wrap.append(
      el(
        'p',
        'section-note',
        'Beide portefeuilles zijn vandaag gestart en staan dus nog exact gelijk — beide hebben eenmalig 0,15% transactiekosten betaald. ' +
          'De grafiek verschijnt zodra er een tweede dag is; het verschil ontstaat pas als de koersen bewegen en de strategie gaat afwijken van de markt.',
      ),
    );
  }

  const top = pf.holdings.strategy.slice(0, 12);
  if (top.length > 0) {
    const h = el('h3');
    h.textContent = 'Grootste posities in de strategie';
    h.style.fontSize = '13px';
    h.style.margin = '18px 0 8px';
    wrap.append(h);
    const list = el('div', 'cards');
    for (const p of top) {
      const c = el('div', 'card');
      const head = el('div', 'card-head');
      head.append(el('span', 'symbol', p.symbol), el('span', 'name', `${(p.weight * 100).toFixed(1)}%`));
      head.append(el('span', 'card-price', eur((p.valueUsd / last.strategyUsd) * last.strategyEur)));
      c.append(head);
      list.append(c);
    }
    list.style.display = 'grid';
    list.style.gridTemplateColumns = 'repeat(auto-fill, minmax(190px, 1fr))';
    wrap.append(list);
  }

  return wrap;
}

/* ------------------------------------------------------------------ detail */

/**
 * Dutch labels for the score breakdown.
 *
 * The JSON keeps stable English keys so old report files stay readable; only the display is
 * translated. An unknown key falls through unchanged rather than disappearing.
 */
const SCORE_LABELS = {
  'Kijun daily': 'Kijun-sen daily',
  'Kijun weekly': 'Kijun-sen weekly',
  confirmation: 'Bevestiging op de andere basis',
  'Cloud daily': 'Cloud daily',
  'Cloud weekly': 'Cloud weekly',
};
const scoreLabel = (key) => SCORE_LABELS[key] ?? key.replace(/^EMA(\d+) (daily|weekly|monthly)$/, (_, p, tf) => `EMA ${p} ${tf}`);

const dec2 = (n) => n.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The levels table: every line the coin is measured against, with the distance to it.
 *
 * `gapPct` is how far the CLOSE has to move to reach that level, so a negative number means
 * the level is already below the price (support, and how much room there is before it is
 * lost) and a positive one means it is overhead (resistance, and how far the rally has left).
 */
function levelsTable(m, live) {
  const t = el('table', 'levels');
  const head = el('tr');
  for (const h of ['Niveau', 'Waarde', 'Δ naar niveau', '']) head.append(el('th', h === 'Niveau' ? null : 'num', h));
  const thead = el('thead');
  thead.append(head);
  t.append(thead);

  const body = el('tbody');
  const rowFor = (label, value, gap, note, tone) => {
    const tr = el('tr');
    tr.append(el('td', null, label));
    tr.append(el('td', 'num', value === null || value === undefined ? '–' : `${unit(m.base)}${price(value, m.base)}`));
    const g = el('td', 'num');
    g.append(gap === null || gap === undefined ? el('span', 'na', '–') : el('span', gap > 0 ? 'no' : 'yes', pct(gap, 1)));
    tr.append(g);
    tr.append(td(note ? el('span', tone ?? 'touch', note) : null));
    body.append(tr);
  };

  // "Nu" first: the still-forming candle, measured against the same reference close, so the
  // whole table reads as one list of "how far is the price from X".
  if (live) rowFor('Nu (nog niet gesloten)', live.value, live.gap, 'live', 'prov');
  rowFor('Slotkoers (referentie)', m.close, 0, null);

  for (const l of m.levels) {
    let note = null;
    let tone = 'touch';
    if (l.retest) {
      note = l.retest.kind === 'retest' ? `retest ${l.retest.barsAgo}d` : `teruggepakt ${l.retest.barsAgo}d`;
      tone = 'yes';
    } else if (l.approaching) {
      note = 'dichtbij';
      tone = 'no';
    } else if (l.touchedByRef) {
      note = 'geraakt';
    }
    rowFor(l.label, l.value, l.gapPct, note, tone);
  }
  t.append(body);
  return t;
}

function extraBlock(extra, emptyText) {
  if (extra.contributions.length === 0) return el('p', 'section-note', emptyText);
  const bd = el('div', 'bd');
  for (const c of extra.contributions) {
    bd.append(el('span', null, c.label));
    bd.append(el('span', 'got yes', c.points.toFixed(1)));
    bd.append(el('span', 'of', c.detail));
  }
  return bd;
}

function showDetail(coin) {
  const m = setFor(coin);
  const dlg = document.getElementById('detail');
  document.getElementById('detail-title').textContent = `${coin.symbol} · ${coin.name}`;
  const body = document.getElementById('detail-body');
  body.replaceChildren();

  const section = (title, node) => {
    body.append(el('h3', null, title));
    body.append(node);
  };

  body.append(bucketBadge(coin));
  body.append(el('p', 'section-note', coin.bucketReason));

  // The live candle is priced in dollars only, so it joins the levels table only when the
  // dollar base is on screen; under the BTC base it gets its own line just below.
  const live = m.base === 'usd' && coin.live ? { value: coin.live.closeUsd, gap: coin.live.changePct } : null;
  section(
    m.base === 'btc' ? `Niveaus tegen BTC (${coin.symbol}/BTC, synthetisch berekend)` : 'Niveaus in dollars',
    levelsTable(m, live),
  );

  if (m.base === 'btc' && coin.live) {
    body.append(
      el('p', 'section-note', `Nu (nog niet gesloten, in dollars): $${money(coin.live.closeUsd)} · ${pct(coin.live.changePct, 2)} ten opzichte van de slotkoers.`),
    );
  }

  if (m.cloud.daily.boundaryTest) {
    const note =
      m.cloud.daily.boundaryTest === 'support'
        ? 'De candle raakte de cloud van bovenaf: een steuntest.'
        : m.cloud.daily.boundaryTest === 'resistance'
          ? 'De candle raakte de cloud van onderaf: een weerstandstest.'
          : 'De candle raakte een cloudrand van binnenuit.';
    section('Cloudcontact', el('p', 'section-note', note));
  }

  section(
    `Buitenkans ${coin.opportunity.points.toFixed(0)}`,
    extraBlock(coin.opportunity, 'Geen geslaagde test van een belangrijk niveau in het venster.'),
  );
  section(
    `Winst pakken ${coin.takeProfit.points.toFixed(0)}`,
    extraBlock(coin.takeProfit, 'Geen belangrijk niveau vlak boven de koers.'),
  );

  const otherSet = m.base === 'btc' ? coin.usd : coin.btcPair;
  const otherBox = el('div', 'kv');
  const bp = (k, v) => {
    const d = el('div');
    d.append(el('span', 'k', k), el('span', 'v', v));
    otherBox.append(d);
  };
  if (!otherSet) {
    bp('Andere basis', coin.symbol === 'BTC' ? 'n.v.t. — dit is BTC zelf' : 'onvoldoende overlappende data');
  } else {
    bp('Slotkoers', `${unit(otherSet.base)}${price(otherSet.close, otherSet.base)}`);
    bp('Kijun-sen daily', otherSet.kijun.daily.value === null ? '–' : `${unit(otherSet.base)}${price(otherSet.kijun.daily.value, otherSet.base)}`);
    bp('Boven de daily Kijun', otherSet.kijun.daily.verdict === 'above' ? 'ja' : otherSet.kijun.daily.verdict === 'unknown' ? 'onbekend' : 'nee');
    bp('Cloud daily', otherSet.cloud.daily.position);
  }
  section(m.base === 'btc' ? 'Ter controle: dezelfde munt in dollars' : 'Ter controle: dezelfde munt tegen BTC', otherBox);

  const bd = el('div', 'bd');
  for (const b of coin.score.breakdown) {
    bd.append(el('span', b.counted ? null : 'na', scoreLabel(b.label)));
    bd.append(el('span', `got ${b.counted && b.got > 0 ? 'yes' : b.counted ? 'no' : 'na'}`, b.counted ? dec2(b.got) : 'n.v.t.'));
    bd.append(el('span', 'of', `/ ${dec2(b.of)}`));
  }
  section(
    `Score ${coin.score.points.toFixed(0)} van ${coin.score.max.toFixed(0)} · gemeten ${coin.primaryBase === 'btc' ? 'tegen BTC' : 'in dollars'}` +
      (coin.score.unavailable > 0 ? ` · ${coin.score.unavailable.toFixed(0)} punten niet te beoordelen door te weinig historie` : ''),
    bd,
  );

  const dq = el('div', 'kv');
  const dqp = (k, v) => {
    const d = el('div');
    d.append(el('span', 'k', k), el('span', 'v', v));
    dq.append(d);
  };
  dqp('Dagen aan data', `${coin.dataQuality.dailyBars} d · ${coin.dataQuality.weeklyBars} w · ${coin.dataQuality.monthlyBars} m`);
  dqp('Dagen met een BTC-koppel', String(coin.dataQuality.btcPairBars));
  section('Databasis', dq);

  if (coin.dataQuality.notes.length > 0) {
    const ul = el('ul');
    for (const n of coin.dataQuality.notes) ul.append(el('li', null, n));
    ul.style.fontSize = '12.5px';
    ul.style.color = 'var(--muted)';
    section('Let op', ul);
  }

  dlg.showModal();
}

/* ------------------------------------------------------------------ legenda */

const LEGEND = [
  [
    'De basismetric: het muntpaar tegen BTC',
    'Elke munt wordt niet alleen in dollars doorgerekend, maar óók als koers ín bitcoin — het {munt}/BTC-paar. ' +
      'Dat paar stijgt alleen als de munt hárder stijgt dan bitcoin zelf. Op dat paar liggen dezelfde lijnen als op de dollarkoers: ' +
      'Kijun-sen, de cloud en de EMA’s. "Muntpaar tegen BTC boven zijn Kijun" betekent dus: de munt wint al een tijd terrein op bitcoin. ' +
      'Dat is de belangrijkste vraag, want bitcoin aanhouden is altijd het alternatief.',
  ],
  [
    'Waarom de basis soms omschakelt',
    'Staat BTC zelf boven zijn daily Kijun-sen, dan wordt alles tegen BTC gemeten: uitwijken naar bitcoin is dan een echt alternatief, ' +
      'dus een altcoin moet het verslaan. Zakt BTC onder zijn eigen Kijun, dan is een dalende bitcoin verslaan niets waard en telt alleen nog ' +
      'of de munt zich in dollars staande houdt. De regel bovenaan de app zegt welke van de twee nu geldt; met de knoppen eronder kun je altijd handmatig omschakelen.',
  ],
  [
    'Kijun-sen',
    'De basislijn van Ichimoku: het midden van de hoogste top en de laagste bodem over 35 bars. Erboven sluiten is de definitie van "in trend"; ' +
      'eronder zakken is het verkoopsignaal waar de hele app op draait.',
  ],
  [
    'De cloud',
    'Het vlak tussen Senkou A en Senkou B, 35 bars vooruit geprojecteerd. Boven de cloud is sterk, in de cloud is richtingloos, eronder is zwak. ' +
      'De bovenkant is de steun waar een terugval op stuit; de onderkant is de eerste weerstand als de koers van onderaf terugkomt.',
  ],
  ['Bakje: Buitenkans ◆', 'Boven de daily Kijun-sen én in de afgelopen dagen teruggekomen tot op een belangrijk niveau en er toch boven gesloten. Instapmoment.'],
  ['Bakje: Winst pakken ▲', 'Boven de daily Kijun-sen, maar vlak onder een belangrijk niveau dat van onderaf wordt benaderd. Daar stokt een stijging vaak.'],
  ['Bakje: Verkopen ▼', 'Onder de daily Kijun-sen. Naar BTC zolang bitcoin zelf boven zijn Kijun staat, anders naar euro.'],
  ['Bakje: Houden =', 'Boven de daily Kijun-sen, maar zonder verse test en zonder niveau in de buurt. Niets te doen.'],
  ['Score', 'Nul tot honderd, opgeteld uit de daily en weekly Kijun, beide clouds en de zes EMA-cellen op de basis die nu geldt, plus twintig punten bevestiging als de munt óók op de andere basis boven zijn daily Kijun staat. Cellen zonder genoeg historie tellen niet mee en gaan van het maximum af.'],
  ['Kansscore en winstscore', 'Nul tot honderd per stuk. De kansscore telt elk geslaagd getest niveau mee, zwaarder naarmate het niveau belangrijker is en de test verser. De winstscore doet hetzelfde met de niveaus die nog boven de koers liggen, zwaarder naarmate ze dichterbij zijn.'],
  ['Δ naar niveau', 'Hoeveel procent de koers moet bewegen om dat niveau te raken. Negatief betekent dat het niveau eronder ligt (steun); positief dat het erboven ligt (weerstand).'],
  ['Tekens', '✓ boven · ✗ onder · • de candle raakte de lijn · ↑ ↓ vandaag gekruist · ▲ boven de cloud, ≈ erin, ▼ eronder · ⌃ ⌄ cloudrand geraakt · ⋈ op een twist · ~ waarde nog niet uitgeconvergeerd · – te weinig historie.'],
];

function renderLegend() {
  const host = document.getElementById('legend-body');
  if (!host || host.childElementCount > 0) return;
  for (const [term, text] of LEGEND) {
    host.append(el('dt', null, term));
    host.append(el('dd', null, text));
  }
}

/* ------------------------------------------------------------------ meldingen */

const PUSH_TEXT = {
  none: ['off', 'Meldingen staan uit op dit apparaat.'],
  'not-pasted': ['todo', 'Je bent geabonneerd, maar de sleutel staat nog niet in GitHub — zonder die stap wordt er niets verstuurd.'],
  changed: ['todo', 'Je abonnement is vernieuwd door de browser. Zet de nieuwe sleutel in GitHub, anders komen er geen meldingen meer aan.'],
  gone: ['off', 'Het abonnement is verdwenen — meestal doordat de app van het beginscherm is gehaald of de sitegegevens zijn gewist.'],
  ok: ['ok', 'Meldingen staan aan en de sleutel is doorgegeven.'],
};

async function renderPush() {
  const panel = document.getElementById('push-panel');
  if (!panel) return;
  panel.replaceChildren();

  if (!pushSupported()) {
    panel.append(
      el('p', 'push-status off', 'Deze browser kan geen meldingen tonen.'),
      el('p', null, 'Op een iPhone moet je de app eerst via Deel → Zet op beginscherm installeren en daarna vanaf dat icoon openen. Op Android en Windows werkt het direct in Chrome of Edge.'),
    );
    return;
  }

  const drift = await subscriptionDrift();
  const [tone, message] = PUSH_TEXT[drift] ?? PUSH_TEXT.none;
  panel.append(el('p', `push-status ${tone}`, message));

  const showKey = async () => {
    const sub = await currentSubscription();
    if (!sub) return;
    const json = JSON.stringify(sub.toJSON());

    const steps = el('ol');
    for (const step of [
      'Kopieer de sleutel hieronder.',
      'Ga in GitHub naar Settings → Secrets and variables → Actions.',
      'Maak of bewerk de secret PUSH_SUBSCRIPTION_PHONE (of ...LAPTOP) en plak hem daar.',
    ]) steps.append(el('li', null, step));
    panel.append(steps);

    const ta = el('textarea');
    ta.readOnly = true;
    ta.value = json;
    ta.addEventListener('focus', () => ta.select());
    panel.append(ta);

    const copy = el('button', null, 'Kopieer sleutel');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(json);
        copy.textContent = 'Gekopieerd ✓';
      } catch {
        ta.select();
        copy.textContent = 'Selecteer en kopieer handmatig';
      }
    });

    const done = el('button', 'secondary', 'Ik heb hem in GitHub gezet');
    done.addEventListener('click', () => {
      markPasted(json);
      renderPush();
    });

    const row = el('p');
    row.append(copy, document.createTextNode(' '), done);
    panel.append(row);
  };

  if (drift === 'ok') {
    const again = el('button', 'secondary', 'Sleutel opnieuw tonen');
    again.addEventListener('click', () => {
      again.remove();
      showKey();
    });
    const off = el('button', 'secondary', 'Meldingen uitzetten');
    off.addEventListener('click', async () => {
      await unsubscribe();
      renderPush();
    });
    const row = el('p');
    row.append(again, document.createTextNode(' '), off);
    panel.append(row);
    return;
  }

  if (drift === 'not-pasted' || drift === 'changed') {
    await showKey();
    return;
  }

  const btn = el('button', null, 'Meldingen aanzetten');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      // requestPermission has to happen inside this click, not on page load.
      await enablePush();
      await renderPush();
    } catch (err) {
      btn.disabled = false;
      panel.append(el('p', 'push-err', err.message ?? String(err)));
    }
  });
  panel.append(btn);
  panel.append(el('p', null, 'Je krijgt dan elke ochtend een korte samenvatting met een link naar dit overzicht.'));
}

/* ------------------------------------------------------------------ main */

function render() {
  if (!state.report) return;
  renderHeader();
  renderTabs();
  renderBaseSwitch();
  renderLegend();

  const main = document.getElementById('main');
  main.replaceChildren();

  const tab = TABS.find((t) => t.id === state.tab) ?? TABS[0];

  if (tab.id === 'portfolio') {
    main.append(renderPortfolio());
    return;
  }

  const coins = coinsFor(tab.id);
  if (tab.note) main.append(el('p', 'section-note', tab.note));

  if (tab.id === 'verkopen' && coins.length > 0) {
    main.append(
      el(
        'p',
        'section-note strong',
        state.report.btcInTrend
          ? 'BTC staat boven zijn Kijun-sen: verkoop deze munten naar BTC, niet naar euro.'
          : 'BTC staat onder zijn Kijun-sen: er is geen veilige haven in bitcoin, verkoop naar euro.',
      ),
    );
  }

  if (coins.length === 0) {
    const msg =
      tab.id === 'owned'
        ? 'Nog geen posities gemarkeerd. Tik op de ster bij een munt om hem hier te laten verschijnen.'
        : 'Geen munten in deze categorie vandaag.';
    main.append(el('div', 'empty', msg));
    return;
  }

  main.append(renderTable(coins, tab), renderCards(coins, tab));

  if (tab.id === 'owned') {
    const p = el('p', 'section-note');
    p.textContent = `Voor de meldingen: zet dit in config/holdings.json → {"owned": ${JSON.stringify([...state.holdings])}}`;
    p.style.marginTop = '12px';
    main.append(p);
  }
}

async function load() {
  // Cache-bust so a phone that kept the page open still gets today's file.
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`kon de gegevens niet laden (HTTP ${res.status})`);
  state.report = await res.json();
  render();
}

document.getElementById('detail-close').addEventListener('click', () => document.getElementById('detail').close());
document.getElementById('refresh').addEventListener('click', () => {
  load().catch(showError);
});

function showError(err) {
  document.getElementById('freshness').textContent = String(err.message ?? err);
  document.getElementById('main').replaceChildren(
    el('div', 'empty', 'De gegevens konden niet geladen worden. Controleer je verbinding en probeer opnieuw.'),
  );
}

state.holdings = loadHoldings();
try {
  const savedTab = localStorage.getItem(TAB_KEY);
  if (savedTab && TABS.some((t) => t.id === savedTab)) state.tab = savedTab;
  const savedBase = localStorage.getItem(BASE_KEY);
  if (savedBase && BASE_CHOICES.some(([id]) => id === savedBase)) state.base = savedBase;
} catch {
  /* ignore */
}

load().catch(showError);
renderPush().catch(() => {
  /* the panel is a convenience; never let it break the report */
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
    /* offline support is a bonus, never a requirement */
  });
}
