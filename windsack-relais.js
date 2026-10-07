// Windsack-Relais · Cloudflare Worker (kostenlos) · Version 1
//
// Holt Live-Flugdaten (ADS-B) bei adsb.fi, adsb.lol oder airplanes.live und reicht sie an Windsack weiter.
// Grund: Diese Freiwilligen-Netze geben ihre Daten frei, erlauben aber keinen Abruf direkt aus einer
// Web-App (keine CORS-Freigabe). Das Relais gilt nur für die eigene Windsack-Adresse (APP), speichert nichts
// und hält Antworten 5 Sekunden zwischen, damit die Netze nicht öfter als nötig abgefragt werden.
//
// Einrichten (einmalig): dash.cloudflare.com → Workers & Pages → Create application → «Start with Hello World!» → Deploy
// → «Edit code» → Beispielcode ganz durch diesen Code ersetzen → Deploy → Adresse (…workers.dev) in Windsack
// eintragen (Flugverkehr → Relais einrichten).

const APP = ['https://marcesss97.github.io'];

const QUELLEN = [
  ['adsb.fi', (la, lo, d) => `https://opendata.adsb.fi/api/v3/lat/${la}/lon/${lo}/dist/${d}`],
  ['adsb.lol', (la, lo, d) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${d}`],
  ['airplanes.live', (la, lo, d) => `https://api.airplanes.live/v2/point/${la}/${lo}/${d}`],
];

function kopf(req) {
  const o = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': o && APP.includes(o) ? o : APP[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Quelle',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}
const antwort = (req, obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...kopf(req), 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: kopf(req) });
    if (req.method !== 'GET') return antwort(req, { error: 'Nur GET' }, 405);
    const url = new URL(req.url);
    if (url.pathname === '/') return antwort(req, { app: 'windsack-relais', v: 1, quellen: QUELLEN.map((q) => q[0]) });
    if (url.pathname !== '/adsb') return antwort(req, { error: 'Unbekannter Pfad' }, 404);

    // Umkreis-Abfrage: Mittelpunkt (Grad) und Radius (Seemeilen, 1–250)
    const p = url.searchParams;
    const lat = Number(p.get('lat')), lon = Number(p.get('lon')), dist = Math.round(Number(p.get('dist')));
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && dist >= 1 && dist <= 250)) return antwort(req, { error: 'Ungültige Parameter' }, 400);
    const la = lat.toFixed(2), lo = lon.toFixed(2);

    // Bevorzugte Quelle zuerst, dann die anderen
    const erst = Math.max(0, QUELLEN.findIndex((q) => q[0] === p.get('src')));
    const fehler = [];
    for (let i = 0; i < QUELLEN.length; i++) {
      const [name, adresse] = QUELLEN[(erst + i) % QUELLEN.length];
      try {
        const r = await fetch(adresse(la, lo, dist), {
          headers: { Accept: 'application/json', 'User-Agent': 'windsack-relais/1 (privat)' },
          cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 5, '300-599': 0 } },
        });
        const typ = r.headers.get('Content-Type') || '';
        if (!r.ok || typ.includes('html')) {
          fehler.push(`${name}: ${r.status}`);
          try { await r.body?.cancel(); } catch { /* egal */ }
          continue;
        }
        return new Response(r.body, { status: 200, headers: { ...kopf(req), 'Content-Type': 'application/json; charset=utf-8', 'X-Quelle': name } });
      } catch (e) {
        fehler.push(`${name}: ${(e && e.message) || 'Netzwerkfehler'}`);
      }
    }
    return antwort(req, { error: 'Keine Quelle erreichbar', details: fehler }, 502);
  },
};
