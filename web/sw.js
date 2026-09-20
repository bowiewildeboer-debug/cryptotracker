/**
 * Service worker: offline shell, fresh data, and web push.
 *
 * All paths are RELATIVE. GitHub Pages serves a project site from /<repo>/ and cannot send a
 * Service-Worker-Allowed header, so the scope is /<repo>/ and absolute paths would break.
 */
const SHELL_CACHE = 'shell-v1';
const DATA_CACHE = 'data-v1';
const SHELL = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Network first, cache only as a fallback - for the app shell as well as the data.
 *
 * Cache-first would be faster, but it also means a deployed fix keeps showing the old file
 * until the cache name changes, and a stale report that looks current is exactly the failure
 * this app must not have. The shell is a few kilobytes, so the round trip costs nothing, and
 * the cache still makes it work with no connection at all.
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const cacheName = url.pathname.includes('/data/') ? DATA_CACHE : SHELL_CACHE;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(cacheName).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) ?? Response.error()),
  );
});

/**
 * Push. The payload may arrive in Safari's declarative shape ({notification:{...}}) or as a
 * plain object, so tolerate both. showNotification inside waitUntil is mandatory: a push that
 * displays nothing gets the subscription revoked outright on iOS.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { notification: { title: 'Cryptotracker', body: event.data ? event.data.text() : '' } };
  }
  const n = data.notification || data;
  event.waitUntil(
    self.registration.showNotification(n.title || 'Cryptotracker', {
      body: n.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: n.tag || 'daily-report',
      renotify: true,
      data: { url: n.navigate || './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.href).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) if (c.url.startsWith(self.registration.scope)) return c.focus();
      return self.clients.openWindow(target);
    })(),
  );
});

// Fires in Firefox and never in Chrome, so it is a best-effort nudge, not the safety net.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.showNotification('Meldingen opnieuw koppelen', {
      body: 'Open de tracker en kopieer het nieuwe abonnement naar de GitHub-secret.',
      icon: './icons/icon-192.png',
    }),
  );
});
