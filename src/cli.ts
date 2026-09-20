import { runDaily } from './pipeline.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? 'true') : undefined;
};

const limit = flag('limit');
const which = flag('report') ?? 'daily';
const periods =
  which === 'all' ? (['weekly', 'monthly'] as const) : which === 'daily' ? ([] as const) : ([which] as const);

const report = await runDaily({
  ...(limit ? { limit: Number(limit) } : {}),
  periods: [...periods] as ('weekly' | 'monthly')[],
  skipPortfolio: args.includes('--no-portfolio'),
  write: !args.includes('--dry-run'),
});

const s = report.sections;
console.log(`\nas of ${report.asOf} UTC  ·  BTC ${report.btcInTrend ? 'ABOVE' : 'BELOW'} its daily Kijun`);
console.log(`${report.coins.length} coins analysed in ${Object.entries(report.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(', ')}`);
console.log(`\n  buy candidates   ${s.buyCandidates.length}`);
console.log(`  prefer BTC       ${s.preferBtc.length}`);
console.log(`  dropped out      ${s.droppedOut.length}`);
console.log(`  owned            ${s.owned.length}`);

console.log('\ntop 12 by score:');
console.table(
  report.coins.slice(0, 12).map((c) => ({
    '#': c.rank,
    coin: c.symbol,
    close: c.closeUsd,
    'chg%': c.changePct === null ? '-' : c.changePct.toFixed(1),
    KijD: c.kijun.daily.verdict === 'above' ? 'Y' : c.kijun.daily.verdict === 'unknown' ? '?' : 'n',
    KijW: c.kijun.weekly.verdict === 'above' ? 'Y' : c.kijun.weekly.verdict === 'unknown' ? '?' : 'n',
    cloudD: c.cloud.daily.position,
    cloudW: c.cloud.weekly.position,
    ema: c.ema.map((e) => (e.state !== 'ok' ? '.' : e.verdict === 'above' ? 'Y' : 'n')).join(''),
    'vsBTC': c.btc.coinBtcInTrend === null ? '?' : c.btc.coinBtcInTrend ? 'Y' : c.btc.preferBtc ? 'PREFER BTC' : 'n',
    score: `${c.score.points.toFixed(0)}/${c.score.max.toFixed(0)}`,
  })),
);
console.log(`ema column order: ${report.coins[0]?.ema.map((e) => `${e.period}${e.timeframe[0]}`).join(' ') ?? '-'}`);

if (report.universe.warnings.length > 0) {
  console.log('\nwarnings:');
  for (const w of report.universe.warnings) console.log(`  ! ${w}`);
}
for (const [tf, r] of Object.entries(report.periodic)) {
  console.log(`
=== ${tf} report, period ending ${r.periodEnd} (previous: ${r.previousPeriodEnd ?? 'n/a'}) ===`);
  console.log(`  in trend: ${r.inTrend.length}   not in trend: ${r.notInTrend.length}`);
  if (r.changes.length === 0) console.log('  no changes versus the previous period');
  for (const ch of r.changes) console.log(`  ${ch.symbol.padEnd(6)} ${ch.what}`);
}

if (report.portfolio) {
  const last = report.portfolio.series.at(-1)!;
  console.log(`\nportfolio (${report.portfolio.series.length} day(s) since ${report.portfolio.config.startDate}):`);
  console.log(`  hodl      EUR ${last.hodlEur.toFixed(2)}`);
  console.log(`  strategy  EUR ${last.strategyEur.toFixed(2)}  (${(last.cashWeight * 100).toFixed(0)}% cash, ${last.qualifyingCount} coins)`);
}
