/* Windsack – Hintergrunddienst nur für Mitteilungen.
   Kein Offline-Zwischenspeicher: die App lädt immer frisch vom Server. Gehört neben index.html. */
'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Mitteilung der GitHub-Aktion anzeigen: { title, body, tag, url, ts }
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  if (!d || typeof d !== 'object') d = {};
  const opts = {
    body: String(d.body || '').slice(0, 600),
    icon: 'apple-touch-icon.png',
    badge: 'apple-touch-icon.png',
    data: { url: typeof d.url === 'string' ? d.url : './' },
    timestamp: Number.isFinite(d.ts) ? d.ts : Date.now(),
  };
  if (d.tag) { opts.tag = String(d.tag).slice(0, 64); opts.renotify = true; }
  e.waitUntil(self.registration.showNotification(String(d.title || 'Windsack').slice(0, 120), opts));
});

// Antippen: offene App nach vorne holen und zur Meldung springen, sonst die App öffnen
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const raw = (e.notification.data && e.notification.data.url) || './';
  let url;
  try { url = new URL(raw, self.registration.scope); } catch (x) { url = new URL('./', self.registration.scope); }
  if (url.origin !== self.location.origin) url = new URL('./', self.registration.scope);
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (!c.url.startsWith(self.registration.scope)) continue;
      try { await c.focus(); } catch (x) { /* egal */ }
      c.postMessage({ k: 'nav', hash: url.hash || '#/' });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
