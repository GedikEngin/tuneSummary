'use strict';
// Reads Spotify's export in the browser and sends only compact play rows to the server, in gzip'd batches.
// Also used by tests (node): unzip, isHistoryFile, normalize, toBatches are plain functions.

// ---------- zip reader (no libraries; modern browsers have DecompressionStream) ----------
async function unzip(buf, wanted) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), out = [];
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That file isn\'t a zip.');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const td = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true), name = td.decode(u8.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + el + cl;
    if (!wanted(name)) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const data = u8.subarray(start, start + csize);
    let text;
    if (method === 0) text = td.decode(data);
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser can\'t open zip files. Unzip it and drop the Streaming_History JSON files instead, or use a current Chrome, Edge, Firefox or Safari.');
      text = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    } else continue;
    out.push({name, text});
  }
  return out;
}
const isHistoryFile = name => /\.json$/i.test(name) && /(Streaming_?History|endsong)/i.test(name) && !/video/i.test(name);

// ---------- parsing ----------
// record: {t: end time ms UTC, ms, tr, ar, al, u (track id), ep, show, pf, cc, x (has skip info), sk, sh}
function normalize(arr, out) {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    let r;
    if (o.ts) {
      const tr = o.master_metadata_track_name, ep = o.episode_name;
      if (!tr && !ep) continue; // audiobooks, video, unknown
      r = {t: Date.parse(o.ts), ms: Math.max(0, o.ms_played | 0), x: 1, sk: o.skipped ? 1 : 0, sh: o.shuffle ? 1 : 0};
      if (tr) { r.tr = tr; r.ar = o.master_metadata_album_artist_name || 'Unknown'; r.al = o.master_metadata_album_album_name || ''; if (o.spotify_track_uri) r.u = String(o.spotify_track_uri).split(':').pop(); }
      else { r.ep = ep; r.show = o.episode_show_name || 'Unknown show'; }
      if (o.platform) r.pf = String(o.platform);
      if (o.conn_country) r.cc = String(o.conn_country);
    } else if (o.endTime) {
      r = {t: Date.parse(String(o.endTime).replace(' ', 'T') + 'Z'), ms: Math.max(0, o.msPlayed | 0)};
      if (o.trackName) { r.tr = o.trackName; r.ar = o.artistName || 'Unknown'; r.al = ''; }
      else if (o.episodeName) { r.ep = o.episodeName; r.show = o.podcastName || 'Unknown show'; }
      else continue;
    } else continue;
    if (!isFinite(r.t)) continue;
    out.push(r); n++;
  }
  return n;
}

async function readFiles(files, onStatus = () => {}) {
  const texts = [];
  for (const f of files) {
    onStatus('Opening ' + f.name + '…');
    if (/\.zip$/i.test(f.name)) texts.push(...await unzip(await f.arrayBuffer(), isHistoryFile));
    else texts.push({name: f.name, text: await f.text()});
  }
  const recs = [];
  let used = 0;
  for (const {name, text} of texts) {
    try { if (normalize(JSON.parse(text), recs)) used++; } catch (e) { console.warn('skipped', name, e); }
  }
  // drop exact duplicates inside the upload (server dedupes again)
  const seen = new Set(), uniq = [];
  for (const r of recs) { const k = r.t + '\u0001' + (r.tr || '') + '\u0001' + (r.ep || ''); if (!seen.has(k)) { seen.add(k); uniq.push(r); } }
  uniq.sort((a, b) => a.t - b.t);
  return {recs: uniq, files: used};
}

// Columnar batches with per-batch string tables (see tunesummary/ingest.py for the format).
function toBatches(recs, size = 20000) {
  const out = [];
  for (let i = 0; i < recs.length; i += size) {
    const b = {tracks: [], episodes: [], platforms: [], countries: [], rows: []}, ix = {t: new Map(), e: new Map(), p: new Map(), c: new Map()};
    const idx = (m, list, key, val) => { let v = m.get(key); if (v === undefined) { v = list.length; list.push(val); m.set(key, v); } return v; };
    for (const r of recs.slice(i, i + size)) {
      const ti = r.tr ? idx(ix.t, b.tracks, r.tr + '\u0001' + r.ar + '\u0001' + r.al + '\u0001' + (r.u || ''), [r.tr, r.ar, r.al, r.u || null]) : -1;
      const ei = r.tr ? -1 : idx(ix.e, b.episodes, r.ep + '\u0001' + r.show, [r.ep, r.show]);
      const pi = r.pf ? idx(ix.p, b.platforms, r.pf, r.pf) : -1;
      const ci = r.cc ? idx(ix.c, b.countries, r.cc, r.cc) : -1;
      b.rows.push([r.t, r.ms, ti, ei, pi, ci, r.x ? 4 | (r.sk ? 1 : 0) | (r.sh ? 2 : 0) : 0]);
    }
    out.push(b);
  }
  return out;
}

async function gz(str) {
  if (typeof CompressionStream === 'undefined') return {body: str, gz: false};
  const body = await new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return {body, gz: true};
}

async function uploadRecs(recs, onProgress = () => {}) {
  const batches = toBatches(recs);
  let added = 0, sent = 0;
  for (const b of batches) {
    const {body, gz: z} = await gz(JSON.stringify(b));
    const headers = {'Content-Type': 'application/json'};
    if (z) headers['X-Body-Encoding'] = 'gzip';
    let res, tries = 0;
    for (;;) {
      try { res = await api('api/upload', {method: 'POST', headers, body}); break; }
      catch (e) { if (++tries >= 3 || (e.status && e.status < 500 && e.status !== 429)) throw e; await new Promise(ok => setTimeout(ok, 1500 * tries)); }
    }
    added += res.added; sent += b.rows.length;
    onProgress(sent / recs.length, sent, added);
  }
  await postJSON('api/upload/done', {rows: recs.length, added});
  return {added, rows: recs.length};
}

if (typeof module !== 'undefined') module.exports = {unzip, isHistoryFile, normalize, readFiles, toBatches};
