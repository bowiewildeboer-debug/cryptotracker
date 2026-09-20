/**
 * Live end-to-end check of the universe builder.
 *
 *   npx tsx scripts/verify-universe.ts
 *
 * Prints the coins that survive the filters, every exclusion with its reason, and - most
 * importantly - any ticker collision the price check caught. Run this whenever the top 100
 * churns, to see what changed and why.
 */
import { readFileSync } from 'node:fs';
import { buildUniverse } from '../src/data/universe.ts';
import { hasApiKey } from '../src/data/coingecko.ts';

const params = JSON.parse(readFileSync('config/params.json', 'utf8'));
const exclusions = JSON.parse(readFileSync('config/exclusions.json', 'utf8'));
const overrides = JSON.parse(readFileSync('config/symbol-map.json', 'utf8'));

console.log(`CoinGecko API key: ${hasApiKey() ? 'set' : 'NOT set (keyless, shared IP pool)'}`);
console.log(`fetching ${params.universe.fetchSize} coins, targeting ${params.universe.targetSize}\n`);

const t0 = Date.now();
const u = await buildUniverse({
  fetchSize: params.universe.fetchSize,
  targetSize: params.universe.targetSize,
  exclusions: { deny: exclusions.deny ?? [], allow: exclusions.allow ?? [] },
  overrides: Object.fromEntries(
    Object.entries(overrides.map ?? {}).map(([id, v]) => [id, (v as { manualOverride?: string }).manualOverride]).filter(([, v]) => Boolean(v)),
  ) as Record<string, string>,
});

console.log(`=== ${u.coins.length} coins in the universe (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
const rows = u.coins.map((c) => ({
  rank: c.rank,
  symbol: c.symbol,
  name: c.name.slice(0, 22),
  binance: c.binanceSymbol,
  mcapBn: +(c.marketCapUsd / 1e9).toFixed(2),
  via: c.resolution,
}));
console.table(rows.slice(0, 15));
console.log(`... and ${Math.max(0, rows.length - 15)} more`);

console.log(`\n=== ${u.excluded.length} excluded ===`);
const byReason = new Map<string, string[]>();
for (const e of u.excluded) {
  const key = e.reason.replace(/\(.*\)/, '(...)');
  if (!byReason.has(key)) byReason.set(key, []);
  byReason.get(key)!.push(e.symbol.toUpperCase());
}
for (const [reason, symbols] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(symbols.length).padStart(3)}x  ${reason}`);
  console.log(`        ${symbols.slice(0, 18).join(' ')}${symbols.length > 18 ? ' ...' : ''}`);
}

console.log(`\n=== ${u.warnings.length} warnings ===`);
for (const w of u.warnings) console.log(`  ! ${w}`);

const resolvedVia = u.coins.filter((c) => c.resolution !== 'ticker-price-verified');
if (resolvedVia.length > 0) {
  console.log('\n=== mappings that needed more than a ticker match ===');
  for (const c of resolvedVia) console.log(`  ${c.symbol} -> ${c.binanceSymbol} (${c.resolution})`);
}

console.log(`\ntop 10 by market cap: ${u.coins.slice(0, 10).map((c) => c.symbol).join(' ')}`);
