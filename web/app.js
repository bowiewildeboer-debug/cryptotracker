/**
 * Cryptotracker - static front end.
 *
 * No framework and no build step: the whole app is three files that GitHub Pages can serve
 * as-is, which keeps deployment to "copy the folder". It reads one JSON file produced by the
 * nightly job and renders it.
 *
 * Holdings live in localStorage, not in the repo. The repo is public (that is what makes
 * Pages free), and which coins you own is nobody else's business. Everything the app needs
 * to highlight them it can do client-side; `config/holdings.json` exists only so the push
 * notification can mention them, and the app offers the JSON to paste there.
 */

const DATA_URL = './data/latest.json';
const HOLDINGS_KEY = 'cryptotracker.holdings.v1';
const TAB_KEY = 'cryptotracker.tab.v1';

const state = {
  report: null,
  tab: 'buy',
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

/* ------------------------------------------------------------------ cells */

function kijunCell(cell) {
  const span = el('span');
  if (cell.verdict === 'unknown') {
    span.append(el('span', 'na', '–'));
    return span;
  }
  span.append(el('span', cell.verdict === 'above' ? 'yes' : 'no', cell.verdict === 'above' ? '✓' : '✗'));
  // A candle can be above the line AND have touched it: the wick-down support test.
  if (cell.touchedByDaily) span.append(el('span', 'touch', ' •'));
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
  if (cell.touchedByDaily) span.append(el('span', 'touch', ' •'));
  return span;
}

function btcCell(coin) {
  const b = coin.btc;
  if (b.coinBtcInTrend === null) return el('span', 'na', '–');
  if (b.preferBtc) return el('span', 'pill warnp', 'liever BTC');
  return el('span', 'pill ok', 'verslaat BTC');
}

function scoreCell(coin) {
  const wrap = el('td', 'num score-bar');
  const pct = coin.score.max > 0 ? (coin.score.points / coin.score.max) * 100 : 0;
  const fill = el('div', 'fill');
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  wrap.append(fill, el('span', null, `${coin.score.points.toFixed(0)}/${coin.score.max.toFixed(0)}`));
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
  { id: 'buy', label: 'Koopkandidaten', note: 'Boven de daily Kijun-sen, en het muntpaar tegen BTC staat ook boven zijn Kijun.' },
  { id: 'preferBtc', label: 'Liever BTC', note: 'In trend, maar het {munt}/BTC-paar staat onder zijn Kijun terwijl BTC zelf erboven staat.' },
  { id: 'dropped', label: 'Uitgevallen', note: 'Gisteren nog boven de daily Kijun-sen, vandaag niet meer.' },
  { id: 'owned', label: 'Mijn posities', note: 'Munten die je met de ster hebt gemarkeerd. Dit blijft op dit apparaat.' },
  { id: 'portfolio', label: 'Portefeuille', note: '' },
  { id: 'all', label: 'Alles', note: 'De volledige lijst, gesorteerd op score.' },
];

function coinsFor(tab) {
  const all = state.report?.coins ?? [];
  switch (tab) {
    case 'buy':
      return all.filter((c) => c.inTrend && !c.droppedOutToday && c.btc.preferBtc !== true && !isOwned(c));
    case 'preferBtc':
      return all.filter((c) => c.inTrend && !c.droppedOutToday && c.btc.preferBtc === true && !isOwned(c));
    case 'dropped':
      return all.filter((c) => c.droppedOutToday);
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

  const btc = document.getElementById('btc-line');
  btc.replaceChildren();
  if (r.btcInTrend) {
    btc.append(document.createTextNode('BTC staat '), el('b', null, 'boven'), document.createTextNode(' zijn daily Kijun-sen — het BTC-filter is actief.'));
  } else {
    btc.append(
      document.createTextNode('BTC staat '),
      el('b', null, 'onder'),
      document.createTextNode(' zijn daily Kijun-sen — uitwijken naar BTC is nu geen veilige haven, dus het filter staat uit.'),
    );
  }

  const p = r.params;
  document.getElementById('params').textContent =
    `Ichimoku ${p.tenkan}/${p.kijun}/${p.senkouB}, verschuiving ${p.displacement}−${p.extraBars}=${p.displacement - p.extraBars} bars, ` +
    `cloud ${p.cloudMode === 'displaced' ? 'traditioneel verschoven' : 'no-offset'} · Senkou A = (${p.senkouASource})`;

  const warn = state.report.universe.warnings ?? [];
  const box = document.getElementById('warnings-box');
  box.hidden = warn.length === 0;
  document.getElementById('warn-count').textContent = String(warn.length);
  const ul = document.getElementById('warnings');
  ul.replaceChildren(...warn.map((w) => el('li', null, w)));
}

function renderTable(coins) {
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const emaCols = coins[0]?.ema ?? state.report.coins[0]?.ema ?? [];

  const head = el('tr');
  for (const h of ['', '#', 'Munt', 'Prijs', 'Δ%', 'Kijun D', 'Kijun W', 'Cloud D', 'Cloud W']) {
    head.append(el('th', h === 'Prijs' || h === 'Δ%' ? 'num' : null, h));
  }
  for (const c of emaCols) head.append(el('th', null, `EMA${EMA_LABEL(c)}`));
  head.append(el('th', null, 'vs BTC'), el('th', 'num', 'Score'));
  const thead = el('thead');
  thead.append(head);
  table.append(thead);

  const body = el('tbody');
  for (const coin of coins) {
    const tr = el('tr');
    tr.append(td(starButton(coin, render)));
    tr.append(el('td', 'rank', String(coin.rank)));

    const sym = el('td', 'sym');
    sym.append(document.createTextNode(coin.symbol), el('span', 'name', coin.name));
    tr.append(sym);

    tr.append(el('td', 'num', money(coin.closeUsd)));
    const chg = el('td', 'num');
    chg.append(
      coin.changePct === null
        ? el('span', 'na', '-')
        : el('span', coin.changePct >= 0 ? 'yes' : 'no', pct(coin.changePct, 1).replace('%', '')),
    );
    tr.append(chg);

    tr.append(td(kijunCell(coin.kijun.daily)));
    tr.append(td(kijunCell(coin.kijun.weekly)));
    tr.append(td(cloudCell(coin.cloud.daily)));
    tr.append(td(cloudCell(coin.cloud.weekly)));
    for (const cell of coin.ema) tr.append(td(emaCell(cell)));
    tr.append(td(btcCell(coin)));
    tr.append(scoreCell(coin));

    tr.addEventListener('click', () => showDetail(coin));
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function renderCards(coins) {
  const wrap = el('div', 'cards');
  for (const coin of coins) {
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    head.append(el('span', 'symbol', coin.symbol), el('span', 'name', coin.name), el('span', 'rank', `#${coin.rank}`));
    card.append(head);

    const price = el('div', 'card-price');
    price.append(
      document.createTextNode(`$${money(coin.closeUsd)}  `),
      coin.changePct === null
        ? el('span', 'na', '')
        : el('span', coin.changePct >= 0 ? 'yes' : 'no', pct(coin.changePct, 1)),
    );
    card.append(price);

    const grid = el('div', 'card-grid');
    const row = (label, node) => {
      const d = el('div');
      d.append(el('span', null, label), node);
      grid.append(d);
    };
    row('Kijun D', kijunCell(coin.kijun.daily));
    row('Kijun W', kijunCell(coin.kijun.weekly));
    row('Cloud D', cloudCell(coin.cloud.daily));
    row('Cloud W', cloudCell(coin.cloud.weekly));
    for (const cell of coin.ema) row(`EMA ${EMA_LABEL(cell)}`, emaCell(cell));
    card.append(grid);

    const foot = el('div', 'card-foot');
    foot.append(starButton(coin, render), btcCell(coin));
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
  'coin/BTC above Kijun': 'Muntpaar tegen BTC boven zijn Kijun',
  'Cloud daily': 'Cloud daily',
  'Cloud weekly': 'Cloud weekly',
};
const scoreLabel = (key) => SCORE_LABELS[key] ?? key.replace(/^EMA(d+) (daily|weekly|monthly)$/, (_, p, tf) =>
  `EMA ${p} ${tf === 'daily' ? 'daily' : tf === 'weekly' ? 'weekly' : 'monthly'}`);

const dec2 = (n) => n.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function showDetail(coin) {
  const dlg = document.getElementById('detail');
  document.getElementById('detail-title').textContent = `${coin.symbol} · ${coin.name}`;
  const body = document.getElementById('detail-body');
  body.replaceChildren();

  const section = (title, node) => {
    body.append(el('h3', null, title));
    body.append(node);
  };

  const kv = el('div', 'kv');
  const pair = (k, v) => {
    const d = el('div');
    d.append(el('span', 'k', k), el('span', 'v', v));
    kv.append(d);
  };
  pair('Slotkoers', `$${money(coin.closeUsd)}`);
  if (coin.live) pair('Nu (nog niet gesloten)', `$${money(coin.live.closeUsd)}`);
  pair('Kijun-sen daily', coin.kijun.daily.value === null ? '–' : `$${money(coin.kijun.daily.value)}`);
  pair('Kijun-sen weekly', coin.kijun.weekly.value === null ? '–' : `$${money(coin.kijun.weekly.value)}`);
  pair('Cloud daily', coin.cloud.daily.top === null ? '–' : `$${money(coin.cloud.daily.bottom)} – $${money(coin.cloud.daily.top)}`);
  pair('Cloud weekly', coin.cloud.weekly.top === null ? '–' : `$${money(coin.cloud.weekly.bottom)} – $${money(coin.cloud.weekly.top)}`);
  pair('Auxiliary (55)', coin.kijunAux === null ? '–' : `$${money(coin.kijunAux)}`);
  pair('Dagen aan data', `${coin.dataQuality.dailyBars} d · ${coin.dataQuality.weeklyBars} w · ${coin.dataQuality.monthlyBars} m`);
  section('Niveaus', kv);

  if (coin.cloud.daily.boundaryTest) {
    const note =
      coin.cloud.daily.boundaryTest === 'support'
        ? 'De candle raakte de cloud van bovenaf: een steuntest.'
        : coin.cloud.daily.boundaryTest === 'resistance'
          ? 'De candle raakte de cloud van onderaf: een weerstandstest.'
          : 'De candle raakte een cloudrand van binnenuit.';
    section('Cloudcontact', el('p', 'section-note', note));
  }

  const btcBox = el('div', 'kv');
  const bp = (k, v) => {
    const d = el('div');
    d.append(el('span', 'k', k), el('span', 'v', v));
    btcBox.append(d);
  };
  if (coin.btc.coinBtcInTrend === null) {
    bp('Tegen BTC', coin.symbol === 'BTC' ? 'n.v.t. — dit is BTC zelf' : 'onvoldoende data');
  } else {
    bp(`${coin.symbol}/BTC`, money(coin.btc.close, 8));
    bp('Kijun van dat paar', money(coin.btc.kijun, 8));
    bp('Verslaat BTC', coin.btc.coinBtcInTrend ? 'ja' : 'nee');
    bp('Advies', coin.btc.preferBtc ? 'liever BTC aanhouden' : 'de munt zelf mag');
  }
  section('Tegenover BTC (synthetisch berekend)', btcBox);

  const bd = el('div', 'bd');
  for (const b of coin.score.breakdown) {
    bd.append(el('span', b.counted ? null : 'na', scoreLabel(b.label)));
    bd.append(el('span', `got ${b.counted && b.got > 0 ? 'yes' : b.counted ? 'no' : 'na'}`, b.counted ? dec2(b.got) : 'n.v.t.'));
    bd.append(el('span', 'of', `/ ${dec2(b.of)}`));
  }
  section(`Score ${coin.score.points.toFixed(0)} van ${coin.score.max.toFixed(0)}${coin.score.unavailable > 0 ? ` · ${coin.score.unavailable.toFixed(0)} punten niet te beoordelen door te weinig historie` : ''}`, bd);

  if (coin.dataQuality.notes.length > 0) {
    const ul = el('ul');
    for (const n of coin.dataQuality.notes) ul.append(el('li', null, n));
    ul.style.fontSize = '12.5px';
    ul.style.color = 'var(--muted)';
    section('Let op', ul);
  }

  dlg.showModal();
}

/* ------------------------------------------------------------------ main */

function render() {
  if (!state.report) return;
  renderHeader();
  renderTabs();

  const main = document.getElementById('main');
  main.replaceChildren();

  const tab = TABS.find((t) => t.id === state.tab) ?? TABS[0];

  if (tab.id === 'portfolio') {
    main.append(renderPortfolio());
    return;
  }

  const coins = coinsFor(tab.id);
  if (tab.note) main.append(el('p', 'section-note', tab.note));

  if (coins.length === 0) {
    const msg =
      tab.id === 'owned'
        ? 'Nog geen posities gemarkeerd. Tik op de ster bij een munt om hem hier te laten verschijnen.'
        : 'Geen munten in deze categorie vandaag.';
    main.append(el('div', 'empty', msg));
    return;
  }

  main.append(renderTable(coins), renderCards(coins));

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
  const saved = localStorage.getItem(TAB_KEY);
  if (saved && TABS.some((t) => t.id === saved)) state.tab = saved;
} catch {
  /* ignore */
}

load().catch(showError);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
    /* offline support is a bonus, never a requirement */
  });
}
