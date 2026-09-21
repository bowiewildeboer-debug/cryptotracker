import { describe, it, expect } from 'vitest';
import { buildPayload, sendDailyPush } from '../src/notify/push.ts';
import type { Report } from '../src/pipeline.ts';

function report(over: Partial<Report> = {}): Report {
  return {
    generatedAt: '2026-09-21T01:17:00.000Z',
    asOf: '2026-09-20',
    params: {} as Report['params'],
    btcInTrend: true,
    coins: [],
    sections: { buitenkans: [], winstPakken: [], verkopen: [], houden: [], buyCandidates: [], owned: [] },
    universe: { size: 100, excluded: [], warnings: [] },
    portfolio: null,
    periodic: {},
    timings: {},
    ...over,
  };
}

const coin = (symbol: string, over: Record<string, unknown> = {}) =>
  ({ symbol, inTrend: true, bucket: 'buitenkans', ...over }) as unknown as Report['coins'][number];

describe('buildPayload', () => {
  it('carries a headline and a link, never the table', () => {
    const p = JSON.parse(
      buildPayload(
        report({
          sections: { buitenkans: ['A', 'B'], winstPakken: ['C'], verkopen: ['D'], houden: [], buyCandidates: ['A', 'B'], owned: [] },
          coins: [coin('AAA'), coin('BBB'), coin('CCC'), coin('DDD')],
        }),
        'https://example.test/tracker/',
      ),
    );
    expect(p.notification.title).toContain('2026-09-20');
    expect(p.notification.title).toContain('2 buitenkans');
    expect(p.notification.body).toContain('1 verkopen');
    expect(p.notification.body).toContain('1x winst pakken');
    expect(p.notification.navigate).toBe('https://example.test/tracker/');
    // At most three names, so the body cannot grow with the market.
    expect(p.notification.body).toContain('AAA, BBB, CCC');
    expect(p.notification.body).not.toContain('DDD');
  });

  it('includes the Safari declarative marker so one payload serves every platform', () => {
    expect(JSON.parse(buildPayload(report(), './')).web_push).toBe(8030);
  });

  it('always says where the proceeds of a sale should go', () => {
    expect(JSON.parse(buildPayload(report({ btcInTrend: false }), './')).notification.body).toContain(
      'BTC onder zijn Kijun — verkoop naar euro',
    );
    expect(JSON.parse(buildPayload(report({ btcInTrend: true }), './')).notification.body).toContain(
      'BTC boven zijn Kijun — verkoop naar BTC',
    );
  });

  it('stays far below the 3993-byte ceiling even with a full top 100', () => {
    const many = Array.from({ length: 100 }, (_, i) => `SYM${i}`);
    const payload = buildPayload(
      report({
        sections: { buitenkans: many, winstPakken: many, verkopen: many, houden: many, buyCandidates: many, owned: many },
        coins: many.map((s) => coin(s)),
      }),
      'https://example.test/tracker/?d=2026-09-20',
    );
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(3000);
  });
});

describe('sendDailyPush', () => {
  it('skips cleanly when the VAPID keys are missing, rather than throwing', async () => {
    const r = await sendDailyPush(report(), {});
    expect(r.skipped).toMatch(/VAPID/);
    expect(r.sent).toEqual([]);
  });

  it('skips cleanly when no subscription has been pasted yet', async () => {
    const r = await sendDailyPush(report(), { VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'y' });
    expect(r.skipped).toMatch(/PUSH_SUBSCRIPTION/);
  });

  it('ignores a malformed subscription secret instead of crashing the run', async () => {
    const r = await sendDailyPush(report(), {
      VAPID_PUBLIC_KEY: 'x',
      VAPID_PRIVATE_KEY: 'y',
      PUSH_SUBSCRIPTION_PHONE: 'not json at all',
      PUSH_SUBSCRIPTION_EMPTY: '',
    });
    expect(r.skipped).toMatch(/PUSH_SUBSCRIPTION/);
  });
});
