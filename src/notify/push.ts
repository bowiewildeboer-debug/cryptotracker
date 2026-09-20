import webpush from 'web-push';
import type { Report } from '../pipeline.ts';

/**
 * Sends the daily summary as a Web Push notification.
 *
 * The notification carries a headline and a link, never the table. Two reasons: the encrypted
 * payload has a hard ceiling of 3993 bytes, and a table is unreadable in a notification anyway.
 * The app is where the numbers live.
 */

export interface PushResult {
  sent: string[];
  /** Subscriptions the push service rejected as gone (404/410). These need re-pairing. */
  dead: string[];
  failed: { name: string; status?: number; error: string }[];
  skipped: string;
  payloadBytes: number;
}

/** Push services reject anything larger; stay well under and fail loudly rather than silently. */
const MAX_PAYLOAD_BYTES = 3000;

/**
 * Which extra report became available today.
 *
 * The job builds all three every night, but only says so on the day a new one actually
 * closed - otherwise "weekrapport staat klaar" would appear every single morning and stop
 * meaning anything.
 */
export function periodNote(asOf: string): string {
  const d = new Date(`${asOf}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  // asOf is the last CLOSED day, so a Sunday close completes the week and a month-end close
  // completes the month.
  const isMonthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() === d.getUTCDate();
  if (isMonthEnd) return 'Maandrapport staat klaar';
  if (d.getUTCDay() === 0) return 'Weekrapport staat klaar';
  return '';
}

export function buildPayload(report: Report, appUrl: string): string {
  const s = report.sections;
  const top = report.coins
    .filter((c) => c.inTrend && c.btc.preferBtc !== true)
    .slice(0, 3)
    .map((c) => c.symbol)
    .join(', ');

  const parts = [`${s.buyCandidates.length} koopkandidaten`];
  if (s.droppedOut.length > 0) parts.push(`${s.droppedOut.length} uitgevallen`);
  if (s.preferBtc.length > 0) parts.push(`${s.preferBtc.length}x liever BTC`);
  if (!report.btcInTrend) parts.push('BTC onder zijn Kijun');
  const note = periodNote(report.asOf);
  if (note) parts.push(note);

  return JSON.stringify({
    // Safari 18.4+ renders this declaratively; every other platform goes through the SW.
    web_push: 8030,
    notification: {
      title: `Crypto ${report.asOf}: ${parts[0]}`,
      body: `${parts.slice(1).join(' · ') || 'geen wijzigingen'}${top ? `\nSterkst: ${top}` : ''}`,
      navigate: appUrl,
      tag: 'daily-report',
      app_badge: String(s.buyCandidates.length),
    },
  });
}

/** Every `PUSH_SUBSCRIPTION_*` environment variable, so adding a device is one new secret. */
function collectSubscriptions(env: NodeJS.ProcessEnv): [string, webpush.PushSubscription][] {
  const out: [string, webpush.PushSubscription][] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('PUSH_SUBSCRIPTION_') || !value || value.trim() === '') continue;
    try {
      const parsed = JSON.parse(value) as webpush.PushSubscription;
      if (parsed?.endpoint) out.push([key, parsed]);
    } catch {
      out.push([key, null as unknown as webpush.PushSubscription]);
    }
  }
  return out.filter(([, sub]) => Boolean(sub));
}

export async function sendDailyPush(report: Report, env: NodeJS.ProcessEnv = process.env): Promise<PushResult> {
  const result: PushResult = { sent: [], dead: [], failed: [], skipped: '', payloadBytes: 0 };

  const publicKey = env['VAPID_PUBLIC_KEY'];
  const privateKey = env['VAPID_PRIVATE_KEY'];
  const subject = env['VAPID_SUBJECT'] ?? 'mailto:noreply@example.com';
  const appUrl = env['APP_URL'] ?? './';

  if (!publicKey || !privateKey) {
    result.skipped = 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set';
    return result;
  }

  const subs = collectSubscriptions(env);
  if (subs.length === 0) {
    result.skipped = 'no PUSH_SUBSCRIPTION_* secrets are set - enable notifications in the app and paste the key';
    return result;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);

  const payload = buildPayload(report, appUrl);
  result.payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (result.payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`push payload is ${result.payloadBytes} bytes, over the ${MAX_PAYLOAD_BYTES} budget`);
  }

  for (const [name, sub] of subs) {
    try {
      await webpush.sendNotification(sub, payload, {
        // Hold for a day so a laptop that was asleep still receives it on waking.
        TTL: 86_400,
        urgency: 'normal',
        // Collapses an undelivered previous daily report instead of stacking two.
        topic: 'daily',
      });
      result.sent.push(name);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // 404 and 410 both mean the subscription is gone for good; anything else may be transient.
      if (status === 404 || status === 410) result.dead.push(name);
      else result.failed.push({ name, ...(status === undefined ? {} : { status }), error: String(err) });
    }
  }

  return result;
}
