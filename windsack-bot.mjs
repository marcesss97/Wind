// Windsack-Bot · läuft als GitHub-Aktion (.github/workflows/windsack.yml) alle 10 Minuten.
// – Datenspiegel: Alertswiss, Unwetterwarnungen (MeteoSchweiz), Nordlicht (NOAA SWPC), SLF-Messnetz, Lawinenunfälle, Roundshot-Standorte, Neuschnee-Prognose
//   → JSON-Dateien im Zweig «data» (die App liest sie über raw.githubusercontent.com).
// – Mitteilungen: Web-Push an alle Geräte im Secret WINDSACK_PUSH (Alertswiss, Unwetter, Nordlicht, Erdbeben, Powderalert).
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

/* ───── Alertswiss: Meldungen vereinheitlichen; die betroffenen Gebiete vereinfacht (für die Karte) ───── */
// Linienzug vereinfachen (Douglas–Peucker ohne Rekursion): pts = [[Breite, Länge], …], tol in Grad Breite
function shSimplify(pts, tol) {
  const n = pts.length;
  if (n < 4) return pts;
  const kx = Math.cos((pts[0][0] * Math.PI) / 180), keep = new Uint8Array(n), st = [[0, n - 1]];
  keep[0] = keep[n - 1] = 1;
  while (st.length) {
    const [a, b] = st.pop();
    const ay = pts[a][0], ax = pts[a][1] * kx, dx = pts[b][1] * kx - ax, dy = pts[b][0] - ay, len2 = dx * dx + dy * dy;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const py = pts[i][0], px = pts[i][1] * kx;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > md) { md = d; mi = i; }
    }
    if (mi > 0 && md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// Ein Ring aus der Meldung ([["46.57", "9.23"], …]) → flache Zahlenliste [Breite, Länge, Breite, …]; diag = Ausdehnung in Grad
// maxPts: Obergrenze der Punkte – eine sehr fein gezeichnete Grenze wird gröber, bis sie passt (nie weggelassen)
function shAsRing(coords, maxPts = 1500) {
  const pts = [];
  for (const c of Array.isArray(coords) ? coords : []) {
    const lat = Number(c && c[0]), lon = Number(c && c[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat > 40 && lat < 52 && lon > 0 && lon < 16) pts.push([lat, lon]);
  }
  if (pts.length < 3) return null;
  let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
  for (const [la, lo] of pts) { if (la < la0) la0 = la; if (la > la1) la1 = la; if (lo < lo0) lo0 = lo; if (lo > lo1) lo1 = lo; }
  const diag = Math.hypot(la1 - la0, (lo1 - lo0) * 0.69);
  // Genauigkeit nach Grösse: kleine Sperrzonen auf rund 5 m, ein ganzer Kanton auf rund 150 m
  let tol = Math.max(0.00005, Math.min(0.0013, diag * 0.004)), sim = shSimplify(pts, tol);
  for (let k = 0; k < 12 && sim.length > maxPts; k++) { tol *= 2; sim = shSimplify(pts, tol); }
  if (sim.length < 3) return null;
  const m = diag < 0.05 ? 1e5 : 1e4, flat = [];
  for (const [la, lo] of sim) flat.push(Math.round(la * m) / m, Math.round(lo * m) / m);
  return { flat, diag };
}
// Gebiete einer Meldung: p = Flächen (je [Aussenring, Aussparung, …]), c = Kreise [Breite, Länge, Radius km]
function shAsGeo(areas) {
  const p = [], c = [], polys = [];
  for (const ar of Array.isArray(areas) ? areas : []) {
    for (const pg of Array.isArray(ar && ar.polygons) ? ar.polygons : []) { const o = shAsRing(pg && pg.coordinates); if (o) polys.push({ pg, o }); }
  }
  /* Höchstens 3000 Punkte und 40 Flächen je Meldung. Grosse Flächen zuerst (fällt etwas weg, dann die kleinsten); jede
     Fläche bekommt ihren Anteil am Rest – eine zu feine Grenze wird vereinfacht statt verworfen. */
  polys.sort((a, b) => b.o.diag - a.o.diag);
  if (polys.length > 40) polys.length = 40;
  let budget = 3000;
  polys.forEach(({ pg, o }, i) => {
    const cap = Math.max(8, Math.floor(budget / (polys.length - i)));
    const outer = o.flat.length / 2 > cap ? shAsRing(pg.coordinates, cap) : o;
    if (!outer) return;
    const rings = [outer.flat];
    budget -= outer.flat.length / 2;
    for (const ex of Array.isArray(pg.excludes) ? pg.excludes : []) {
      const h = shAsRing(ex && ex.coordinates, 200);
      if (!h || h.diag < 0.0027 || rings.length >= 12 || budget < h.flat.length / 2) continue; // Aussparungen unter rund 300 m weglassen
      rings.push(h.flat);
      budget -= h.flat.length / 2;
    }
    p.push(rings);
  });
  for (const ar of Array.isArray(areas) ? areas : []) {
    for (const ci of Array.isArray(ar && ar.circles) ? ar.circles : []) {
      const cp = (ci && ci.centerPosition) || [], la = Number(cp[0]), lo = Number(cp[1]), r = Number(ci && ci.radius);
      if (Number.isFinite(la) && Number.isFinite(lo) && la > 40 && la < 52 && lo > 0 && lo < 16 && r > 0 && r < 300 && c.length < 20) c.push([Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5, Math.round(r * 1000) / 1000]);
    }
  }
  return p.length || c.length ? { p, c } : null;
}
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
      geo: a.nationWide ? null : shAsGeo(a.areas),
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

/* ───── Powder: Neuschnee aus der Prognose (App und GitHub-Aktion rechnen gleich) ─────
   Niederschlag (mm) und Temperatur (°C) einer Stunde → cm Neuschnee: unter 0.5 °C fällt alles als Schnee, über 2 °C
   nichts, dazwischen anteilig (wie der Niederschlagstyp der Animationen). Je kälter, desto lockerer der Schnee:
   1 mm Niederschlag ≈ 0.9 cm bei 0 °C, 1.2 cm bei −6 °C, höchstens 1.4 cm. */
const shSnowCm = (mm, T) => {
  if (!(mm > 0) || T == null || T !== T) return 0;
  const frac = T <= 0.5 ? 1 : T >= 2 ? 0 : (2 - T) / 1.5;
  return frac ? mm * frac * Math.max(0.7, Math.min(1.4, 0.9 - 0.05 * T)) : 0;
};
// Referenzorte der ganzen Schweiz: [Name, Gebiet, Breite, Länge, Höhe des Skigeländes in m]
const SH_PW_REG = ['Unterwallis', 'Oberwallis', 'Waadt und Freiburg', 'Berner Oberland', 'Zentralschweiz', 'Glarus und St. Gallen', 'Nordbünden', 'Mittelbünden', 'Engadin und Südtäler', 'Tessin', 'Jura'];
const SH_PW = [
  ['Champéry', 0, 46.18, 6.87, 1800], ['Verbier', 0, 46.10, 7.23, 2200], ['Grosser St. Bernhard', 0, 45.95, 7.21, 2200], ['Ovronnaz', 0, 46.20, 7.17, 2000],
  ['Arolla', 0, 46.03, 7.48, 2400], ['Zinal', 0, 46.13, 7.63, 2300], ['Crans-Montana', 0, 46.31, 7.48, 2100],
  ['Zermatt', 1, 46.02, 7.75, 2500], ['Saas-Fee', 1, 46.11, 7.93, 2400], ['Simplon', 1, 46.25, 8.03, 2100], ['Lötschental', 1, 46.41, 7.80, 2100],
  ['Leukerbad', 1, 46.38, 7.63, 2100], ['Bettmeralp', 1, 46.39, 8.06, 2200], ['Binntal', 1, 46.36, 8.18, 2100], ['Goms', 1, 46.49, 8.26, 2000],
  ['Les Diablerets', 2, 46.35, 7.16, 1900], ['Les Mosses', 2, 46.40, 7.10, 1700], ['Moléson', 2, 46.55, 7.02, 1600], ['Jaun', 2, 46.61, 7.28, 1600],
  ['Gstaad', 3, 46.47, 7.29, 1800], ['Lenk', 3, 46.46, 7.44, 1900], ['Adelboden', 3, 46.49, 7.56, 1900], ['Kandersteg', 3, 46.49, 7.67, 2000],
  ['Diemtigtal', 3, 46.58, 7.50, 1700], ['Gantrisch', 3, 46.71, 7.44, 1600], ['Mürren', 3, 46.56, 7.89, 2100], ['Grindelwald', 3, 46.62, 8.03, 2100],
  ['Hasliberg', 3, 46.74, 8.17, 1900], ['Grimsel', 3, 46.57, 8.33, 2200],
  ['Sörenberg', 4, 46.82, 8.03, 1600], ['Melchsee-Frutt', 4, 46.77, 8.27, 2000], ['Engelberg', 4, 46.82, 8.40, 2000], ['Andermatt', 4, 46.63, 8.59, 2200],
  ['Realp', 4, 46.60, 8.50, 2200], ['Urnerboden', 4, 46.89, 8.90, 1800], ['Stoos', 4, 46.98, 8.66, 1600], ['Hoch-Ybrig', 4, 47.02, 8.79, 1600], ['Rigi', 4, 47.05, 8.48, 1500],
  ['Braunwald', 5, 46.94, 9.00, 1700], ['Elm', 5, 46.92, 9.17, 1800], ['Flumserberg', 5, 47.09, 9.28, 1700], ['Pizol', 5, 46.98, 9.43, 2000],
  ['Wildhaus', 5, 47.20, 9.35, 1600], ['Alpstein', 5, 47.25, 9.32, 1700],
  ['St. Antönien', 6, 46.97, 9.81, 2000], ['Klosters', 6, 46.87, 9.88, 2100], ['Davos', 6, 46.80, 9.84, 2300], ['Arosa', 6, 46.78, 9.68, 2200],
  ['Lenzerheide', 6, 46.73, 9.56, 2100], ['Flims-Laax', 6, 46.84, 9.28, 2200], ['Obersaxen', 6, 46.75, 9.10, 1900], ['Disentis', 6, 46.70, 8.85, 2200], ['Sedrun', 6, 46.68, 8.77, 2100],
  ['Vals', 7, 46.62, 9.18, 2200], ['Safiental', 7, 46.68, 9.32, 2000], ['Savognin', 7, 46.60, 9.60, 2100], ['Bivio', 7, 46.47, 9.65, 2300],
  ['Splügen', 7, 46.55, 9.32, 2100], ['Avers', 7, 46.45, 9.58, 2400], ['San Bernardino', 7, 46.46, 9.19, 2000],
  ['St. Moritz', 8, 46.50, 9.84, 2500], ['Maloja', 8, 46.40, 9.69, 2200], ['Bernina', 8, 46.42, 10.02, 2500], ['Zuoz', 8, 46.60, 9.96, 2300],
  ['Scuol', 8, 46.80, 10.30, 2200], ['Samnaun', 8, 46.94, 10.36, 2300], ['Val Müstair', 8, 46.62, 10.36, 2200], ['Poschiavo', 8, 46.33, 10.06, 2100],
  ['Airolo', 9, 46.53, 8.61, 2000], ['Bedretto', 9, 46.49, 8.47, 2100], ['Bosco Gurin', 9, 46.32, 8.49, 1900], ['Robiei', 9, 46.44, 8.51, 2100],
  ['Campo Blenio', 9, 46.56, 8.94, 1900], ['Carì', 9, 46.50, 8.82, 1900],
  ['Chasseral', 10, 47.13, 7.06, 1400], ['Weissenstein', 10, 47.25, 7.51, 1200], ['Chasseron', 10, 46.85, 6.54, 1300], ['Mont Tendre', 10, 46.60, 6.31, 1400], ['La Dôle', 10, 46.43, 6.10, 1400],
];
const SH_PW_THR = [20, 30, 50]; // wählbare Schwellen in cm je 24 h
// «Powdertag»: Neuschnee von 8 Uhr am Vortag bis 8 Uhr (Schweizer Zeit) – wie die Messung am Morgen.
// tEnd = Ende der Stunde, für die der Wert gilt; Rückgabe JJJJ-MM-TT
const SH_PW_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: SH_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const shPwDay = (tEnd) => SH_PW_FMT.format(tEnd + 16 * 36e5 - 1000);
const shPwNoon = (day) => { const [y, m, d] = String(day).split('-').map(Number); return Date.UTC(y, m - 1, d, 11); };
const SH_PW_WD = new Intl.DateTimeFormat('de-CH', { timeZone: SH_TZ, weekday: 'short' });
const SH_PW_WDL = new Intl.DateTimeFormat('de-CH', { timeZone: SH_TZ, weekday: 'long' });
const SH_PW_DM = new Intl.DateTimeFormat('de-CH', { timeZone: SH_TZ, day: 'numeric', month: 'numeric' });
const shPwWd = (day) => SH_PW_WD.format(shPwNoon(day)).replace('.', '');
const shPwLabel = (day) => `${shPwWd(day)} ${SH_PW_DM.format(shPwNoon(day))}`;
/* Tagessummen eines Orts: keys = Powdertag je Stunde (shPwDay), P mm, T °C, far = Stunden aus dem Ersatzmodell.
   → Map Tag → { cm, n: Stunden mit Wert, far: davon aus dem Ersatzmodell } */
function shPwDays(keys, P, T, far) {
  const out = new Map();
  for (let k = 0; k < keys.length; k++) {
    const p = P[k], t = T[k];
    if (p == null || t == null || p !== p || t !== t) continue;
    const o = out.get(keys[k]) || out.set(keys[k], { cm: 0, n: 0, far: 0 }).get(keys[k]);
    o.cm += shSnowCm(p, t); o.n++;
    if (far && far[k]) o.far++;
  }
  return out;
}
/* Lage je Powdertag. days = Tage, pts = je Ort die cm je Tag (null = keine Angabe), far = je Tag: Fernsicht?
   Ein Powdertag zählt, wenn mindestens zwei Orte die Schwelle erreichen oder einer das Anderthalbfache;
   in der Fernsicht (gröberes Modell, weit voraus) braucht es drei Orte.
   → je Tag { day, far, max, n: Orte ab Schwelle, top: [[Ort, cm], …] (höchstens 6), ok } */
function shPwEvents(days, pts, far, thr) {
  return days.map((day, j) => {
    const all = [];
    pts.forEach((a, i) => { const v = a ? a[j] : null; if (v != null && v === v) all.push([i, v]); });
    all.sort((x, y) => y[1] - x[1]);
    const max = all.length ? all[0][1] : 0, n = all.filter((x) => x[1] >= thr).length, f = !!(far && far[j]);
    const ok = max >= thr && (f ? n >= 3 : n >= 2 || max >= thr * 1.5);
    return { day, far: f, max, n, top: all.slice(0, 6), ok };
  });
}
// Gebiete der stärksten Orte (höchstens drei), z. B. «Oberwallis, Tessin»
function shPwRegions(top, thr) {
  const out = [];
  for (const [i, v] of top) { const r = SH_PW_REG[SH_PW[i][1]]; if (v >= thr && !out.includes(r)) out.push(r); }
  return out.slice(0, 3).join(', ');
}


const ENV = process.env;
const REPO = /^[\w.-]+\/[\w.-]+$/.test(ENV.REPO || '') ? ENV.REPO : ENV.GITHUB_REPOSITORY || 'marcesss97/Wind';
const [OWNER, NAME] = REPO.split('/');
const OUT = ENV.WS_OUT || 'out', PREV = ENV.WS_PREV || 'prev', APP = ENV.WS_APP || 'app';
const NOW = Number(ENV.WS_NOW) || Date.now();
const UA = `Mozilla/5.0 (compatible; Windsack-Bot/11; +https://github.com/${REPO})`;
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
  // Warnungen der MeteoSchweiz: Schnittstelle der MeteoSchweiz-App, je Postleitzahl (öffentlich, ohne Anmeldung)
  msapp: ENV.WS_MSAPP || 'https://app-prod-ws.meteoswiss-app.ch/v1/',
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
const fHour = new Intl.DateTimeFormat('en-GB', { timeZone: SH_TZ, hour: 'numeric', hourCycle: 'h23' });

/* ───── Zustand (im Zweig «data», ohne Abo-Daten) ───── */
const prevState = readJson(path.join(PREV, 'state.json'), null);
const first = !prevState;
const state = Object.assign({ v: 1, runs: 0, seen: {}, quakes: {}, aurora: {}, subs: {}, gone: {}, slfAt: 0, avAt: 0, rsAt: 0, keepAt: 0, pwAt: 0, pwTry: 0, powder: null }, prevState || {});
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
      const p = Object.assign({ a: 1, n: 6.67, q: 0, pw: 0, w: 0, wp: [] }, o.p || {});
      p.wp = Array.isArray(p.wp) ? p.wp.filter((x) => Array.isArray(x) && /^\d{4}$/.test(String(x[0]))).slice(0, 12) : [];
      out.push({ hash, sub: s, pub: o.pub, priv: o.priv, p });
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

/* ───── Powderalert: Neuschnee-Prognose für die ganze Schweiz (alle 3 Stunden) ─────
   Für die Referenzorte (SH_PW, auf Höhe des Skigeländes) Niederschlag und Temperatur aus ICON-CH1/CH2 der MeteoSchweiz
   (5 Tage), danach aus dem Standardmodell von Open-Meteo («Fernsicht», bis 7 Tage). Ein «Powdertag» ist der Neuschnee von
   8 Uhr am Vortag bis 8 Uhr. Gemeldet wird, sobald die Prognose einen Powdertag zeigt (so früh wie möglich), dazu bei
   deutlich mehr Schnee und am Vorabend (Bestätigung oder Rücknahme). */
const PW_M1 = 'meteoswiss_icon_seamless', PW_M2 = 'best_match';
const pwRange = (days) => {
  if (days.length === 1) return shPwLabel(days[0]);
  const run = days.every((d, i) => !i || Math.round((shPwNoon(d) - shPwNoon(days[i - 1])) / 864e5) === 1);
  return run ? `${shPwWd(days[0])}–${shPwWd(days[days.length - 1])}` : days.map(shPwWd).join(', ');
};
const pwPlaces = (e, thr, n = 4) => { const l = e.top.filter((x) => x[1] >= thr); return (l.length ? l : e.top.slice(0, 1)).slice(0, n).map(([i, v]) => `${SH_PW[i][0]} ${Math.round(v)} cm`).join(', '); };
async function doPowder() {
  if (NOW - (state.pwAt || 0) < 170 * 60e3 && keep('powder.json')) { src('powder', true, { kept: true }); return; }
  // nach einem Fehlversuch frühestens in einer halben Stunde wieder (Open-Meteo begrenzt die Abrufe je Adresse)
  if (NOW - (state.pwTry || 0) < 28 * 60e3) { keep('powder.json'); src('powder', false, { err: 'Abruf pausiert nach Fehler' }); return; }
  state.pwTry = NOW;
  const q = `latitude=${SH_PW.map((p) => p[2]).join(',')}&longitude=${SH_PW.map((p) => p[3]).join(',')}&elevation=${SH_PW.map((p) => p[4]).join(',')}`
    + '&hourly=precipitation,temperature_2m&past_days=1&forecast_days=8&timeformat=unixtime&timezone=GMT';
  let j, dual = true;
  try { j = await getRetry(`${URLS.om}?${q}&models=${PW_M1},${PW_M2}`, { timeout: 45000 }, 2); }
  catch (e) {
    if (e.status === 429) throw e;
    log('Powder: Abruf mit zwei Modellen:', e.message, '→ Standardmodell');
    dual = false;
    j = await getRetry(`${URLS.om}?${q}`, { timeout: 45000 }, 2);
  }
  const arr = Array.isArray(j) ? j : [j];
  if (arr.length !== SH_PW.length || !arr[0] || !arr[0].hourly || !Array.isArray(arr[0].hourly.time)) throw new Error((arr[0] && arr[0].reason) || 'unerwartete Antwort');
  const times = arr[0].hourly.time.map((t) => t * 1000); // der Wert gilt für die Stunde vor dem Zeitpunkt – er ist ihr Ende
  const keys = times.map(shPwDay);
  // «morgen» vom Mittag des heutigen Tages aus (NOW + 24 h landet in der Nacht der Zeitumstellung auf übermorgen)
  const today = SH_PW_FMT.format(NOW), tomorrow = SH_PW_FMT.format(shPwNoon(today) + 864e5);
  const per = []; // je Ort: Map Tag → { cm, n, far }
  let any = 0;
  for (const o of arr) {
    const h = (o && o.hourly) || {}, n = times.length;
    const pick = (v) => { const a = h[`${v}_${PW_M1}`] || h[v] || [], b = h[`${v}_${PW_M2}`] || []; return [a, b]; };
    const [p1, p2] = pick('precipitation'), [t1, t2] = pick('temperature_2m');
    const P = new Array(n), T = new Array(n), far = new Array(n);
    for (let k = 0; k < n; k++) {
      const main = p1[k] != null && t1[k] != null;
      P[k] = main ? p1[k] : p2[k] != null && t2[k] != null ? p2[k] : null;
      T[k] = main ? t1[k] : P[k] != null ? t2[k] : null;
      far[k] = !main && P[k] != null;
      if (P[k] != null) any++;
    }
    per.push(shPwDays(keys, P, T, far));
  }
  if (!any) throw new Error('Modell liefert keine Werte');
  // Tage ab morgen, für die mindestens die Hälfte der Orte (fast) alle 24 Stunden hat
  const days = [...new Set(keys)].filter((d) => d > today).sort().filter((d) => per.filter((m) => (m.get(d) || {}).n >= 20).length >= SH_PW.length / 2).slice(0, 7);
  const lead = (d) => Math.round((shPwNoon(d) - shPwNoon(today)) / 864e5);
  const far = days.map((d) => {
    if (!dual) return lead(d) >= 6;
    let f = 0, n = 0;
    for (const m of per) { const o = m.get(d); if (o) { f += o.far; n += o.n; } }
    return n > 0 && f / n > 0.5;
  });
  const pts = per.map((m) => days.map((d) => { const o = m.get(d); return o && o.n >= 20 ? Math.round(o.cm) : null; }));
  put('powder.json', { v: 1, at: iso(NOW), src: 'Open-Meteo', model: dual ? 'ICON-CH1/CH2 der MeteoSchweiz, Fernsicht: Standardmodell von Open-Meteo' : 'Standardmodell von Open-Meteo', days, far, pts });
  state.pwAt = NOW; state.pwTry = 0;
  let top = 0;
  for (const a of pts) for (const v of a) if (v > top) top = v;
  src('powder', true, { days: days.length, max: top });
  // Mitteilungen
  const P = state.powder = state.powder && state.powder.d ? state.powder : { d: {} };
  const hour = +fHour.format(NOW) % 24;
  for (const thr of [...new Set(SUBS.map((s) => +s.p.pw).filter((x) => x > 0))]) {
    const ev = shPwEvents(days, pts, far, thr), fresh = [], better = [];
    let eve = null, gone = null;
    for (const e of ev) {
      const D = P.d[e.day] = P.d[e.day] || {}, cm = Math.round(e.max);
      let st = D[thr], told = false;
      if (e.ok && !st) { st = D[thr] = { cm, t: NOW }; fresh.push(e); told = true; }
      else if (e.ok && st && st.gone) {
        // nach einer Rücknahme wieder in Sicht: einmal neu melden (frühestens nach 5 Stunden, damit es nicht hin und her geht)
        if (!st.back && NOW - st.gone > 5 * 36e5) { st.back = 1; delete st.gone; st.cm = cm; st.t = NOW; fresh.push(e); told = true; }
      } else if (e.ok && st && cm >= st.cm + 15 && cm >= st.cm * 1.4 && NOW - st.t > 5 * 36e5) { better.push({ ...e, was: st.cm }); st.cm = cm; st.t = NOW; told = true; }
      /* Vorabend (ab 16 Uhr) eines angekündigten Powdertags. Rücknahme: sofort, auch wenn die Ankündigung erst wenige
         Stunden alt ist. Nach einer Bestätigung nur noch, wenn die Prognose deutlich nachlässt (unter 80 % der Schwelle
         oder 60 % der angekündigten Menge) – ein Zentimeter hin oder her löst keine Mitteilung aus. Bestätigung:
         einmal – sie entfällt, wenn die Ankündigung selbst keine 6 Stunden alt ist. */
      if (st && e.day === tomorrow && hour >= 16) {
        if (!e.ok) { if (!st.gone && (!st.eve || cm < thr * 0.8 || cm <= st.cm * 0.6)) { st.gone = NOW; gone = { ...e, was: st.cm }; } }
        else if (!st.eve && !st.gone) { st.eve = 1; if (!told && NOW - st.t > 6 * 36e5) eve = { ...e, was: st.cm }; st.cm = cm; } // ab jetzt gilt die bestätigte Menge
      }
    }
    if (first) continue;
    const who = (p) => +p.pw === thr;
    if (fresh.length || better.length) {
      // ein Titel für alle Tage der Liste (Zeitraum und grösste Menge gehören zusammen); der Text beschreibt den ersten Tag
      const list = fresh.length ? fresh : better, e = list[0], max = Math.round(Math.max(...list.map((x) => x.max)));
      const reg = shPwRegions(e.top, thr), ld = lead(e.day);
      const more = list.slice(1).map((x) => ` ${shPwLabel(x.day)}: bis ${Math.round(x.max)} cm (${SH_PW[x.top[0][0]][0]})${x.was ? `, bisher ${x.was} cm` : ''}${x.far && !e.far ? ', Fernsicht' : ''}.`).join('')
        + (fresh.length ? better.map((x) => ` ${shPwLabel(x.day)}: jetzt bis ${Math.round(x.max)} cm (bisher ${x.was} cm).`).join('') : '');
      // der Hinweis auf die Unsicherheit steht am Schluss und darf beim Kürzen nicht wegfallen
      const tail = e.far ? ' Fernsicht, noch unsicher.' : list.some((x) => x.far) ? ' Die Fernsicht ist noch unsicher.' : ld >= 2 ? ` Noch ${ld} Tage – die Prognose wird genauer.` : '';
      push(who, {
        title: `${fresh.length ? 'Powder in Sicht' : 'Powder-Update'}: ${pwRange(list.map((x) => x.day))} ${fresh.length ? '' : 'jetzt '}bis ${max} cm`.slice(0, 90),
        body: (`Neuschnee bis ${SH_PW_WDL.format(shPwNoon(e.day))}morgen (24 h): ${pwPlaces(e, thr)}${reg ? ' – ' + reg : ''}.${e.n > 4 ? ` ${e.n} von ${SH_PW.length} Orten ab ${thr} cm.` : ''}${fresh.length ? '' : ` Bisher angekündigt: ${e.was} cm.`}${more}`).slice(0, 320 - tail.length) + tail,
        tag: 'pw-' + e.day, url: './#/schnee/powder', ttl: 24 * 3600, prio: 1,
      });
    }
    if (eve) push(who, { title: `Powder morgen: bis ${Math.round(eve.max)} cm`, body: `Neuschnee bis morgen früh: ${pwPlaces(eve, thr)}${shPwRegions(eve.top, thr) ? ' – ' + shPwRegions(eve.top, thr) : ''}. Bestätigt von der Prognose von heute Nachmittag.`, tag: 'pw-' + eve.day, url: './#/schnee/powder', ttl: 16 * 3600, prio: 1 });
    if (gone) {
      // die Menge reicht an einzelnen Orten noch, aber nicht mehr an genügend vielen: nicht «kleiner», sondern «vereinzelt»
      const cm = Math.round(gone.max), few = cm >= thr, where = SH_PW[gone.top[0][0]][0];
      push(who, {
        title: few ? 'Powder morgen nur noch vereinzelt' : 'Powder morgen fällt kleiner aus',
        body: few ? `Für ${shPwLabel(gone.day)} erwartet die Prognose nur noch an ${gone.n === 1 ? 'einem Ort' : gone.n + ' Orten'} ${thr} cm oder mehr (${where} ${cm} cm). Angekündigt waren bis ${gone.was} cm.`
          : `Für ${shPwLabel(gone.day)} erwartet die Prognose ${cm >= 1 ? `nur noch bis ${cm} cm (${where})` : 'keinen Neuschnee mehr'} – angekündigt waren ${gone.was} cm.`,
        tag: 'pw-' + gone.day, url: './#/schnee/powder', ttl: 16 * 3600,
      });
    }
  }
  for (const d of Object.keys(P.d)) if (d < today) delete P.d[d];
}

/* ───── Unwetterwarnungen der MeteoSchweiz (alle 30 Minuten) ─────
   Es gibt (noch) keinen offenen Datensatz und keine landesweite Abfrage: Die MeteoSchweiz-App holt die Warnungen je
   Postleitzahl. Abgefragt werden rund 60 Orte in allen Landesteilen (Wallis dichter) und die Orte der Geräte
   («Meine Orte», p.wp). Ergebnis: warnings.json { pts: { PLZ: { n, la, lo, w: [{ t, l, f, to, tx, o }] } } }. */
const WN_PLZ = [
  ['1950', 'Sion', 46.23, 7.36], ['1920', 'Martigny', 46.10, 7.07], ['1870', 'Monthey', 46.25, 6.95], ['1936', 'Verbier', 46.10, 7.23], ['3960', 'Sierre', 46.29, 7.53],
  ['1983', 'Evolène', 46.11, 7.49], ['3961', 'Zinal', 46.13, 7.63], ['3900', 'Brig', 46.32, 7.99], ['3920', 'Zermatt', 46.02, 7.75], ['3906', 'Saas-Fee', 46.11, 7.93],
  ['3954', 'Leukerbad', 46.38, 7.63], ['3918', 'Wiler (Lötschental)', 46.41, 7.78], ['3984', 'Fiesch', 46.40, 8.14], ['3999', 'Oberwald', 46.53, 8.35], ['3907', 'Simplon Dorf', 46.20, 8.06],
  ['1937', 'Orsières', 46.03, 7.15], ['3000', 'Bern', 46.95, 7.45], ['3600', 'Thun', 46.76, 7.63], ['3800', 'Interlaken', 46.69, 7.86], ['3818', 'Grindelwald', 46.62, 8.04],
  ['3780', 'Gstaad', 46.47, 7.29], ['3715', 'Adelboden', 46.49, 7.56], ['3860', 'Meiringen', 46.73, 8.19], ['6000', 'Luzern', 47.05, 8.31], ['6390', 'Engelberg', 46.82, 8.40],
  ['6460', 'Altdorf', 46.88, 8.64], ['6490', 'Andermatt', 46.63, 8.59], ['6430', 'Schwyz', 47.02, 8.65], ['6300', 'Zug', 47.17, 8.52], ['6060', 'Sarnen', 46.90, 8.25],
  ['8000', 'Zürich', 47.38, 8.54], ['8400', 'Winterthur', 47.50, 8.73], ['8200', 'Schaffhausen', 47.70, 8.63], ['8500', 'Frauenfeld', 47.56, 8.90], ['9000', 'St. Gallen', 47.42, 9.37],
  ['9050', 'Appenzell', 47.33, 9.41], ['8750', 'Glarus', 47.04, 9.07], ['7000', 'Chur', 46.85, 9.53], ['7270', 'Davos', 46.80, 9.84], ['7500', 'St. Moritz', 46.50, 9.84],
  ['7550', 'Scuol', 46.80, 10.30], ['7130', 'Ilanz', 46.77, 9.20], ['7742', 'Poschiavo', 46.33, 10.06], ['7435', 'Splügen', 46.55, 9.32], ['6500', 'Bellinzona', 46.19, 9.02],
  ['6900', 'Lugano', 46.00, 8.95], ['6600', 'Locarno', 46.17, 8.80], ['6780', 'Airolo', 46.53, 8.61], ['6850', 'Mendrisio', 45.87, 8.98], ['6535', 'Roveredo', 46.24, 9.13],
  ['1200', 'Genève', 46.20, 6.15], ['1000', 'Lausanne', 46.52, 6.63], ['1860', 'Aigle', 46.32, 6.97], ['1660', 'Château-d\'Œx', 46.47, 7.13], ['1630', 'Bulle', 46.62, 7.06],
  ['1700', 'Fribourg', 46.80, 7.15], ['2000', 'Neuchâtel', 46.99, 6.93], ['2300', 'La Chaux-de-Fonds', 47.10, 6.83], ['2800', 'Delémont', 47.36, 7.34], ['1450', 'Sainte-Croix', 46.82, 6.50],
  ['4000', 'Basel', 47.56, 7.59], ['5000', 'Aarau', 47.39, 8.04], ['4500', 'Solothurn', 47.21, 7.53], ['4410', 'Liestal', 47.48, 7.73], ['8280', 'Kreuzlingen', 47.65, 9.17],
];
const WN_KW = [['Gewitter', /gewitter/i], ['Hitze', /hitze/i], ['Waldbrand', /waldbrand/i], ['Hochwasser', /hochwasser/i], ['Lawinen', /lawine/i],
  ['Strassenglätte', /glätte|glatteis/i], ['Frost', /frost/i], ['Schnee', /schnee/i], ['Wind', /wind|sturm|böen/i], ['Regen', /regen|niederschl/i], ['Trockenheit', /trocken/i]];
const WN_TYPE = { 0: 'Wind', 1: 'Gewitter', 2: 'Regen', 3: 'Schnee', 4: 'Strassenglätte', 5: 'Frost', 7: 'Hitze', 8: 'Lawinen', 10: 'Waldbrand', 11: 'Hochwasser', 13: 'Trockenheit' };
const WN_LVL = { 2: 'mässige Gefahr', 3: 'erhebliche Gefahr', 4: 'grosse Gefahr', 5: 'sehr grosse Gefahr' };
const wnType = (w) => { const k = WN_KW.find(([, re]) => re.test(w.tx || '')); return k ? k[0] : WN_TYPE[w.t] || 'Warnung'; };
// Zeitstempel der App: Sekunden oder Millisekunden (Quellen uneinig) oder ISO-Text
const wnMs = (x) => (x == null || x === '' ? null : typeof x === 'number' ? (x > 1e12 ? x : x * 1000) : /^\d+$/.test(String(x)) ? wnMs(+x) : Date.parse(x) || null);
function wnNorm(w) {
  if (!w || typeof w !== 'object') return null;
  const l = +w.warnLevel;
  if (!(l >= 2 && l <= 5)) return null; // Stufe 1 = keine oder geringe Gefahr
  return { t: Number.isFinite(+w.warnType) ? +w.warnType : null, l, f: wnMs(w.validFrom), to: wnMs(w.validTo), tx: shPlain(w.text || w.htmlText || '').slice(0, 700), o: w.outlook ? 1 : 0 };
}
const fWnT = new Intl.DateTimeFormat('de-CH', { timeZone: SH_TZ, weekday: 'short', hour: '2-digit', minute: '2-digit' });
const wnWhen = (w) => `${w.f && w.f > NOW ? fWnT.format(w.f).replace(',', '') : 'ab jetzt'}${w.to ? ' bis ' + fWnT.format(w.to).replace(',', '') : ''}`;
async function doWarnings() {
  if (NOW - (state.wnAt || 0) < 25 * 60e3 && keep('warnings.json')) { src('warnings', true, { kept: true }); return; }
  const list = new Map(WN_PLZ.map((p) => [p[0], p]));
  for (const s of SUBS) for (const q of s.p.wp || []) if (!list.has(String(q[0])) && list.size < 140) list.set(String(q[0]), [String(q[0]), String(q[1] || q[0]).slice(0, 40), Number.isFinite(+q[2]) ? +q[2] : null, Number.isFinite(+q[3]) ? +q[3] : null]);
  const todo = [...list.values()], out = {};
  let k = 0, ok = 0, fail = 0;
  const worker = async () => {
    while (k < todo.length) {
      const p = todo[k++];
      try {
        const j = await getRetry(`${URLS.msapp}plzDetail?plz=${p[0]}00`, { headers: { 'accept-language': 'de' }, timeout: 20000 }, 2);
        out[p[0]] = { n: p[1], la: p[2], lo: p[3], w: (j && Array.isArray(j.warnings) ? j.warnings : []).map(wnNorm).filter(Boolean) };
        ok++;
      } catch (e) { fail++; if (fail <= 3) log('Warnungen', p[0], e.message); }
      if (!ENV.WS_TEST) await sleep(120);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (!ok) throw new Error('keine Postleitzahl erreichbar');
  put('warnings.json', { v: 1, at: iso(NOW), src: 'MeteoSchweiz', pts: out, fail });
  state.wnAt = NOW;
  let n = 0;
  for (const p of Object.values(out)) n += p.w.filter((w) => !w.o && (!w.to || w.to > NOW)).length;
  src('warnings', true, { plz: ok, fail, n });
  status.warnings = n;

  // Mitteilungen: neue Warnungen und höhere Stufen. Schlüssel je Ort, Art und Beginn; vergangene fallen weg.
  const initial = !state.wn;
  const prev = state.wn || {}, cur = {};
  for (const [plz, p] of Object.entries(out)) for (const w of p.w) {
    if (w.o || (w.to && w.to < NOW)) continue;
    cur[`${plz}|${wnType(w)}|${w.f || 0}`] = { l: w.l };
  }
  for (const [key, v] of Object.entries(prev)) if (!cur[key] && !out[key.split('|')[0]] && (v.at || 0) > NOW - 12 * 36e5) cur[key] = v; // Ort diesmal nicht erreicht: behalten
  for (const s of SUBS) {
    const thr = +s.p.w;
    if (!thr || initial || first) continue;
    const mine = s.p.wp.length ? new Set(s.p.wp.map((x) => String(x[0]))) : null, min = mine ? thr : Math.max(thr, 4);
    const groups = new Map();
    for (const [plz, p] of Object.entries(out)) {
      if (mine && !mine.has(plz)) continue;
      for (const w of p.w) {
        if (w.o || w.l < min || (w.to && w.to < NOW)) continue;
        const key = `${plz}|${wnType(w)}|${w.f || 0}`, was = prev[key];
        if (was && was.l >= w.l) continue;
        const gk = `${wnType(w)}|${w.l}|${w.f || 0}|${w.to || 0}`;
        if (!groups.has(gk)) groups.set(gk, { ty: wnType(w), l: w.l, w, up: !!was, pl: [] });
        groups.get(gk).pl.push(p.n);
      }
    }
    const G = [...groups.values()].sort((a, b) => b.l - a.l);
    if (!G.length) continue;
    const g = G[0], more = G.slice(1).map((x) => ` ${x.ty} Stufe ${x.l}: ${x.pl.slice(0, 3).join(', ')}.`).join('');
    const sentence = (g.w.tx.match(/^[^.!?]{10,220}[.!?]/) || [''])[0];
    push((pp) => pp === s.p, {
      title: `${g.up ? 'Warnung verschärft' : 'Unwetterwarnung'}: ${g.ty} Stufe ${g.l}`.slice(0, 90),
      body: `${g.pl.slice(0, 4).join(', ')}${g.pl.length > 4 ? ` und ${g.pl.length - 4} weitere` : ''}: ${WN_LVL[g.l]}, ${wnWhen(g.w)}.${sentence ? ' ' + sentence : ''}${more}`.slice(0, 600),
      tag: 'wn-' + g.ty + '-' + (g.w.f || 0), url: './#/meldungen/unwetter', ttl: 12 * 3600, urgency: g.l >= 4 ? 'high' : 'normal', prio: g.l >= 4 ? 3 : 1,
    });
  }
  for (const v of Object.values(cur)) if (!v.at) v.at = NOW;
  state.wn = cur;
}

/* ───── Roundshot: Standorte aller Kameras (wöchentlich). Die Liste steht im Skript (nicht in index.html, damit das
   Skript auch läuft, wenn die App verschlüsselt ausgeliefert wird). ───── */
const RS_LIST = [["Pizzo Matro",null,null,"https://pizzomatro.roundshot.com/","1002"],["La Capanna di Gorda",null,null,"https://capannagorda.roundshot.com/","4ee4a6574a7380b18647b0d692573899"],["Brugnasco",null,null,"https://meteoschweiz.roundshot.com/brugnasco/","91423886700a0b8a502ca426cb39a4ef"],["Olivone",null,null,"https://meteoschweiz.roundshot.com/olivone/","154b8a1177e2059dc12ab48b59c6eb9b"],["Monte Tamaro",null,null,"https://monte-tamaro.roundshot.com/","1658"],["San Salvatore",null,null,"https://sansalvatore.roundshot.com/","832"],["Montagnola",null,null,"https://meteoschweiz.roundshot.com/montagnola/","0850ef696d0620bcd1a571772e1693a4"],["Novazzano",null,null,"https://meteoschweiz.roundshot.com/novazzano/","198009c7b44ff37aa1f8de20eda2d460"],["Contra",null,null,"https://albergosanbernardo.roundshot.com/","1422"],["Locarno Madonna del Sasso",null,null,"https://ascona-locarno.roundshot.com/madonnadelsasso/","1420"],["Ascona",null,null,"https://casaberno.roundshot.com/","835"],["Vira",null,null,"https://ascona-locarno.roundshot.com/bellavistahotel/","1418"],["Brissago",null,null,"https://clinicahildebrand.roundshot.com/","855"],["Tenero",null,null,"https://ascona-locarno.roundshot.com/tenero/","1419"],["Ascona",null,null,"https://castello-seeschloss.roundshot.com/","409bc29c520a6dfe89adf1f4e2ff4421"],["Brienzer Rothorn Gipfel",null,null,"https://soerenberg.roundshot.com/rothorn/","620"],["Marbachegg",null,null,"https://marbachegg.roundshot.com/","686"],["Oberried",null,null,"https://florensresort.roundshot.com/","911"],["Gurten",null,null,"https://gurtenpark.roundshot.com/","741"],["Frienisberg",null,null,"https://meteoschweiz.roundshot.com/frienisberg/","cab97a37b7320095c03b0fd3f85faa0f"],["Bern Bellevue Palace",null,null,"https://berntourismus.roundshot.com/hotelbellevuepalace/","128"],["Bern Rosengarten",null,null,"https://berntourismus.roundshot.com/rosengarten/","129"],["Bern Belp",null,null,"https://bernairport.roundshot.com/","1637"],["Grand Signal",null,null,"https://cma.roundshot.com/grandsignal/","16"],["Anzère - Lac de Tseuzier",46.34667,7.43546,"https://lac-de-tseuzier.roundshot.com/","674"],["Anzère",null,null,"https://anzere.roundshot.com/village/","2"],["Crans-Montana",null,null,"https://lhm.roundshot.com/","57"],["Sierre",null,null,"https://sierre-tourisme.roundshot.com/","478"],["Varen",null,null,"https://varen.roundshot.com/","1235"],["Lerchenberg - Sumiswald",null,null,"https://sumiswald.roundshot.com/lerchenberg/","1633"],["Gammenthal - Sumiswald",null,null,"https://sumiswald.roundshot.com/gammenthal/","1713"],["Langnau im Emmental",null,null,"https://langnau.roundshot.com/","1476"],["Etziken",null,null,"https://meteoschweiz.roundshot.com/etziken/","651b0655744f96a67d318fac69e44986"],["St. Chrischona Sendeturm",null,null,"https://meteoschweiz.roundshot.com/stchrischona/","97bd2a5775cffef2bf0b7df3237cf567"],["St. Chrischona Sendeturm",null,null,"https://chrischona.roundshot.com/","687"],["Arlesheim",null,null,"https://hotel-ochsen.roundshot.com/","1358"],["Pratteln",null,null,"https://bussimmobilien.roundshot.com/","943"],["Basel-Riehen",null,null,"https://baeumlihof.roundshot.com/","568"],["Villars - Pt.Chammossaire",null,null,"https://villars.roundshot.com/pt-chamossaire/","71"],["Gryon - Les Chaux",null,null,"https://villars.roundshot.com/leschaux/","694"],["Gryon - Frience",null,null,"https://gryon.roundshot.com/","931"],["Beau Soleil Collège - Villars",null,null,"https://beausoleil.roundshot.com/","11"],["Villars sur Ollon",null,null,"https://aigloncollege.roundshot.com/","514"],["Montreux - Rochers de Naye",null,null,"https://mob.roundshot.com/rochersdenaye/","300"],["Leysin - La Berneuse",null,null,"https://tlml.roundshot.com/","154"],["Leysin Télé - Snowpark",null,null,"https://leysin.roundshot.com/snowpark/","1343"],["Leysin - Les Mosses",null,null,"https://lesmosses.roundshot.com/","182"],["Leysin",null,null,"https://leysin.roundshot.com/tobogganing-park/","966"],["Aigle",null,null,"https://aigle.roundshot.com/","122"],["La Dôle",null,null,"https://meteoschweiz.roundshot.com/ladole/","f5ed3da10e357c11e7eef5075fedada2"],["Vallée de Joux",null,null,"https://valleedejoux.roundshot.com/","413"],["Vallorbe",null,null,"https://vallorbe.roundshot.com/","669"],["Château-d'Oex - La Braye",null,null,"https://telechateaudoex.roundshot.com/la-braye/","377"],["Château-d'Oex",null,null,"https://chax.roundshot.com/","15"],["Château-d'Oex",null,null,"https://meteoschweiz.roundshot.com/chax/","b6924125a999595b9495f8dbf6b8f501"],["La Berra",null,null,"https://laberra.roundshot.com/","945"],["Rathvel",null,null,"https://lespaccots.roundshot.com/rathvel/","573"],["Corbetta",null,null,"https://lespaccots.roundshot.com/corbetta/","572"],["Schwarzsee",null,null,"https://schwarzseetourismus.roundshot.com/","430"],["Greyerz",null,null,"https://lagruyere.roundshot.com/","397"],["Bulle",null,null,"https://bulle.roundshot.com/","822"],["Les Ordons",null,null,"https://juratourisme.roundshot.com/lesordons/","677"],["Saignelégier",null,null,"https://juratourisme.roundshot.com/saignelegier/","36"],["Roche d'Or",null,null,"https://meteoschweiz.roundshot.com/rochedor/","91fdd703112f8738208b5313cb70a18f"],["Bellelay",null,null,"https://bellelay.roundshot.com/","438"],["St-Ursanne",null,null,"https://juratourisme.roundshot.com/st-ursanne/","39"],["Porrentruy",null,null,"https://juratourisme.roundshot.com/porrentruy/","38"],["Delémont",null,null,"https://juratourisme.roundshot.com/delemont-vieille-ville/","1570"],["Tête de Ran",null,null,"https://tete-de-ran.roundshot.com/","184"],["Chaumont",null,null,"https://chaumont.roundshot.com/","62"],["La Brévine",null,null,"https://tailleres.roundshot.com/","63"],["La Chaux-de-Fonds",null,null,"https://lachauxdefonds.roundshot.com/","260"],["Le Locle",null,null,"https://tissot.roundshot.com/","70"],["Les Brenets",null,null,"https://lesbrenets.roundshot.com/","65"],["Uetliberg",null,null,"https://uetliberg.roundshot.com/","78"],["Zürich / Fluntern",null,null,"https://meteoschweiz.roundshot.com/zuerich-fluntern/","c270cf8bd392d14354da2413c38c1b27"],["Zürich Seefeld",null,null,"https://nzz.roundshot.com/","66"],["Zürich Oberstrass",null,null,"https://zuerichtourismus.roundshot.com/zuerichwest/","85"],["Zürich Stadthaus",null,null,"https://zuerichtourismus.roundshot.com/stadthaus/","86"],["Weisshorn",null,null,"https://weisshorn.roundshot.com/","601"],["Brüggerhorn",null,null,"https://brueggerhorn.roundshot.com/","1720"],["Tschuggen",null,null,"https://tschuggen.roundshot.com/","9"],["Arosa Bärenland",null,null,"https://baerenland.roundshot.com/","804"],["Arosa Hof Maran",null,null,"https://hofmaranhotel.roundshot.com/","865"],["Arosa Dorf",null,null,"https://arosadorf.roundshot.com/","1122"],["Parpaner Rothorn",null,null,"https://lenzerheide.roundshot.com/rothorn/","52"],["Urdenfürggli",null,null,"https://lenzerheide.roundshot.com/urdenfuerggli/","53"],["Hörnlihütte",null,null,"https://hoernliberg.roundshot.com/","681"],["Heimberg Parpan",null,null,"https://lenzerheide.roundshot.com/parpan/","257"],["Lenzerheide Lai LHB",null,null,"https://lenzerheide.roundshot.com/talstation/","265"],["Piz Scalottas",null,null,"https://lenzerheide.roundshot.com/pizscalottas/","54"],["Heidbüel",null,null,"https://churwalden.roundshot.com/","1058"],["Alp Stätz",null,null,"https://lenzerheide.roundshot.com/alpstaetz/","51"],["Heidsee-Bargias",null,null,"https://lenzerheide.roundshot.com/bargias/","180"],["Lantsch-Lenz-Alp Bual",null,null,"https://biathlonarena.roundshot.com/","181"],["Lantsch-Lenz",null,null,"https://lantsch-lenz.roundshot.com/","441"],["Laax - Cassons",null,null,"https://laax.roundshot.com/cassons/","2018"],["Segneshuette",null,null,"https://laax.roundshot.com/segneshuette/","1692"],["Mutta Rodunda",null,null,"https://laax.roundshot.com/mutta-rodunda/","48"],["Bargis",null,null,"https://laax.roundshot.com/bargis/","1359"],["La Siala",null,null,"https://laax.roundshot.com/la-siala/","433"],["Vorab Gletscher",null,null,"https://laax.roundshot.com/vorab-gletscher/","49"],["Crap Masegn",null,null,"https://laax.roundshot.com/crap-masegn/","46"],["Berghaus Nagens",null,null,"https://laax.roundshot.com/berghaus-nagens/","47"],["Crap Sogn Gion Plaun",null,null,"https://laax.roundshot.com/crap-sogn-gion-plaun/","45"],["Flims",null,null,"https://laax.roundshot.com/talstation-flims/","42"],["Caumasee",null,null,"https://laax.roundshot.com/caumasee/","365"],["Rheinschlucht - Conn",null,null,"https://laax.roundshot.com/conn/","366"],["Pilatus Kulm Esel",null,null,"https://pilatus.roundshot.com/","155"],["Pilatus Fräkmüntegg",null,null,"https://pilatus.roundshot.com/fraekmuentegg/","1655"],["Kirchfeld",null,null,"https://kirchfeld.roundshot.com/","1322"],["Stans",null,null,"https://ksnw.roundshot.com/","559"],["Buochs",null,null,"https://buochs.roundshot.com/","140"],["Luzern-Emmen",null,null,"https://luzerntourismus.roundshot.com/luzern-spital/","1722"],["Luzern",null,null,"https://hoteldesbalances.roundshot.com/","826"],["Luzern",null,null,"https://sgv.roundshot.com/","55"],["Luzern",null,null,"https://luzerntourismus.roundshot.com/","56"],["Weggis",null,null,"https://weggis.roundshot.com/","279"],["Eich",null,null,"https://meteoschweiz.roundshot.com/eich/","a295712845effaeb22d20e91c26bb229"],["Ruswil",null,null,"https://ruswil.roundshot.com/","1393"],["Wolhusen",null,null,"https://luks-wolhusen.roundshot.com/","516"],["Bougnonne - Ovronnaz Télé",null,null,"https://ovronnaz.roundshot.com/bougnonne/","165"],["Lac Derborence",null,null,"https://refugederborence.roundshot.com/","876"],["Sion Flugplatz",null,null,"https://sionairport.roundshot.com/","518"],["Mont Noble",null,null,"https://nax.roundshot.com/mont-noble/","1922"],["Trabanta",null,null,"https://thyon.roundshot.com/trabanta/","1336"],["Snowpark - Thyon",null,null,"https://thyon.roundshot.com/snowpark/","1464"],["Vernamiège Village",null,null,"https://nax.roundshot.com/vernamiege/","1638"],["Mase - Nax",null,null,"https://nax.roundshot.com/mase/","5f091ff24c1650821d092ed580ffd64f"],["Nax",null,null,"https://nax.roundshot.com/nax/","1456"],["Torrent Leukerbad Rinderhütte",null,null,"https://meteoschweiz.roundshot.com/torrent/","231fe500e92b21cef9efa925e3320215"],["Leukerbad",null,null,"https://leukerbad.roundshot.com/thermalbad/","ca47a7f49b58ad346731604cf81cbb4c"],["Leukerbad-Skilift Erli",null,null,"https://leukerbad.roundshot.com/erli/","1764"],["Albinen",null,null,"https://albinen.roundshot.com/","1123"],["Leuk",null,null,"https://leuk.roundshot.com/dorf/","1762"],["Grindij - Gampel-Bratsch",null,null,"https://jeizinen.roundshot.com/","1552"],["Eischoll - Stryggen",null,null,"https://eischoll.roundshot.com/stryggen/","1287"],["Eischoll - Dorf",null,null,"https://eischoll.roundshot.com/dorf/","1286"],["Turtmann Damm",null,null,"https://turtmanntal.roundshot.com/","1412"],["Hohsaas",null,null,"https://hohsaas.roundshot.com/3200/","336"],["Hohsaas Kreuzboden",null,null,"https://hohsaas.roundshot.com/kreuzboden/","705"],["Staumauer Mattmark",null,null,"https://saastal.roundshot.com/mattmark/","1566"],["Saas-Fee Dorf",null,null,"https://saastal.roundshot.com/dorf/","1323"],["Grande Dixence SA - Barrage",null,null,"https://grande-dixence.roundshot.com/barrage/","1415"],["Arolla",null,null,"https://evoleneregion.roundshot.com/arolla/","1187"],["Evolène",null,null,"https://evoleneregion.roundshot.com/evolene/","586"],["Evolène / Villa",null,null,"https://meteoschweiz.roundshot.com/evolene-villa/","be41fd9e72c7b86acf57f07968440365"],["Matterhorn Gletscher",null,null,"https://zbag.roundshot.com/matterhornglacierparadise/","17995d1350ece1b2780e44a0740cfeb4"],["Trockener Steg",null,null,"https://zbag.roundshot.com/trockener-steg/","bdf96ad83f0ce659dd66684504de9375"],["Hirli",null,null,"https://zbag.roundshot.com/hirli/","64b67dd1fb5e30b3381de76f4d845c27"],["Schwarzsee",null,null,"https://zbag.roundshot.com/schwarzsee/","9721d3939f658d1e7212acaabdf35e86"],["Riffelberg",null,null,"https://zbag.roundshot.com/riffelberg/","95c34213e0ff0849bdd16b5a33fcaae7"],["Hohtälli",null,null,"https://zermatt.roundshot.com/hohtaelli/","4a19df9977b310d996c39cabb1cf6907"],["Gornergrat",null,null,"https://zermatt.roundshot.com/gornergrat/","4bf959d18548267b6c0333ed89096923"],["Rothorn",null,null,"https://zbag.roundshot.com/rothorn/","052cf992a17faeeca3f71114b049455c"],["Monte Rosa",null,null,"https://zermatt.roundshot.com/monterosa/","0a2a2a5d1d27a9e07b4f7250613836ed"],["Blauherd",null,null,"https://zbag.roundshot.com/blauherd/","01a69f01925995d33e430600621cfa19"],["Riffelberg",null,null,"https://matterhorngotthardbahn.roundshot.com/riffelberg/","1591"],["Niederhorn-Beatenberg",null,null,"https://niederhornbahn.roundshot.com/","728"],["Heiligenschwendi",null,null,"https://rehabern.roundshot.com/","665"],["Heiligenschwendi",null,null,"https://meteoschweiz.roundshot.com/heiligenschwendi/","56e5e551c7a36cff8e8c3df5f9f4375e"],["Spiez Bucht",null,null,"https://buchtspiez.roundshot.com/","1522"],["Gunten",null,null,"https://schoenberg.roundshot.com/","1657"],["Merligen",null,null,"https://beatuswellness.roundshot.com/","1337"],["Mönchsjochhütte",null,null,"https://moenchsjochhuette.roundshot.com/","f28a2aaab9c3a968e8fad16ae897fc48"],["Jungfraujoch",null,null,"https://jungfrau.roundshot.com/top-of-europe-jungfraujoch/","584c8f65bd7b360eed6ffd43226cca8a"],["Jungfraujoch Ostgrat",null,null,"https://jungfrau.roundshot.com/top-of-europe-jungfrau-ostgrat/","dbb5da2713c66505f2004b60c6c56609"],["Lauberhorn",null,null,"https://jungfrau.roundshot.com/lauberhorn/","527f953c3776c0552355d4a154c2b4e8"],["Eigergletscher",null,null,"https://jungfrau.roundshot.com/eigergletscher/","486d6b1c471c581a99233dc3e4cc3ab7"],["Eigerexpress Mast 4",null,null,"https://jungfrau.roundshot.com/top-of-europe-eiger-express/","8ebf876ae226aa03b0c65b0985e6f60e"],["Schilthorn - Birg",null,null,"https://schilthorn.roundshot.com/birg/","428"],["Schilthorn - Allmendhubel",null,null,"https://schilthorn.roundshot.com/allmendhubel/","429"],["Oeschinensee Rodelbahn Sommer",null,null,"https://oeschinensee.roundshot.com/rodelbahn-sommer/","3f460408ade1f3bc47e1b91e36923152"],["Oeschinensee Rodelbahn Winter",null,null,"https://oeschinensee.roundshot.com/rodelbahn-winter/","1be90ee9feae91ceaebe38c2339d2040"],["Mürren",null,null,"https://hoteledelweiss.roundshot.com/","31"],["Oeschinensee Berghotel",null,null,"https://oeschinensee.roundshot.com/berghotel/","838"],["Kandersteg Langlaufzentrum",null,null,"https://kandersteg.roundshot.com/","1061"],["Mittellegihütte",null,null,"https://grindelwald.roundshot.com/mittellegihuette/","8989932c38d693b067f00aa335b042ad"],["Faulhorn",null,null,"https://faulhorn.roundshot.com/","7823d0baddb829dad0ccc55bf912afe7"],["Männlichen Bergstation",null,null,"https://maennlichen.roundshot.com/","877919abdb23eb59f63908ab8b300f1f"],["Grindelwald First",null,null,"https://jungfrau.roundshot.com/first-schreckfeld/","c7f0edeec13d52b6c3cf91485d982548"],["Bäregg",null,null,"https://baeregg.roundshot.com/","1726"],["Pfingstegg",null,null,"https://pfingstegg.roundshot.com/","416"],["Grindelwald",null,null,"https://kirchbuehl.roundshot.com/","41"],["Grindelwald",null,null,"https://kreuz.roundshot.com/grindelwald/","1699"],["Grindelwald",null,null,"https://belvederegrindelwald.roundshot.com/","483"],["Schynige Platte",null,null,"https://jungfrau.roundshot.com/schynige-platte/","9e425745e5de8732e6417c934111cb09"],["Harder Kulm Interlaken",null,null,"https://jungfrau.roundshot.com/harderkulm/","740"],["Talstation - Wengen",null,null,"https://wengen-tourismus.roundshot.com/talstation/","1636"],["Wengen",null,null,"https://bellevue.roundshot.com/","12"],["Interlaken",null,null,"https://casinointerlaken.roundshot.com/","1346"],["Grindelwald Bussalp",null,null,"https://grindelwaldbus.roundshot.com/","c2f9e6ae46be1e54e574fe3a6572f176"],["Axalp Windegg",null,null,"https://axalp.roundshot.com/windegg/","1192"],["Grimsel Oberaar",null,null,"https://grimselwelt.roundshot.com/oberaar/","1532"],["Grimsel Hospiz",null,null,"https://meteoschweiz.roundshot.com/grimselhospiz/","0f70fbf35450a1edf06933d30791b4f3"],["Grimsel Hospiz",null,null,"https://grimselwelt.roundshot.com/hospiz/","1400"],["Grimsel Gelmersee",null,null,"https://grimselwelt.roundshot.com/gelmersee/","1533"],["Grimsel Triftbahn",null,null,"https://grimselwelt.roundshot.com/triftbahn/","1401"],["Planplatten-Alpen Tower",null,null,"https://alpentower.roundshot.com/","439"],["Käserstatt",null,null,"https://kaeserstatt.roundshot.com/","364"],["Mägisalp",null,null,"https://maegisalp.roundshot.com/","124"],["Hasliberg Rehaklinik",null,null,"https://rehaklinik-hasliberg.roundshot.com/","1630"],["Reichenbachfall",null,null,"https://grimselwelt.roundshot.com/reichenbachfall/","1531"],["Murten",null,null,"https://morat.roundshot.com/","59"],["Cudrefin",null,null,"https://cudrefin.roundshot.com/","1995"],["Avenches",null,null,"https://avenches.roundshot.com/camping-plage/","376"],["Faoug",null,null,"https://hafen-faoug.roundshot.com/","494"],["Neuchâtel-Lac",null,null,"https://lacdeneuchatel.roundshot.com/","411"],["Neuchâtel",null,null,"https://neuchatel.roundshot.com/","264"],["Neuchâtel",null,null,"https://jeunesrives.roundshot.com/","716"],["Heiden",null,null,"https://heiden.roundshot.com/","30"],["Schönenbühl",null,null,"https://gefluegelhof.roundshot.com/schoenenbuehl/","1266"],["Rorschacherberg",null,null,"https://computechnic.roundshot.com/","17"],["Romanshorn",null,null,"https://romanshorn.roundshot.com/","1405"],["Rheinspitz",null,null,"https://hafenamrheinspitz.roundshot.com/","456"],["Altenrhein",null,null,"https://lszr.roundshot.com/","930"],["Wiler Turm",null,null,"https://wilerturm.roundshot.com/","254"],["Napoleon Turm",null,null,"https://napoleonturm.roundshot.com/","c09ffa443f1e781c88614e689ac01436"],["Lustdorf",null,null,"https://lustdorf.roundshot.com/","1"],["Sitterdorf",null,null,"https://erlebnisflugplatz.roundshot.com/","821"],["Erlen",null,null,"https://erlengolf.roundshot.com/","1642"],["Frauenfeld",null,null,"https://meteoschweiz.roundshot.com/frauenfeld/","10c2f99ed616664f01e657d79ed52b52"],["Säntis",null,null,"https://saentis.roundshot.com/","156"],["Kronberg",null,null,"https://kronberg.roundshot.com/gipfel/","1272"],["Ebenalp",null,null,"https://ebenalp.roundshot.com/","724"],["Schwägalp",null,null,"https://saentis.roundshot.com/schwaegalp/","1130"],["Wolzenalp",null,null,"https://wolzenalp.roundshot.com/","796"],["Kronberg Tal",null,null,"https://kronberg.roundshot.com/talstation/","1275"],["Chäserrugg",null,null,"https://chaeserrugg.roundshot.com/","75"],["Gamsalp",null,null,"https://wildhaus.roundshot.com/gamsalp/","663"],["Zinggen",null,null,"https://alpsellamatt.roundshot.com/zinggen/","651"],["Alp Sellamatt",null,null,"https://alpsellamatt.roundshot.com/","650"],["Wildhaus Gamplüt",null,null,"https://berghausgampluet.roundshot.com/","652"],["Iltios",null,null,"https://iltios.roundshot.com/","633"],["Wildhaus Oberdorf",null,null,"https://wildhaus.roundshot.com/oberdorf/","649"],["Biberlichopf Schänis",null,null,"https://linthairservice.roundshot.com/","1139"],["Mollis",null,null,"https://esaf2025.roundshot.com/","1641"],["Weesen",null,null,"https://dean-le-baron.roundshot.com/weesen/","2012"],["Näfels",null,null,"https://konditoreimueller.roundshot.com/","1395"],["Murg",null,null,"https://meteoschweiz.roundshot.com/murg/","d636f1f375860e390eaf3f9ce52938e5"],["Leist",null,null,"https://flumserberg.roundshot.com/leist/","1443"],["Prodkamm",null,null,"https://flumserberg.roundshot.com/prodkamm/","1486"],["Stelligrat",null,null,"https://flumserberg.roundshot.com/stelligrat/","2004"],["Andermatt-Gemsstock",null,null,"https://andermatt-sedrun.roundshot.com/gemsstock/","331"],["Gütsch, Andermatt",null,null,"https://andermatt-sedrun-disentis.roundshot.com/guetsch/","1767"],["Gütsch, Andermatt",null,null,"https://meteoschweiz.roundshot.com/guetsch/","973478c91b7b426981ea9278bb2e6d68"],["Andermatt-Bäzberg",null,null,"https://andermatt.roundshot.com/baezberg/","5"],["Andermatt-Golfplatz",null,null,"https://andermatt.roundshot.com/golfplatz/","648"],["Andermatt-Dorf",null,null,"https://andermatt.roundshot.com/city/","701"],["Schneehüenerstock",null,null,"https://andermatt-sedrun-disentis.roundshot.com/schneehuenerstock/","1768"],["Cuolm da Vi",null,null,"https://disentis.roundshot.com/cuolmdavi/","1076"],["Bostgas Cuolm",null,null,"https://andermatt.roundshot.com/bostgas/","1347"],["Gendusa",null,null,"https://disentis.roundshot.com/gendusa/","1077"],["Caischavedra",null,null,"https://disentis.roundshot.com/caischavedra/","1078"],["Disentis",null,null,"https://klosterdisentis.roundshot.com/","507"],["Disentis",null,null,"https://meteoschweiz.roundshot.com/disentis/","41458b07cbbfa020ac5f65d5ed0dda5e"],["Lumnezia Davos Munts",null,null,"https://lumnezia.roundshot.com/badesee/","779"],["Brigels",null,null,"https://golfbrigels.roundshot.com/","1271"],["Camuns",null,null,"https://lumnezia.roundshot.com/camuns/","873"],["Adliswil Felsenegg",null,null,"https://laf.roundshot.com/","467"],["Wetzikon",null,null,"https://gzo.roundshot.com/","24"],["Rapperswil",null,null,"https://knieskinderzoo.roundshot.com/","1126"],["Les Rasses",null,null,"https://yverdon.roundshot.com/lesrasses/","506"],["La Robella",null,null,"https://larobella.roundshot.com/","714"],["Yverdon-Les-Bains",null,null,"https://meteoschweiz.roundshot.com/yverdon-les-bains/","0f98b0b18a7966340b8a9d58ee5c3666"],["Cheyres-Chables Port",null,null,"https://cheyreschables.roundshot.com/","1887"],["Yverdon",null,null,"https://yverdon.roundshot.com/ville/","482"],["Montreux - Les Pleiades",null,null,"https://montreux.roundshot.com/pleiades/","1284"],["Mont Pèlerin Sendemast",null,null,"https://meteoschweiz.roundshot.com/montpelerin/","b6776a9a6304f02b4252425e836c13a8"],["Chexbres",null,null,"https://chexbres.roundshot.com/","481"],["La Tour-de-Peilz",null,null,"https://latourdepeilz.roundshot.com/","519"],["Vevey",null,null,"https://msap.roundshot.com/","60"],["Montreux",null,null,"https://montreux.roundshot.com/","360"],["Lausanne",null,null,"https://epfl.roundshot.com/","2c3a63ce6e913dce53e5006efafafa7e"],["Lutry",null,null,"https://lutry.roundshot.com/","1435"],["Morges",null,null,"https://morgesregion.roundshot.com/","348"],["Aéroclub Genève",null,null,"https://aeroclub-geneve.roundshot.com/","1477"],["Vengeron",null,null,"https://vengeron.roundshot.com/","405"],["Coppet",null,null,"https://coppet.roundshot.com/","576"],["Nyon",null,null,"https://nyon-tourisme.roundshot.com/","401"],["Sommet de Grand-Conche",null,null,"https://portesdusoleil.roundshot.com/","215"],["Morgins - La Foilleuse",null,null,"https://pds-ch.roundshot.com/morgins/","1070"],["Morgins - Champoussin",null,null,"https://pds-ch.roundshot.com/champoussin/","1882"],["Les Crosets",null,null,"https://pds-ch.roundshot.com/lescrosets/","667"],["Morgins - Dents du Midi",null,null,"https://morgins.roundshot.com/","1229"],["Champéry Village",null,null,"https://champery.roundshot.com/","1226"],["Troistorrents",null,null,"https://troistorrents.roundshot.com/","1554"],["Lac d'Emosson",null,null,"https://valleedutrient.roundshot.com/emosson/","875"],["Lac de Salanfe",null,null,"https://valleedutrient.roundshot.com/salanfe/","1110"],["Trient",null,null,"https://valleedutrient.roundshot.com/trient/","891"],["Marécottes La Creusaz",null,null,"https://valleedutrient.roundshot.com/telemarecottes/","802"],["Ravoire",null,null,"https://meteoschweiz.roundshot.com/ravoire/","acbdefc4ab9401cd8ae0c16b3d25aa58"],["Vernayaz",null,null,"https://valleedutrient.roundshot.com/vernayaz/","892"],["Col des Gentianes",null,null,"https://nendaz.roundshot.com/coldesgentianes/","1348"],["Plan du Fou",null,null,"https://nendaz.roundshot.com/plandufou/","1216"],["Greppon Blanc",null,null,"https://nendaz.roundshot.com/greppon-blanc/","1069"],["Combatseline",null,null,"https://nendaz.roundshot.com/combatseline/","1214"],["Lac de Tracouet",null,null,"https://nendaz.roundshot.com/lacdetracouet/","1257"],["Tracouet Arrivée",null,null,"https://nendaz.roundshot.com/arriveetracouet/","1213"],["Prarion-Balavaud",null,null,"https://nendaz.roundshot.com/prarion-balavaud/","1276"],["Siviez",null,null,"https://nendaz.roundshot.com/siviez/","1218"],["Mont Fort",null,null,"https://verbier.roundshot.com/montfort/","1132"],["Les Attelas",null,null,"https://verbier.roundshot.com/les-attelas/","1473"],["Fontanets",null,null,"https://verbier.roundshot.com/fontanets/","1378"],["Savoleyres",null,null,"https://verbier.roundshot.com/savoleyres/","1022"],["Croix de Coeur",null,null,"https://verbier.roundshot.com/croix-de-coeur/","1569"],["Verbier",null,null,"https://lecarrefour.roundshot.com/","50"],["Tzoumaz",null,null,"https://verbier.roundshot.com/tzoumaz/","1311"],["Champex - La Breya",null,null,"https://saint-bernard.roundshot.com/champex-la-breya/","1562"],["La Fouly",null,null,"https://saint-bernard.roundshot.com/lafouly/","1561"],["La Vuardette",null,null,"https://lavuardette.roundshot.com/","1119"],["Oberwald",null,null,"https://obergoms.roundshot.com/oberwald/","704"],["Ulrichen",null,null,"https://obergoms.roundshot.com/ulrichen/","703"],["Grächen Seetalhorn",null,null,"https://graechen.roundshot.com/seetal/","1485"],["Grächen Furggen",null,null,"https://graechen.roundshot.com/furggen/","1482"],["Grächen Hannigalp",null,null,"https://graechen.roundshot.com/hannigalp/","1498"],["Gspon - Staldenried",null,null,"https://gspon.roundshot.com/","1128"],["Stalden",null,null,"https://gemeindestalden.roundshot.com/","304"],["Zermatt",null,null,"https://zermatt.roundshot.com/zermatterhof/","2c35670bc04a525fa1b912728ae463b8"],["Täsch",null,null,"https://zermatt.roundshot.com/taesch/","db525e5462a2414abd7500e07aa08d51"],["Täsch Schalisee",null,null,"https://zermatt.roundshot.com/langlaufloipe-schalisee/","5514e78b52ba9078816367129d5b27f3"],["Täsch Golf Club",null,null,"https://zermatt.roundshot.com/golf-club-matterhorn/","c0b638cd54de03899f68d3c9fd18a51a"],["Randa",null,null,"https://zermatt.roundshot.com/randa/","3f43d703172868cc5068fdfa7ef67892"],["Bellwald Furggulti",null,null,"https://bellwaldtourismus.roundshot.com/furggulti/","1234"],["Fiescheralp - Kühboden",null,null,"https://aletschbahnen.roundshot.com/kuehboden/","1392"],["Bellwald Fleschen",null,null,"https://bellwaldtourismus.roundshot.com/fleschen/","1231"],["Bellwald Talstation",null,null,"https://bellwaldtourismus.roundshot.com/baustelle-talstation/","1184"],["Fiesch Dorf",null,null,"https://fiesch.roundshot.com/","1371"],["Belalp-Hohbiel",null,null,"https://belalp.roundshot.com/hohbiel/","384"],["Belalp Aletschbord",null,null,"https://belalp.roundshot.com/aletschbord/","1548"],["Hübschhorn",null,null,"https://brigtourismus.roundshot.com/huebschhorn/","2011"],["Rothwald",null,null,"https://brigtourismus.roundshot.com/rothwald/","1345"],["Simplonpass",null,null,"https://brigtourismus.roundshot.com/simplonpass/","1344"],["Rosswald",null,null,"https://meteoschweiz.roundshot.com/rosswald/","a11269e1a6467827804a2b9b376f8a4d"],["Gondo",null,null,"https://brigtourismus.roundshot.com/gondo/","1724"],["Brig Stockalperschloss",null,null,"https://brigtourismus.roundshot.com/stockalperschloss/","1520"],["Albigna",null,null,"https://bregagliaturismo.roundshot.com/albigna/","1338"],["Aela",null,null,"https://bregagliaturismo.roundshot.com/aela/","1339"],["Casaccia",null,null,"https://meteoschweiz.roundshot.com/casaccia/","99f8432605e4223f39b635085b7c6540"],["Soglio",null,null,"https://bregagliaturismo.roundshot.com/soglio/","1375"],["St. Moritz",null,null,"https://elparadiso.roundshot.com/","844"],["St. Moritz",null,null,"https://schweizerhof.roundshot.com/stmoritz/","1649"],["Sils-Segl",null,null,"https://sils.roundshot.com/","246"],["Celerina",null,null,"https://crestapalace.roundshot.com/","474"],["Samedan",null,null,"https://engadin-airport.roundshot.com/","473"],["Zuoz",null,null,"https://zuozgemeinde.roundshot.com/","495"],["Zuoz Golfplatz",null,null,"https://zuozgemeinde.roundshot.com/golfplatz/","1298"],["Ftan",null,null,"https://engadin.roundshot.com/ftan/","1208"],["Ardez",null,null,"https://engadin.roundshot.com/ardez/","1135"],["Sent",null,null,"https://engadin.roundshot.com/sent/","1209"],["Tarasp",null,null,"https://engadin.roundshot.com/tarasp/","1134"],["Scuol",null,null,"https://belvedere.roundshot.com/","123"],["Gemmipass",null,null,"https://gemmi.roundshot.com/","23"],["Engstligenalp",null,null,"https://engstligenalp.roundshot.com/","1555"],["Tschentenalp",null,null,"https://tschentenalp.roundshot.com/","1376"],["Gemmi Sunnbuel",null,null,"https://sunnbuel.roundshot.com/","1553"],["Höchstbahn",null,null,"https://adelbodenlenk.roundshot.com/hoechstbahn/","2002"],["Sunnbuel Spittelmatte",null,null,"https://sunnbuel-spittelmatte.roundshot.com/","2085"],["Hotel Alpenland Lauenen",null,null,"https://alpenland-lauenen.roundshot.com/","1612"],["Gstaad Palace",null,null,"https://palacegstaad.roundshot.com/","1708"],["Gstaad-Flugplatz",null,null,"https://gstaad-airport.roundshot.com/","671"],["Saanenmöser Golf",null,null,"https://golfclubgstaadsaanenland.roundshot.com/","1709"],["Saanenmöser Hornberg",null,null,"https://romantikhotelhornberg.roundshot.com/","840"],["Saanen",null,null,"https://huusgstaad.roundshot.com/","581"],["Betelberg Leiterli",null,null,"https://lenk.roundshot.com/leiterlimasten/","1313"],["Flugplatz St. Stephan",null,null,"https://airportststephan.roundshot.com/","1481"],["Weissenstein",null,null,"https://ga-weissenstein.roundshot.com/weissenstein/","c938a8cb046332a53e7576d95f81c4c0"],["Passwang",null,null,"https://passwang.roundshot.com/muemliswil-ramiswil/","1961"],["Reigoldswil",null,null,"https://wasserfallenbahn.roundshot.com/","292"],["Roggenberg",null,null,"https://roggenberg.roundshot.com/","22"],["Solothurn",null,null,"https://ga-weissenstein.roundshot.com/solothurn/","166cab66d87ffb78bb8b3851f0e8a243"],["Hafen Solothurn",47.19769,7.52395,"https://solothurntourismus.roundshot.com/hafen/","965"],["Chasseral",null,null,"https://hotel-chasseral.roundshot.com/","2084"],["Mont Soleil",null,null,"https://montsoleil.roundshot.com/","696"],["Golf Club Les Bois",null,null,"https://juratourisme.roundshot.com/golfclub-les-bois/","1617"],["Bözingenberg",null,null,"https://boezingenberg.roundshot.com/","280"],["Sauge - Plagne",null,null,"https://plagne.roundshot.com/","627"],["Biel",null,null,"https://esb.roundshot.com/","713"],["Grenchen",null,null,"https://fliegen.roundshot.com/","21"],["Schauenberg",null,null,"https://schauenberg.roundshot.com/","646"],["Maiengarten",null,null,"https://maiengarten.roundshot.com/","58"],["Winterthur Roter Turm",null,null,"https://winterthur.roundshot.com/roterturm/","738"],["Dübendorf",null,null,"https://sportzentrum-zurich.roundshot.com/","1714"],["Brambrüesch",null,null,"https://brambruesch.roundshot.com/","587"],["Hochwang-Triemel",null,null,"https://hochwang.roundshot.com/triemel/","1321"],["Chur",null,null,"https://ksgr.roundshot.com/","151"],["Landquart",null,null,"https://meteoschweiz.roundshot.com/landquart/","beabc9f0a0300ebf4d4950a6e2a2454a"],["Splügenpass",null,null,"https://meteoschweiz.roundshot.com/spluegenpass/","0a44ccbebbf9db3db2a90d40eb524440"],["Bivio",null,null,"https://meteoschweiz.roundshot.com/bivio/","cb8bd98d6d05de26c705f899bc6301f8"],["Glacier 3000 Peak Walk",null,null,"https://glacier3000.roundshot.com/","153"],["Glacier 3000 - Cabane",null,null,"https://glacier3000.roundshot.com/cabane/","1293"],["Meilleret",null,null,"https://villars.roundshot.com/meilleret/","72"],["Les Mazots",null,null,"https://villars.roundshot.com/lesmazots/","242"],["Refuge Solalex",null,null,"https://refugesolalex.roundshot.com/","1340"],["Les Diablerets",null,null,"https://ecole-suisse-de-ski-diablerets.roundshot.com/","1301"],["Bonistock",null,null,"https://bonistock.roundshot.com/","160"],["Melchsee Frutt See",null,null,"https://melchseefrutt.roundshot.com/see/","1567"],["Melchsee Frutt",null,null,"https://melchseefrutt.roundshot.com/","161"],["Kaiserstuhl",null,null,"https://meteoschweiz.roundshot.com/kaiserstuhl-nordost/","8bd6006d00d876e53b7bc49e30870dba"],["Rigi Kulm",null,null,"https://rigi.roundshot.com/","901"],["Rotenflue",null,null,"https://rotenfluebahn.roundshot.com/rotenflue/","991f8e4609c334b2ae2077d2e2602d60"],["Sattel-Hochstuckli",null,null,"https://sattel.roundshot.com/","1600"],["Morschach",null,null,"https://shp.roundshot.com/","163"],["Goldau",null,null,"https://meteoschweiz.roundshot.com/goldau/","2b45c86d51b7d2670d2ddd8c815c0ef1"],["Wildspitz",null,null,"https://wildspitz.roundshot.com/","379"],["Menzingen",null,null,"https://menzingen.roundshot.com/","969"],["Zug Stadt",null,null,"https://zug-stadt.roundshot.com/","1365"],["Preda",null,null,"https://albulatunnel.roundshot.com/","263"],["Baden",null,null,"https://baden.roundshot.com/turm-baldegg/","676"],["Schupfart",null,null,"https://flugplatzschupfart.roundshot.com/","632"],["Leibstadt",null,null,"https://meteoschweiz.roundshot.com/leibstadt/","fb191748691dc406ed574d2b079591e0"],["Birrfeld",null,null,"https://birrfeld.roundshot.com/","341"],["Laufenburg",null,null,"https://laufenburg.roundshot.com/stadt/","1653"],["Lindenberg",null,null,"https://lindenbergloipen.roundshot.com/","1769"],["Bellikon",null,null,"https://rehabellikon.roundshot.com/","1269"],["Seengen",null,null,"https://seengen.roundshot.com/","1563"],["Oberrüti",null,null,"https://oberrueti.roundshot.com/","2063"],["Titlis",null,null,"https://titlis.roundshot.com/titlis/","167"],["Jochpass",null,null,"https://titlis.roundshot.com/jochpass/","2065"],["Fürenalp Engelberg",null,null,"https://fuerenalp.roundshot.com/","19"],["Alpstubli am Trübsee",null,null,"https://titlis.roundshot.com/alpstubli-truebsee/","2064"],["Weissenboden",null,null,"https://bielkinzig.roundshot.com/weissenboden/","432"],["Gumen Braunwald",null,null,"https://braunwald.roundshot.com/gumen/","557"],["Seblengrat Braunwald",null,null,"https://braunwald.roundshot.com/seblengrat/","1589"],["Grotzenbüel Braunwald",null,null,"https://braunwald.roundshot.com/z_grotzenbuel/","556"],["Oberblegisee",null,null,"https://oberblegisee.roundshot.com/","1501"],["Hotel Cristal Braunwald",null,null,"https://hotelcristal.roundshot.com/","1368"],["Märchenhotel Braunwald",null,null,"https://maerchenhotel.roundshot.com/","857"],["Brunnenberg",null,null,"https://brunnenberg.roundshot.com/","1121"],["Elm Schabell",null,null,"https://sportbahnenelm.roundshot.com/schabell/","1721"],["Hagenturm",null,null,"https://hagenturm.roundshot.com/","246305c5d0274ffa846231878df8c038"],["Schaffhausen",null,null,"https://meteoschweiz.roundshot.com/schaffhausen/","3db2462abc375b4b6099f1d00cf583f5"],["Verbier 4 Vallées - Bruson La Pasay",null,null,"https://verbier.roundshot.com/bruson/",null],["Laax - rocksresort",null,null,"https://laax.roundshot.com/rocksresort/",null],["Laax - Crap Sogn Gion Park",null,null,"https://laax.roundshot.com/crap-sogn-gion-park/",null],["Naters-Brig",null,null,"https://unesco.roundshot.com/naters/","77"],["Val d'Isère - Front de neige",null,null,"https://valdisere.roundshot.com/",null],["Val d'Isère - Bellevarde",null,null,"https://valdisere.roundshot.com/bellevarde/",null],["Tignes - Grande Motte",null,null,"https://tignes.roundshot.com/grande-motte/",null],["Tignes - Val Claret",null,null,"https://tignes.roundshot.com/val-claret/",null],["Tignes - Le Lac",null,null,"https://tignes.roundshot.com/lac/",null],["Tignes - Tovière",null,null,"https://tignes.roundshot.com/toviere/",null],["Valloire",null,null,"https://valloire.roundshot.com/",null],["Balderschwang (Allgäu)",null,null,"https://balderschwang.roundshot.com/",null],["Brocken (Harz)",null,null,"https://brocken.roundshot.com/",null],["Lutsen Mountains",47.66303,-90.70875,"https://lutsen.roundshot.com/","823"],["Montrose, Colorado",null,null,"https://cityofmontrose.roundshot.com/",null],["Lodge at Whitefish Lake",null,null,"https://lodgeatwhitefishlake.roundshot.com/",null],["Space Needle PanoCam, Seattle",null,null,"https://spaceneedle.roundshot.com/",null],["Lake Louise - Ptarmigan",null,null,"https://skilouise.roundshot.com/ptarmigan/",null],["Queenstown",null,null,"https://queenstown.roundshot.com/",null]];
const rsUrl = (u) => (ENV.WS_RSBASE ? `${ENV.WS_RSBASE}/${u.replace(/^https:\/\//, '')}settings.min.json` : `${u}settings.min.json`);
async function doRoundshot() {
  if (NOW - state.rsAt < 7 * 864e5 && keep('roundshot.json')) { src('roundshot', true, { kept: true }); return; }
  const list = RS_LIST;
  if (!Array.isArray(list) || !list.length) throw new Error('Roundshot-Liste fehlt im Skript');
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
const FILES = { warnings: ['warnings.json'], alertswiss: ['alerts.json'], swpc: ['aurora.json'], slf: ['slf.json', 'slf-ser.json'], lawinen: ['lawinen.json'], powder: ['powder.json'], roundshot: ['roundshot.json'] };
const T0 = Date.now();
for (const [k, fn] of [['alertswiss', doAlerts], ['warnings', doWarnings], ['swpc', doAurora], ['quakes', doQuakes], ['slf', doSlf], ['lawinen', doAval], ['powder', doPowder], ['roundshot', doRoundshot]]) {
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
  const on = [+s.p.a ? 'Alertswiss (alle Meldungen)' : '', +s.p.n ? `Nordlicht (ab Kp ${+s.p.n < 6.5 ? 6 : 7})` : '', +s.p.q ? `Erdbeben ab M ${+s.p.q}` : '', +s.p.pw ? `Powderalert ab ${+s.p.pw} cm` : '', +s.p.w ? `Unwetterwarnungen ab Stufe ${s.p.wp.length ? +s.p.w : Math.max(+s.p.w, 4)}${s.p.wp.length ? ` (${s.p.wp.map((x) => x[1]).join(', ')})` : ' (ganze Schweiz)'}` : ''].filter(Boolean);
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
    if (ENV.WS_TEST) log('Mitteilung:', msg.title, '|', msg.body);
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
fs.writeFileSync(path.join(OUT, 'README.md'), `# Windsack · Datenspiegel\n\nAutomatisch erzeugt von \`.github/workflows/windsack.yml\` (letzter Lauf ${iso(NOW)}). Nicht von Hand bearbeiten.\n\nQuellen: Alertswiss (Quelle: www.alertswiss.ch), MeteoSchweiz (Warnungen), NOAA SWPC, SLF (CC BY 4.0), Open-Meteo (Neuschnee-Prognose), Roundshot.\n`);
log(`Lauf ${state.runs}: ${Object.entries(status.src).map(([k, v]) => `${k} ${v.ok ? 'ok' : 'FEHLER'}`).join(', ')} · Geräte ${SUBS.length} · Mitteilungen ${status.push.sent} gesendet, ${status.push.failed} fehlgeschlagen`);
