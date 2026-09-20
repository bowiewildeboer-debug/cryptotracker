/**
 * Sends the daily push from an already-generated report.
 *
 *   npx tsx scripts/send-push.ts
 *
 * Deliberately separate from the pipeline: the workflow builds the report once and then sends
 * it, rather than paying for a second full data fetch just to notify.
 *
 * Exits 0 even when nothing could be sent. A missing subscription or a dead endpoint is worth
 * an alarm, not a red build - the report itself is fine and already published.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadEnv } from '../src/config.ts';
import { sendDailyPush } from '../src/notify/push.ts';
import type { Report } from '../src/pipeline.ts';

loadEnv();

const REPORT_PATH = 'data/latest.json';
if (!existsSync(REPORT_PATH)) {
  console.error(`${REPORT_PATH} does not exist - run the pipeline first`);
  process.exit(1);
}

/** On GitHub Pages the app URL is derivable, so it does not need to be configured by hand. */
function defaultAppUrl(): string {
  const repo = process.env['GITHUB_REPOSITORY'];
  if (!repo) return './';
  const [owner, name] = repo.split('/');
  return `https://${owner}.github.io/${name}/`;
}

const env = { ...process.env, APP_URL: process.env['APP_URL'] || defaultAppUrl() };
const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as Report;

const result = await sendDailyPush(report, env);

if (result.skipped) {
  console.log(`push skipped: ${result.skipped}`);
} else {
  console.log(`push: ${result.sent.length} sent, ${result.payloadBytes} bytes, link ${env.APP_URL}`);
  for (const f of result.failed) console.warn(`  ! ${f.name} failed (${f.status ?? '?'}): ${f.error}`);
  if (result.dead.length > 0) {
    console.warn(`  ! expired subscriptions: ${result.dead.join(', ')}`);
    writeFileSync('dead-subs.txt', result.dead.join('\n'));
  }
}
