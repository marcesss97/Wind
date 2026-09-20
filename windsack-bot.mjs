// Windsack-Bot · läuft als GitHub-Aktion (.github/workflows/windsack.yml) alle 10 Minuten.
// – Datenspiegel: Alertswiss, Nordlicht (NOAA SWPC), SLF-Messnetz, Lawinenunfälle, Roundshot-Standorte
//   → JSON-Dateien im Zweig «data» (die App liest sie über raw.githubusercontent.com).
// – Mitteilungen: Web-Push an alle Geräte im Secret WINDSACK_PUSH (Alertswiss, Nordlicht, Erdbeben).
// Keine Abhängigkeiten: Verschlüsselung (RFC 8291) und Absender-Kennung VAPID (RFC 8292) mit node:crypto.
// Diese Datei wird beim Bauen der App erzeugt – Änderungen in src/bot/windsack-bot.src.mjs vornehmen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ── gemeinsam mit der App (src/js/09-shared.js) ── */
/* ═════════════════════════ Gemeinsame Auswertung (App und GitHub-Aktion) ═════════════════════════
   Reine Funktionen ohne Browser- oder App-Zugriff. Die Build-Stufe kopiert diesen Block unverändert
   in das Skript der GitHub-Aktion (Node), damit beide Seiten Alertswiss und Nordlicht gleich auswerten. */
const SH_TZ = 'Europe/Zurich';
const shIso = (s) => {
  const x = String(s ?? '').trim().replace(' ', 'T');
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(x) ? x : x + 'Z');
};
// HTML-Schnipsel aus fremden Quellen in reinen Text verwandeln (nie als HTML einsetzen)
function shPlain(s) {
  return String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&')
    .replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ───── Sonnenstand (Dämmerung für Nordlicht) ───── */
function shSunAlt(ms, lat, lon) {
  const rad = Math.PI / 180, d = ms / 864e5 - 10957.5;
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24;
  const ha = (gmst * 15 + lon) * rad - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
}
const SH_CH = { lat: 46.8, lon: 8.2 }; // Mitte der Schweiz
const shDark = (ms, alt = -12) => shSunAlt(ms, SH_CH.lat, SH_CH.lon) < alt;
// Nacht, zu der ein Zeitpunkt gehört (Datum des Abends, Schweizer Zeit)
const shNight = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: SH_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms - 12 * 36e5);

/* ───── NOAA SWPC: Kp-Index, Meldungen ───── */
// 3-h-Werte (beobachtet, geschätzt, vorhergesagt). Seit März 2026 Objekte mit Zahlen, früher Listen mit Kopfzeile.
function shKpSlots(raw) {
  const out = [];
  let head = null;
  for (const r of Array.isArray(raw) ? raw : []) {
    let o = r;
    if (Array.isArray(r)) {
      if (!head) { head = r.map((x) => String(x).toLowerCase()); continue; }
      o = {};
      head.forEach((h, i) => { o[h] = r[i]; });
    }
    if (!o || typeof o !== 'object') continue;
    const t = shIso(o.time_tag), k = Number(o.kp ?? o.Kp ?? o.kp_index);
    if (!Number.isFinite(t) || !Number.isFinite(k)) continue;
    const kind = String(o.observed || 'observed').toLowerCase();
    out.push({ t, kp: Math.round(k * 100) / 100, kind: kind.startsWith('pred') ? 'p' : kind.startsWith('est') ? 'e' : 'o', g: o.noaa_scale ? String(o.noaa_scale) : null });
  }
  return out.sort((a, b) => a.t - b.t);
}
// 1-Minuten-Schätzung
function shKp1m(raw) {
  return (Array.isArray(raw) ? raw : []).map((o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const t = shIso(o.time_tag), k = Number(o.estimated_kp ?? o.kp_index);
    return Number.isFinite(t) && Number.isFinite(k) ? { t, kp: Math.round(k * 100) / 100 } : null;
  }).filter(Boolean).sort((a, b) => a.t - b.t);
}
// Codes: WATA20/30/50/99 = Sturm G1/G2/G3/≥G4 erwartet · ALTK04–09 = K-Index erreicht · WARK04–07 = K-Index erwartet
const SH_SWPC_KP = { WATA20: 5, WATA30: 6, WATA50: 7, WATA99: 8, ALTK04: 4, ALTK05: 5, ALTK06: 6, ALTK07: 7, ALTK08: 8, ALTK09: 9, WARK04: 4, WARK05: 5, WARK06: 6, WARK07: 7 };
function shSwpcMsgs(raw) {
  return (Array.isArray(raw) ? raw : []).map((r) => {
    const msg = String((r && r.message) || '');
    const code = ((/Space Weather Message Code:\s*([A-Z0-9]+)/.exec(msg) || [])[1] || String((r && r.product_id) || '')).trim();
    if (!code) return null;
    const t = shIso(r && r.issue_datetime);
    return { code, serial: (/Serial Number:\s*(\d+)/.exec(msg) || [])[1] || '', t: Number.isFinite(t) ? t : null, kp: SH_SWPC_KP[code] ?? null, kind: code.slice(0, 3), text: msg.slice(0, 700) };
  }).filter(Boolean).sort((a, b) => (b.t || 0) - (a.t || 0));
}
const shKpG = (kp) => (kp >= 8.67 ? 'G5' : kp >= 7.67 ? 'G4' : kp >= 6.67 ? 'G3' : kp >= 5.67 ? 'G2' : kp >= 4.67 ? 'G1' : '');
// Lage für die Schweiz: jetzt möglich? Welche Nächte mit Vorhersage über der Schwelle?
// Faustregel (SRF Meteo): Polarlichter ab Kp ≈ 7 am Nordhorizont, meist nur mit Kamera; ab Kp 8 auch von Auge.
function shAurora({ slots = [], est = [], msgs = [] } = {}, thr = 6.67, now = Date.now()) {
  const last = est.length ? est[est.length - 1] : null;
  const recent = est.filter((e) => e.t > now - 16 * 60e3 && e.t <= now + 60e3);
  const high = recent.length >= 3 && recent.filter((e) => e.kp >= thr).length >= Math.ceil(recent.length * 0.6);
  const alt = msgs.find((m) => m.kind === 'ALT' && m.kp != null && m.kp >= thr - 0.34 && m.t && now - m.t < 3 * 36e5 && now >= m.t) || null;
  const dark = shDark(now, -10);
  const nights = new Map();
  for (const s of slots) {
    if (s.kind !== 'p' && s.kind !== 'e') continue;
    if (s.t + 3 * 36e5 < now || s.t > now + 72 * 36e5 || s.kp < thr) continue;
    let dk = false;
    for (let h = 0; h <= 3; h += 0.5) if (shDark(s.t + h * 36e5)) { dk = true; break; }
    if (!dk) continue;
    const k = shNight(s.t + 1.5 * 36e5), n = nights.get(k);
    if (!n || s.kp > n.kp) nights.set(k, { night: k, t: s.t, kp: s.kp, g: s.g || shKpG(s.kp) });
  }
  const watch = msgs.find((m) => m.kind === 'WAT' && m.kp != null && m.kp >= thr - 0.34 && m.t && now - m.t < 48 * 36e5) || null;
  let maxFc = null;
  for (const s of slots) if (s.kind === 'p' && s.t > now - 3 * 36e5 && s.t < now + 72 * 36e5 && (!maxFc || s.kp > maxFc.kp)) maxFc = s;
  return { thr, kpNow: last ? last.kp : null, kpAt: last ? last.t : null, high, alt, dark, now: (high || !!alt) && dark, nights: [...nights.values()], watch, maxFc };
}

/* ───── Alertswiss: Meldungen vereinheitlichen (ohne Flächen) ───── */
const SH_AS_LEVEL = { minor: 'Information', moderate: 'Warnung', severe: 'Alarm', extreme: 'Alarm' };
const SH_AS_RANK = { Alarm: 0, Warnung: 1, Information: 2, Entwarnung: 3 };
// Weblink einer Meldung: nur https (http wird angehoben), «www.kanton.ch» ohne Schema ergänzt,
// die allgemeine Startseite von alert.swiss weggelassen (steht bei fast jeder Meldung)
function shAsUrl(u) {
  let s = String(u ?? '').trim();
  if (!s || s.length > 500 || /\s/.test(s)) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  s = s.replace(/^http:/i, 'https:');
  let x;
  try { x = new URL(s); } catch { return ''; }
  if (x.protocol !== 'https:' || x.username || x.password || !/^([a-z0-9-]+\.)+[a-z]{2,24}$/i.test(x.hostname)) return '';
  if (/^(www\.)?alert\.swiss$/i.test(x.hostname) && /^\/?$/.test(x.pathname) && !x.search) return '';
  return x.href;
}
function shAlerts(raw) {
  const list = raw && Array.isArray(raw.alerts) ? raw.alerts : [];
  return list.filter((a) => a && a.identifier && !a.technicalTestAlert && !a.testAlert && !/^TEST-/i.test(String(a.identifier))).map((a) => {
    const id = String(a.identifier).slice(0, 80), m = /^(.*)-(\d+)$/.exec(id);
    const t = shIso(String(a.reference || '').split(',').pop());
    const regions = [...new Set((a.areas || []).flatMap((ar) => (ar && ar.regions ? ar.regions : []).map((r) => r && String(r.region || '').trim())).filter(Boolean))];
    const area = [...new Set((a.areas || []).map((ar) => shPlain(ar && ar.description && ar.description.description)).filter(Boolean))].join(', ');
    const icon = typeof a.eventIconPath === 'string' && /^\/[\w\-./]+$/.test(a.eventIconPath) ? 'https://www.alert.swiss' + a.eventIconPath : '';
    const links = [];
    const addLink = (href, text) => {
      const url = shAsUrl(href);
      if (!url || links.length >= 4 || links.some((l) => l.url === url)) return;
      links.push({ url, text: shPlain(text).replace(/\s+/g, ' ').slice(0, 140) });
    };
    for (const l of Array.isArray(a.links) ? a.links : []) if (l) addLink(l.href, l.text);
    if (typeof a.link === 'string') addLink(a.link, '');
    const level = a.allClear ? 'Entwarnung' : SH_AS_LEVEL[a.severity] || 'Information';
    return {
      id, base: m ? m[1] : id, ver: m ? +m[2] : 1, t: Number.isFinite(t) ? t : null, sent: shPlain(a.sent).slice(0, 60),
      title: shPlain(a.title && a.title.title).slice(0, 300), desc: shPlain(a.description && a.description.description).slice(0, 4000),
      instr: (Array.isArray(a.instructions) ? a.instructions : []).map((x) => shPlain(x && x.text).slice(0, 800)).filter(Boolean).slice(0, 12),
      event: shPlain(a.event).slice(0, 80), sev: String(a.severity || '').slice(0, 20),
      level, rank: SH_AS_RANK[level], allClear: !!a.allClear,
      regions: a.nationWide ? ['CH'] : regions.slice(0, 30), area: area.slice(0, 400), pub: shPlain(a.publisherName).slice(0, 120),
      contact: shPlain(a.contact && a.contact.contact).slice(0, 800), links, link: links.length ? links[0].url : '', icon,
    };
  }).sort((x, y) => x.rank - y.rank || (y.t || 0) - (x.t || 0));
}

/* ───── Erdbeben: FDSN-Textformat des SED ───── */
function shFdsn(txt) {
  const out = [];
  for (const line of String(txt || '').split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    const c = line.split('|');
    if (c.length < 13) continue;
    const typ = (c[13] || '').trim();
    if (typ && typ !== 'earthquake') continue;
    const t = shIso(c[1].trim().slice(0, 23)), lat = +c[2], lon = +c[3], dep = +c[4], mag = +c[10];
    if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(mag)) continue;
    out.push({ id: c[0].trim(), t, lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, dep: Number.isFinite(dep) ? Math.round(dep * 10) / 10 : null,
      mag: Math.round(mag * 10) / 10, mt: (c[9] || '').trim(), place: (c[12] || '').trim() });
  }
  return out.sort((a, b) => b.t - a.t);
}

/* ───── SLF-Messnetz ───── */
// Jüngster gültiger Wert je Feld (Sensoren fallen einzeln aus); älter als 3 h vor dem letzten Wert zählt nicht
function shSlfLatest(rows) {
  const F = [['HS', 'HS'], ['TA', 'TA_30MIN_MEAN'], ['RH', 'RH_30MIN_MEAN'], ['TSS', 'TSS_30MIN_MEAN'], ['VW', 'VW_30MIN_MEAN'], ['VWX', 'VW_30MIN_MAX'], ['DW', 'DW_30MIN_MEAN'], ['RSWR', 'RSWR_30MIN_MEAN']];
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = shIso(r && r.measure_date);
    if (!r || !r.station_code || !Number.isFinite(t)) continue;
    const o = m.get(r.station_code) || m.set(r.station_code, { t: 0, _: {} }).get(r.station_code);
    if (t > o.t) o.t = t;
    for (const [k, f] of F) { const v = r[f] == null || r[f] === '' || !Number.isFinite(+r[f]) ? null : +r[f]; if (v != null && !(o._[k] > t)) { o[k] = v; o._[k] = t; } }
  }
  for (const o of m.values()) { for (const [k] of F) if (o._[k] != null && o.t - o._[k] > 3 * 36e5) o[k] = null; delete o._; }
  return m;
}


const ENV = process.env;
const REPO = /^[\w.-]+\/[\w.-]+$/.test(ENV.REPO || '') ? ENV.REPO : ENV.GITHUB_REPOSITORY || 'marcesss97/Wind';
const [OWNER, NAME] = REPO.split('/');
const OUT = ENV.WS_OUT || 'out', PREV = ENV.WS_PREV || 'prev', APP = ENV.WS_APP || 'app';
const NOW = Number(ENV.WS_NOW) || Date.now();
const UA = `Mozilla/5.0 (compatible; Windsack-Bot/6; +https://github.com/${REPO})`;
const SUBJECT = `https://${OWNER.toLowerCase()}.github.io/${NAME}/`;
const URLS = {
  alertswiss: ENV.WS_ALERTSWISS || 'https://www.alert.swiss/content/alertswiss-internet/de/home/_jcr_content/polyalert.alertswiss_alerts.actual.json',
  // Ersatz, falls Alertswiss den Abruf ablehnt: öffentlicher Spiegel desselben Feeds (TRMNL-AlertSwiss, alle 15 Minuten)
  alertswissAlt: ENV.WS_ALERTSWISS_ALT || 'https://cdn.jsdelivr.net/gh/michaelkurath/TRMNL-AlertSwiss@main/data/alerts.json',
  swpc: ENV.WS_SWPC || 'https://services.swpc.noaa.gov/',
  sed: ENV.WS_SED || 'https://eida.ethz.ch/fdsnws/event/1/query',
  slf: ENV.WS_SLF || 'https://measurement-api.slf.ch/public/api/',
  slfAcc: ENV.WS_SLFACC || 'https://www.slf.ch/avalanche/accidents/',
  om: ENV.WS_OM || 'https://api.open-meteo.com/v1/forecast',
  gh: ENV.WS_GHAPI || 'https://api.github.com',
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ───── Hilfen ───── */
async function get(url, { json = true, timeout = 25000, headers = {} } = {}) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*', ...headers }, signal: ctl.signal, redirect: 'follow' });
    const txt = await r.text();
    if (r.status === 204) return json ? null : '';
    if (r.status !== 200) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    if (!json) return txt;
    try { return JSON.parse(txt); } catch { throw new Error('keine gültigen JSON-Daten' + (r.headers.get('x-amzn-waf-action') ? ' (Firewall)' : '')); }
  } finally { clearTimeout(to); }
}
// Wiederholen bei Zeitüberschreitung, Netzfehler, 408, 429 und 5xx (wie curl --retry)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getRetry(url, opt, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await get(url, opt); } catch (e) {
      err = e;
      if (e.status && e.status !== 408 && e.status !== 429 && e.status < 500) break;
      if (i < tries - 1) await sleep(ENV.WS_TEST ? 30 : 5000);
    }
  }
  throw err;
}
fs.mkdirSync(OUT, { recursive: true });
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const put = (f, o) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(o));
const keep = (f) => { const p = path.join(PREV, f); if (!fs.existsSync(p)) return false; fs.copyFileSync(p, path.join(OUT, f)); return true; };
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sec = (t) => Math.round(t / 1000);
const r1 = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : Math.round(+v * 10) / 10);
const fHM = new Intl.DateTimeFormat('de-CH', { timeZone: SH_TZ, hour: '2-digit', minute: '2-digit' });
const fDT = new Intl.DateTimeFormat('de-CH', { timeZone: SH_TZ, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const fWdLong = new Intl.DateTimeFormat('de-CH', { timeZone: SH_TZ, weekday: 'long' });

/* ───── Zustand (im Zweig «data», ohne Abo-Daten) ───── */
const prevState = readJson(path.join(PREV, 'state.json'), null);
const first = !prevState;
const state = Object.assign({ v: 1, runs: 0, seen: {}, quakes: {}, aurora: {}, subs: {}, gone: {}, slfAt: 0, avAt: 0, rsAt: 0, keepAt: 0 }, prevState || {});
state.runs++;
const status = { v: 1, at: iso(NOW), run: state.runs, src: {}, subs: [], gone: [], push: { sent: 0, failed: 0 } };
const src = (k, ok, extra = {}) => { status.src[k] = { ok, at: iso(NOW), ...extra }; };

/* ───── Geräte aus dem Secret: je Gerät «ws1.<Base64url-JSON>» ───── */
function parseSubs(txt) {
  const out = [], seen = new Set();
  for (const tok of String(txt || '').split(/[\s,;]+/)) {
    const m = /^ws1\.([A-Za-z0-9_-]+)$/.exec(tok.trim());
    if (!m) continue;
    try {
      const o = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      const s = o && o.sub;
      const okEp = typeof (s && s.endpoint) === 'string' && (/^https:\/\//.test(s.endpoint) || (ENV.WS_TEST && /^http:\/\/127\.0\.0\.1[:/]/.test(s.endpoint)));
      if (!okEp || !s.keys || !s.keys.p256dh || !s.keys.auth) continue;
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(o.pub || '') || !/^[A-Za-z0-9_-]{40,50}$/.test(o.priv || '')) continue;
      const hash = crypto.createHash('sha256').update(s.endpoint).digest('hex').slice(0, 12);
      if (seen.has(hash)) continue;
      seen.add(hash);
      out.push({ hash, sub: s, pub: o.pub, priv: o.priv, p: Object.assign({ a: 1, n: 6.67, q: 0 }, o.p || {}) });
    } catch { /* ungültiger Eintrag */ }
  }
  return out;
}
const SUBS = parseSubs(ENV.WINDSACK_PUSH);
if (ENV.WINDSACK_PUSH && !SUBS.length) log('Secret WINDSACK_PUSH enthält keinen gültigen Code (ws1.…)');
const queue = new Map();
const push = (pred, msg) => { for (const s of SUBS) if (pred(s.p)) (queue.get(s.hash) || queue.set(s.hash, []).get(s.hash)).push(msg); };

/* ───── Web-Push: aes128gcm (RFC 8291) + VAPID (RFC 8292) ───── */
const b64u = (b) => Buffer.from(b).toString('base64url');
const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
function encrypt(sub, text) {
  const uaPub = Buffer.from(sub.keys.p256dh, 'base64url'), auth = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  const asPub = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPub);
  const salt = crypto.randomBytes(16);
  const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0); head.writeUInt32BE(4096, 16); head.writeUInt8(asPub.length, 20);
  return Buffer.concat([head, asPub, body]);
}
function vapid(endpoint, pub, priv) {
  const P = Buffer.from(pub, 'base64url');
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: priv, x: b64u(P.subarray(1, 33)), y: b64u(P.subarray(33, 65)) }, format: 'jwk' });
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const c = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(NOW / 1000) + 6 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${h}.${c}.${b64u(sig)}, k=${pub}`;
}
async function sendPush(s, msg) {
  const { ttl = 6 * 3600, urgency = 'normal', prio, ...payload } = msg;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(s.sub.endpoint, {
      method: 'POST', signal: ctl.signal, body: encrypt(s.sub, JSON.stringify(payload)),
      headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: String(ttl), urgency, authorization: vapid(s.sub.endpoint, s.pub, s.priv) },
    });
    if (r.status >= 200 && r.status < 300) return r.status;
    throw Object.assign(new Error(`Push HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 120)}`), { status: r.status });
  } finally { clearTimeout(to); }
}

/* ───── Alertswiss: alle Meldungen ───── */
async function doAlerts() {
  let raw = null, err = null, via = '';
  try { raw = await getRetry(URLS.alertswiss, { timeout: 30000, headers: { 'accept-language': 'de-CH,de;q=0.9' } }); } catch (e) { err = e; }
  if (!raw || !Array.isArray(raw.alerts)) {
    try {
      const alt = await getRetry(URLS.alertswissAlt, { timeout: 30000 }, 2);
      if (alt && Array.isArray(alt.alerts)) { raw = alt; via = 'TRMNL-AlertSwiss'; log('Alertswiss direkt:', err ? err.message : 'unerwartetes Format', '→ Spiegel TRMNL-AlertSwiss'); }
    } catch (e) { log('Spiegel TRMNL-AlertSwiss:', e.message); }
  }
  if (!raw || !Array.isArray(raw.alerts)) throw err || new Error('unerwartetes Format');
  const list = shAlerts(raw);
  put('alerts.json', { v: 1, at: iso(NOW), src: 'www.alertswiss.ch', ...(via ? { via } : {}), alerts: list });
  const seen = state.seen || {};
  const bases = new Set(Object.keys(seen).map((id) => id.replace(/-\d+$/, '')));
  const fresh = list.filter((a) => !seen[a.id]);
  const next = {};
  for (const a of list) next[a.id] = seen[a.id] || NOW;
  for (const [id, t] of Object.entries(seen)) if (!next[id] && NOW - t < 45 * 864e5) next[id] = t;
  state.seen = next;
  src('alertswiss', true, { n: list.length, ...(via ? { via } : {}) });
  status.alerts = list.length;
  if (first) return;
  for (const a of fresh.sort((x, y) => (x.t || 0) - (y.t || 0))) {
    const upd = !a.allClear && bases.has(a.base);
    const where = a.regions.length ? a.regions.slice(0, 5).join(', ') + (a.regions.length > 5 ? ' …' : '') : a.area;
    push((p) => +p.a, {
      title: `Alertswiss · ${a.level}${where ? ' · ' + where : ''}`.slice(0, 90),
      body: `${upd ? 'Aktualisierung: ' : ''}${a.title}${a.desc ? ' – ' + a.desc.replace(/\s+/g, ' ') : ''}`.slice(0, 300),
      tag: 'as-' + a.base.slice(0, 50), url: './#/meldungen/alert?as=' + encodeURIComponent(a.id), ts: a.t || NOW,
      urgency: a.level === 'Alarm' ? 'high' : 'normal', ttl: 12 * 3600, prio: a.level === 'Alarm' ? 3 : 1,
    });
  }
}

/* ───── Nordlicht (NOAA SWPC) ───── */
let omCache;
async function cloudText(t0, t1) {
  try {
    omCache = omCache || await get(`${URLS.om}?latitude=47.38,46.95,46.52,46.85&longitude=8.54,7.44,6.63,9.53&hourly=cloud_cover&forecast_days=3&timezone=UTC&timeformat=unixtime`, { timeout: 15000 });
    const locs = Array.isArray(omCache) ? omCache : [omCache];
    const vals = [];
    for (const l of locs) {
      const h = l && l.hourly;
      if (!h || !Array.isArray(h.time)) continue;
      h.time.forEach((t, i) => { const ms = t * 1000; if (ms >= t0 - 30 * 60e3 && ms <= t1 + 30 * 60e3 && Number.isFinite(h.cloud_cover[i])) vals.push(h.cloud_cover[i]); });
    }
    if (!vals.length) return '';
    const m = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length / 5) * 5;
    return ` Bewölkung Mittelland/Alpen ~${m} %${m >= 80 ? ' – wenig Chancen' : m <= 30 ? ' – gute Sicht' : ''}.`;
  } catch { return ''; }
}
function nightLabel(key) {
  if (key === shNight(NOW + 6 * 36e5)) return 'heute Nacht';
  if (key === shNight(NOW + 30 * 36e5)) return 'morgen Nacht';
  const [y, m, d] = key.split('-').map(Number);
  return `in der Nacht auf ${fWdLong.format(Date.UTC(y, m - 1, d + 1, 12))}`;
}
async function doAurora() {
  const S = URLS.swpc;
  const fc = await get(S + 'products/noaa-planetary-k-index-forecast.json');
  const [est, al] = await Promise.all([get(S + 'json/planetary_k_index_1m.json').catch(() => []), get(S + 'products/alerts.json').catch(() => [])]);
  const slots = shKpSlots(fc);
  if (!slots.length) throw new Error('keine Kp-Werte');
  const e1 = shKp1m(est).filter((x) => x.t > NOW - 4 * 36e5 && x.t <= NOW + 60e3);
  const msgs = shSwpcMsgs(al);
  const data = { slots, est: e1, msgs };
  put('aurora.json', {
    v: 1, at: iso(NOW), src: 'NOAA SWPC',
    slots: slots.filter((s) => s.t > NOW - 3 * 864e5).map((s) => [sec(s.t), s.kp, s.kind, s.g]),
    est: e1.filter((x, i, a) => i % 5 === 0 || i === a.length - 1).map((x) => [sec(x.t), x.kp]),
    msgs: msgs.filter((m) => m.t && NOW - m.t < 10 * 864e5).slice(0, 15).map(({ code, serial, t, kp, kind }) => ({ code, serial, t, kp, kind })),
  });
  const kpNow = e1.length ? e1[e1.length - 1].kp : null;
  src('swpc', true, { kp: kpNow });
  status.kp = kpNow;
  for (const thr of [...new Set(SUBS.map((s) => +s.p.n).filter((n) => n > 0))]) {
    const st = shAurora(data, thr, NOW);
    const A = state.aurora[thr] = state.aurora[thr] || { now: 0, nights: {}, watch: '' };
    const ev = [];
    if (st.now && NOW - A.now > 6 * 36e5) {
      A.now = NOW;
      ev.push({ k: 'now' });
      // die laufende Nacht ist damit gemeldet
      const cur = shNight(NOW), n0 = st.nights.find((n) => n.night === cur);
      if (n0) A.nights[cur] = Math.max(A.nights[cur] || 0, n0.kp);
    }
    // neue (oder deutlich stärkere) Nächte gemeinsam in einer Mitteilung
    const newN = [];
    for (const n of [...st.nights].sort((a, b) => a.t - b.t)) {
      const was = A.nights[n.night];
      if (was == null || n.kp >= was + 1) { A.nights[n.night] = n.kp; newN.push({ ...n, upd: was != null }); }
    }
    if (newN.length) ev.push({ k: 'night', n: newN[0], more: newN.slice(1), upd: newN[0].upd });
    const wk = st.watch ? `${st.watch.code}-${st.watch.serial}` : '';
    if (wk && A.watch !== wk) { A.watch = wk; if (!ev.length) ev.push({ k: 'watch', w: st.watch }); }
    for (const k of Object.keys(A.nights)) if (k < shNight(NOW - 3 * 864e5)) delete A.nights[k];
    if (first) continue;
    const who = (p) => +p.n === thr;
    for (const x of ev) {
      if (x.k === 'now') {
        const g = shKpG(st.kpNow);
        push(who, { title: 'Nordlicht jetzt möglich', body: `Kp ${st.kpNow.toFixed(1)}${g ? ' (' + g + ')' : ''} – am Nordhorizont, von einem dunklen Ort mit freier Sicht nach Norden; die Kamera sieht mehr als das Auge.${await cloudText(NOW, NOW + 2 * 36e5)}`, tag: 'aurora', url: './#/meldungen/aurora', urgency: 'high', ttl: 3 * 3600, prio: 2 });
      } else if (x.k === 'night') {
        const n = x.n;
        const more = x.more.length ? ` Ausserdem ${x.more.map((m) => `${nightLabel(m.night)} (Kp ${m.kp.toFixed(1)})`).join(' und ')}.` : '';
        push(who, { title: `Nordlicht-Chance ${nightLabel(n.night)}`, body: `${x.upd ? 'Neue Vorhersage' : 'Vorhersage'}: Kp ${n.kp.toFixed(1)}${n.g ? ' (' + n.g + ')' : ''} um ${fHM.format(n.t)}–${fHM.format(n.t + 3 * 36e5)} Uhr.${more}${await cloudText(n.t, n.t + 3 * 36e5)} Dunklen Ort mit Sicht nach Norden suchen.`, tag: 'aurora', url: './#/meldungen/aurora', ttl: 12 * 3600 });
      } else {
        push(who, { title: 'Sonnensturm angekündigt', body: `Die NOAA erwartet einen geomagnetischen Sturm (${x.w.code}${x.w.kp ? ', bis Kp ' + x.w.kp : ''}). Nordlicht in der Schweiz möglich – Vorhersage in der App verfolgen.`, tag: 'aurora', url: './#/meldungen/aurora', ttl: 12 * 3600 });
      }
    }
  }
}

/* ───── Erdbeben (nur für Mitteilungen; die App liest den SED direkt) ───── */
async function doQuakes() {
  const mins = SUBS.map((s) => +s.p.q).filter((q) => q > 0);
  if (!mins.length) return false;
  const start = new Date(NOW - 2 * 864e5).toISOString().slice(0, 19);
  const txt = await get(`${URLS.sed}?starttime=${start}&minlatitude=45.4&maxlatitude=48.3&minlongitude=5.4&maxlongitude=11.1&minmagnitude=${Math.min(...mins)}&eventtype=earthquake&orderby=time&format=text&limit=200`, { json: false });
  const list = shFdsn(txt);
  const init = !state.quakesInit;
  state.quakesInit = 1;
  for (const q of list) {
    if (state.quakes[q.id]) continue;
    state.quakes[q.id] = NOW;
    if (first || init || NOW - q.t > 6 * 36e5) continue;
    push((p) => +p.q > 0 && q.mag >= +p.q, {
      title: `Erdbeben M ${q.mag.toFixed(1)} · ${q.place || 'Schweiz'}`.slice(0, 90),
      body: `${fDT.format(q.t)} Uhr, Tiefe ${q.dep != null ? Math.max(0, Math.round(q.dep)) : '–'} km. ${q.mag >= 4 ? 'In weitem Umkreis verspürt.' : 'In der Nähe meist verspürt.'} Quelle: Schweizerischer Erdbebendienst SED.`,
      tag: 'qk-' + q.id.split('/').pop().slice(-24), url: './#/meldungen/quake', ts: q.t, ttl: 6 * 3600,
    });
  }
  for (const [id, t] of Object.entries(state.quakes)) if (NOW - t > 7 * 864e5) delete state.quakes[id];
  src('quakes', true, { n: list.length });
  return true;
}

/* ───── SLF-Messnetz: alle Stationen, letzte Werte, 24-h-Verlauf, 7 Tage Schnee ───── */
async function doSlf() {
  if (NOW - state.slfAt < 25 * 60e3 && keep('slf.json')) { keep('slf-ser.json'); src('slf', true, { kept: true }); return; }
  const B = URLS.slf;
  const [st, sp, ms, ds, spm] = await Promise.allSettled([get(B + 'imis/stations'), get(B + 'study-plot/stations'), get(B + 'imis/measurements', { timeout: 120000 }),
    get(B + 'imis/daily-snow?period_in_days=7'), get(B + 'study-plot/measurements')]);
  if (st.status !== 'fulfilled') throw st.reason;
  const ok = (r) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []);
  const valid = (arr) => arr.filter((x) => x && x.code && Number.isFinite(+x.lat) && Number.isFinite(+x.lon));
  const out = { v: 1, at: iso(NOW), src: 'SLF (CC BY 4.0)', st: [], sp: [], f: ['t', 'HS', 'TA', 'RH', 'TSS', 'VW', 'VWX', 'DW', 'RSWR'], last: {}, hn: {}, daily: {}, spm: {} };
  const ele = (x) => (x.elevation != null && Number.isFinite(+x.elevation) ? Math.round(+x.elevation) : null);
  for (const x of valid(ok(st))) out.st.push([String(x.code), String(x.label || x.code), +(+x.lat).toFixed(5), +(+x.lon).toFixed(5), ele(x), String(x.canton_code || ''), String(x.type || '')]);
  for (const x of valid(ok(sp))) out.sp.push([String(x.code), String(x.label || x.code), +(+x.lat).toFixed(5), +(+x.lon).toFixed(5), ele(x), String(x.canton_code || '')]);
  const rows = ok(ms);
  const last = shSlfLatest(rows);
  for (const [code, o] of last) out.last[code] = [sec(o.t), r1(o.HS), r1(o.TA), r1(o.RH), r1(o.TSS), r1(o.VW), r1(o.VWX), o.DW == null ? null : Math.round(o.DW), o.RSWR == null ? null : Math.round(o.RSWR)];
  const daily = {};
  for (const r of ok(ds)) {
    const t = shIso(r && r.measure_date);
    if (!r || !r.station_code || !Number.isFinite(t)) continue;
    (daily[r.station_code] = daily[r.station_code] || []).push([sec(t), r1(r.HS), r1(r.HN_1D)]);
  }
  for (const [code, a] of Object.entries(daily)) { a.sort((x, y) => x[0] - y[0]); out.daily[code] = a.slice(-8); const l = a[a.length - 1]; if (l) out.hn[code] = [l[0], l[2]]; }
  for (const r of ok(spm)) {
    const t = shIso(r && r.measure_date);
    if (!r || !r.station_code || !Number.isFinite(t)) continue;
    const p = out.spm[r.station_code];
    if (!p || sec(t) > p[0]) out.spm[r.station_code] = [sec(t), r1(r.HS), r1(r.HN_1D), r1(r.HNW_1D)];
  }
  put('slf.json', out);
  let tMax = 0;
  for (const r of rows) { const t = shIso(r && r.measure_date); if (Number.isFinite(t) && t > tMax) tMax = t; }
  if (tMax) {
    const t0 = Math.floor(tMax / 36e5) * 36e5 - 23 * 36e5, F = ['HS', 'TA_30MIN_MEAN', 'VW_30MIN_MEAN', 'VW_30MIN_MAX', 'DW_30MIN_MEAN'], s = {};
    for (const r of rows) {
      const t = shIso(r && r.measure_date);
      if (!Number.isFinite(t) || t % 36e5 !== 0) continue;
      const i = Math.round((t - t0) / 36e5);
      if (i < 0 || i > 23) continue;
      const a = s[r.station_code] || (s[r.station_code] = F.map(() => Array(24).fill(null)));
      F.forEach((f, fi) => { const v = r[f]; if (v != null && v !== '' && Number.isFinite(+v)) a[fi][i] = fi === 4 ? Math.round(+v) : r1(v); });
    }
    put('slf-ser.json', { v: 1, at: iso(NOW), t0: sec(t0), dt: 3600, n: 24, f: ['HS', 'TA', 'VW', 'VWX', 'DW'], s });
  } else keep('slf-ser.json');
  state.slfAt = NOW;
  src('slf', true, { st: out.st.length, sp: out.sp.length, meas: last.size });
}

/* ───── Lawinenunfälle der laufenden Saison (SLF, KML) ───── */
const cdata = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
// Aktivität laut SLF (englische KML) → Begriffe der SLF-Unfallstatistik
const AV_ACT = [[/off-?piste|variant|freeride|hors-piste/i, 'Variantengelände'], [/backcountry|touring|\btour/i, 'Tourengelände'],
  [/transport|traffic|road|verkehr|strasse|straße/i, 'Verkehrsweg'], [/building|settlement|gebäude|siedlung/i, 'Gebäude'], [/^other|^andere/i, 'Anderes']];
const avAct = (s) => String(s || '').split(/\s*[,;]\s*/).map((x) => x.trim()).filter(Boolean)
  .map((x) => { for (const [re, de] of AV_ACT) if (re.test(x)) return de; return x.slice(0, 40); })
  .filter((x, i, a) => a.indexOf(x) === i).join(', ').slice(0, 80);
// Saison = hydrologisches Jahr (1. Oktober bis 30. September)
const seasonOf = (y, m) => (m >= 10 ? `${y}/${String((y + 1) % 100).padStart(2, '0')}` : `${y - 1}/${String(y % 100).padStart(2, '0')}`);
function parseKml(kml) {
  const out = [];
  for (const m of String(kml).matchAll(/<Placemark\b[\s\S]*?<\/Placemark>/gi)) {
    const pm = m[0];
    const c = /<coordinates>\s*([-\d.]+)\s*,\s*([-\d.]+)(?:\s*,\s*([-\d.]+))?/i.exec(pm);
    if (!c) continue;
    const lon = +c[1], lat = +c[2], z = c[3] != null ? +c[3] : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) continue;
    const name = shPlain(cdata((/<name>([\s\S]*?)<\/name>/i.exec(pm) || [])[1]));
    const rawDesc = cdata((/<description>([\s\S]*?)<\/description>/i.exec(pm) || [])[1]);
    const desc = shPlain(rawDesc);
    const ext = [];
    for (const d of pm.matchAll(/<Data\s+name="([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>/gi)) ext.push(`${d[1]}: ${shPlain(cdata(d[2]))}`);
    const all = `${name}\n${desc}\n${ext.join('\n')}`;
    const dm = /(\d{4})-(\d{2})-(\d{2})/.exec(all) || /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(all);
    const d = dm ? (dm[1].length === 4 ? `${dm[1]}-${dm[2]}-${dm[3]}` : `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`) : '';
    const numOf = (re) => { const x = re.exec(all); return x ? +x[1] : null; };
    // Gefahrenstufe am Unfalltag, wie im SLF-Bulletin: «3=», «3+», «(2-)», «2, 2+» – leer ohne Bulletin
    const lv = /(?:danger\s*level|gefahrenstufe)[ \t]*:?[ \t]*([^\n]*)/i.exec(all);
    const lvTxt = lv ? lv[1].replace(/\s+/g, ' ').trim().slice(0, 16) : '';
    const lvl = /[1-5]/.test(lvTxt) ? +/[1-5]/.exec(lvTxt)[0] : null;
    const ac = /(?:activity|aktivität|tätigkeit)[ \t]*:?[ \t]*([^\n]*)/i.exec(all);
    const act = ac ? avAct(ac[1]) : '';
    const bl = /href\s*=\s*['"](https:\/\/aws\.slf\.ch\/api\/bulletin\/document\/[^'"\s<>]+)['"]/i.exec(rawDesc);
    const caught = numOf(/(?:erfasst|caught)\D{0,20}(\d+)/i), buried = numOf(/(?:verschüttet|buried)\D{0,24}(\d+)/i);
    const dead = numOf(/(?:tote|getötet|todesopfer|killed|dead|fatalities|deaths)\D{0,15}(\d+)/i);
    const known = caught != null || buried != null || dead != null || lvl != null || act;
    out.push({
      d, lat: +lat.toFixed(5), lon: +lon.toFixed(5),
      ele: z != null && z > 200 ? Math.round(z) : numOf(/(?:höhe|elevation|altitude)\D{0,15}(\d{3,4})/i),
      caught, buried, dead, lvl, lv: lvl != null ? lvTxt : '', act,
      bl: bl ? bl[1].replace(/&amp;/g, '&').replace(/\/full\/(en|fr|it)\?/, '/full/de?').slice(0, 200) : '',
      name: /^\s*\d/.test(name) ? '' : name.slice(0, 80), txt: known ? '' : (desc || ext.join('\n')).slice(0, 500),
    });
  }
  return out;
}
async function doAval() {
  if (NOW - state.avAt < 55 * 60e3 && keep('lawinen.json')) { src('lawinen', true, { kept: true }); return; }
  let kml = null, err = null;
  for (const f of ['accidents_season_all_de.kml', 'accidents_season_all_en.kml']) {
    try { const t = await get(URLS.slfAcc + f, { json: false, timeout: 30000 }); if (/<kml|<Document/i.test(t)) { kml = t; break; } } catch (e) { err = e; }
  }
  if (kml == null) throw err || new Error('keine KML-Datei');
  const items = parseKml(kml), now = new Date(NOW);
  // Saison aus den Daten (das SLF stellt die Datei erst nach Saisonbeginn um), sonst aus dem Datum
  const last = items.map((a) => a.d).filter(Boolean).sort().pop();
  const season = last ? seasonOf(+last.slice(0, 4), +last.slice(5, 7)) : seasonOf(now.getUTCFullYear(), now.getUTCMonth() + 1);
  put('lawinen.json', { v: 1, at: iso(NOW), src: 'SLF', season, n: items.length, items });
  state.avAt = NOW;
  src('lawinen', true, { n: items.length });
}

/* ───── Roundshot: Standorte aller Kameras aus der Liste in index.html (wöchentlich) ───── */
const rsUrl = (u) => (ENV.WS_RSBASE ? `${ENV.WS_RSBASE}/${u.replace(/^https:\/\//, '')}settings.min.json` : `${u}settings.min.json`);
async function doRoundshot() {
  if (NOW - state.rsAt < 7 * 864e5 && keep('roundshot.json')) { src('roundshot', true, { kept: true }); return; }
  let html = null;
  for (const f of [path.join(APP, 'index.html'), path.join(APP, 'docs', 'index.html')]) { try { html = fs.readFileSync(f, 'utf8'); break; } catch { /* nächster Ort */ } }
  if (!html) throw new Error('index.html nicht gefunden');
  const m = /<script type="application\/json" id="rs-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('Roundshot-Liste fehlt in index.html');
  const list = JSON.parse(m[1]);
  const prev = new Map(((readJson(path.join(PREV, 'roundshot.json'), {}) || {}).cams || []).map((c) => [c[3], c]));
  const out = [];
  let i = 0, fresh = 0;
  const one = async (c) => {
    const [name, lat0, , url, id0] = c;
    if (typeof url !== 'string' || !/^https:\/\/[a-z0-9-]+\.roundshot\.com\/[\w/.-]*$/.test(url)) return;
    try {
      const j = await get(rsUrl(url), { timeout: 12000 });
      const p = j && j.position;
      const lat = p && p.latitude != null ? +p.latitude : NaN, lon = p && p.longitude != null ? +p.longitude : NaN;
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) {
        const nm = typeof j.name === 'string' && j.name.trim() ? j.name.replace(/\s+/g, ' ').trim().slice(0, 100) : name;
        const id = j.id != null && /^[\w-]{1,64}$/.test(String(j.id)) ? String(j.id) : id0;
        out.push([nm, +lat.toFixed(5), +lon.toFixed(5), url, id]);
        fresh++;
        return;
      }
    } catch { /* alter Stand */ }
    if (prev.has(url)) out.push(prev.get(url)); else if (Number.isFinite(lat0)) out.push(c);
  };
  await Promise.all(Array.from({ length: 8 }, async () => { while (i < list.length) await one(list[i++]); }));
  put('roundshot.json', { v: 1, at: iso(NOW), n: list.length, cams: out });
  state.rsAt = NOW;
  src('roundshot', true, { n: out.length, fresh });
}

/* ───── Geplante Läufe wach halten (GitHub pausiert sie nach 60 Tagen ohne Aktivität) ───── */
async function keepAlive() {
  if (!ENV.GITHUB_TOKEN || NOW - (state.keepAt || 0) < 6 * 864e5) return;
  try {
    const r = await fetch(`${URLS.gh}/repos/${REPO}/actions/workflows/windsack.yml/enable`, { method: 'PUT', headers: { authorization: `Bearer ${ENV.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': UA, 'x-github-api-version': '2022-11-28' } });
    if (r.status < 300) state.keepAt = NOW; else log('Wachhalten:', r.status);
  } catch (e) { log('Wachhalten:', e.message); }
}

/* ───── Ablauf ───── */
const FILES = { alertswiss: ['alerts.json'], swpc: ['aurora.json'], slf: ['slf.json', 'slf-ser.json'], lawinen: ['lawinen.json'], roundshot: ['roundshot.json'] };
const T0 = Date.now();
for (const [k, fn] of [['alertswiss', doAlerts], ['swpc', doAurora], ['quakes', doQuakes], ['slf', doSlf], ['lawinen', doAval], ['roundshot', doRoundshot]]) {
  try {
    // Zeitbudget: die Aktion darf höchstens 9 Minuten laufen – lieber den alten Stand behalten als ganz ausfallen
    if (Date.now() - T0 > 6 * 60e3) throw new Error('Zeitbudget aufgebraucht, alter Stand bleibt');
    await fn();
  } catch (e) {
    log(k, 'Fehler:', e.message);
    src(k, false, { err: String(e.message || e).slice(0, 140) });
    for (const f of FILES[k] || []) keep(f); // alten Stand behalten
  }
}
// Neue Geräte: Bestätigung mit Überblick
for (const s of SUBS) {
  if (state.subs[s.hash]) { state.subs[s.hash].last = NOW; continue; }
  state.subs[s.hash] = { first: NOW, last: NOW };
  const on = [+s.p.a ? 'Alertswiss (alle Meldungen)' : '', +s.p.n ? `Nordlicht (ab Kp ${+s.p.n < 6.5 ? 6 : 7})` : '', +s.p.q ? `Erdbeben ab M ${+s.p.q}` : ''].filter(Boolean);
  (queue.get(s.hash) || queue.set(s.hash, []).get(s.hash)).unshift({
    title: 'Windsack: Mitteilungen eingerichtet',
    body: `Aktiv: ${on.join(', ') || 'keine Auswahl'}.${status.alerts != null ? ` Zurzeit ${status.alerts} Alertswiss-${status.alerts === 1 ? 'Meldung' : 'Meldungen'}` : ''}${status.kp != null ? `, Kp ${status.kp.toFixed(1)}` : ''}.`,
    tag: 'welcome', url: './#/meldungen/alert', ttl: 24 * 3600, prio: 9,
  });
}
for (const h of Object.keys(state.subs)) if (!SUBS.some((s) => s.hash === h)) delete state.subs[h];
// Senden (höchstens 6 Mitteilungen je Gerät und Lauf, sonst 5 und eine Zusammenfassung)
for (const s of SUBS) {
  let list = (queue.get(s.hash) || []).map((m, i) => ({ m, i })).sort((a, b) => (b.m.prio || 0) - (a.m.prio || 0) || a.i - b.i).map((x) => x.m);
  if (list.length > 6) list = [...list.slice(0, 5), { title: 'Windsack', body: `… und ${list.length - 5} weitere Meldungen – in der App unter Meldungen.`, tag: 'more', url: './#/meldungen/alert' }];
  for (const msg of list) {
    try { await sendPush(s, msg); status.push.sent++; delete state.gone[s.hash]; } catch (e) {
      status.push.failed++;
      log('Push an', s.hash, 'fehlgeschlagen:', e.message);
      if (e.status === 404 || e.status === 410) { state.gone[s.hash] = NOW; break; }
    }
  }
}
for (const [h, t] of Object.entries(state.gone)) if (NOW - t > 30 * 864e5 || !SUBS.some((s) => s.hash === h)) delete state.gone[h];
status.subs = SUBS.map((s) => s.hash).filter((h) => !state.gone[h]);
status.gone = Object.keys(state.gone);
await keepAlive();
put('status.json', status);
put('state.json', state);
fs.writeFileSync(path.join(OUT, 'README.md'), `# Windsack · Datenspiegel\n\nAutomatisch erzeugt von \`.github/workflows/windsack.yml\` (letzter Lauf ${iso(NOW)}). Nicht von Hand bearbeiten.\n\nQuellen: Alertswiss (Quelle: www.alertswiss.ch), NOAA SWPC, SLF (CC BY 4.0), Roundshot.\n`);
log(`Lauf ${state.runs}: ${Object.entries(status.src).map(([k, v]) => `${k} ${v.ok ? 'ok' : 'FEHLER'}`).join(', ')} · Geräte ${SUBS.length} · Mitteilungen ${status.push.sent} gesendet, ${status.push.failed} fehlgeschlagen`);
