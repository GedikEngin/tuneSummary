'use strict';
// Stats dashboard. The server sends all of a user's plays in a compact form; everything is aggregated here,
// so any date range is instant. Ported from openwrapped (github.com/GedikEngin) with Survey styling.

// ---------- helpers ----------
const fmtInt = n => Math.round(n).toLocaleString();
const mins = ms => ms / 60000;
const fmtMin = ms => fmtInt(mins(ms));
const fmtHrs = ms => (ms / 3600000).toLocaleString(undefined, {maximumFractionDigits: ms < 36e6 ? 1 : 0});
const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const fmtDate = t => new Date(t).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
const fmtDateTime = t => new Date(t).toLocaleString(undefined, {year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STREAM_MS = 30000; // Spotify counts a "stream" at 30 s
const setStatus = s => { const el = $('#status'); if (el) el.textContent = s || ''; };
const DEMO = new URLSearchParams(location.search).get('demo') === '1';

// ---------- state ----------
let ALL = [];          // all records, sorted by t
let VIEW = [];         // records in the selected range
let AGG = null;
let FIRST = null;      // artist -> first-ever play time
let range = {key: 'all'};
let topTab = 'tracks', topLimit = 50, tlGrain = 'month';
let GENRES = {}, ME = null;

// ---------- aggregation ----------
function aggregate(rows) {
  const A = {ms: 0, plays: 0, streams: 0, pms: 0, pplays: 0, tracks: new Map(), artists: new Map(), albums: new Map(), shows: new Map(),
    hours: new Array(24).fill(0), wd: new Array(7).fill(0), days: new Map(), skips: 0, shuffles: 0, withSkipInfo: 0,
    pf: new Map(), cc: new Map(), first: Infinity, last: -Infinity};
  const bump = (m, k, init, ms, t) => { let e = m.get(k); if (!e) { e = init(); e.ms = 0; e.plays = 0; e.first = t; m.set(k, e); } e.ms += ms; if (ms >= STREAM_MS) e.plays++; e.last = t; return e; };
  for (const r of rows) {
    if (r.t < A.first) A.first = r.t; if (r.t > A.last) A.last = r.t;
    const d = new Date(r.t), dk = dayKey(r.t);
    A.days.set(dk, (A.days.get(dk) || 0) + r.ms);
    A.hours[d.getHours()] += r.ms; A.wd[(d.getDay() + 6) % 7] += r.ms;
    if (r.pf) { const p = platformName(r.pf); A.pf.set(p, (A.pf.get(p) || 0) + r.ms); }
    if (r.cc) A.cc.set(r.cc, (A.cc.get(r.cc) || 0) + r.ms);
    if (r.ep) { A.pms += r.ms; A.pplays++; bump(A.shows, r.show, () => ({name: r.show}), r.ms, r.t); continue; }
    A.ms += r.ms; A.plays++; if (r.ms >= STREAM_MS) A.streams++;
    if (r.x) { A.withSkipInfo++; if (r.sk) A.skips++; if (r.sh) A.shuffles++; }
    const tk = (r.ar + '\u0001' + r.tr).toLowerCase();
    const te = bump(A.tracks, tk, () => ({name: r.tr, sub: r.ar, al: r.al, uris: {}}), r.ms, r.t);
    if (r.u) te.uris[r.u] = (te.uris[r.u] || 0) + 1;
    bump(A.artists, r.ar, () => ({name: r.ar}), r.ms, r.t);
    if (r.al) bump(A.albums, (r.ar + '\u0001' + r.al).toLowerCase(), () => ({name: r.al, sub: r.ar}), r.ms, r.t);
  }
  const dk = [...A.days.keys()].sort();
  let best = 0, cur = 0, prev = null, bestEnd = null;
  for (const k of dk) {
    const t = Date.parse(k + 'T12:00:00');
    cur = (prev !== null && Math.round((t - prev) / DAY) === 1) ? cur + 1 : 1;
    if (cur > best) { best = cur; bestEnd = k; }
    prev = t;
  }
  A.streak = best; A.streakEnd = bestEnd;
  A.topDay = [...A.days.entries()].sort((a, b) => b[1] - a[1])[0];
  return A;
}
function platformName(p) {
  p = p.toLowerCase();
  if (/ios|iphone/.test(p)) return 'iPhone / iOS';
  if (/ipad/.test(p)) return 'iPad';
  if (/android/.test(p)) return 'Android';
  if (/windows/.test(p)) return 'Windows';
  if (/os ?x|mac/.test(p)) return 'Mac';
  if (/web_player|webplayer|chrome|edge|firefox/.test(p)) return 'Web player';
  if (/linux/.test(p)) return 'Linux';
  if (/cast|sonos|speaker|alexa|echo|google_home|partner/.test(p)) return 'Speakers / cast';
  if (/playstation|ps4|ps5|xbox/.test(p)) return 'Console';
  if (/tv|tizen|webos|roku|fire/.test(p)) return 'TV';
  if (/car|auto/.test(p)) return 'Car';
  if (p === 'smartphone') return 'Phone';
  if (p === 'computer') return 'Computer';
  if (p === 'tablet') return 'Tablet';
  return p.split(/[ (]/)[0];
}

// ---------- ranges ----------
function wrappedCutoff() {
  const saved = localStorage.getItem('ts-wrapped');
  if (saved) return Date.parse(saved + 'T00:00:00');
  const now = new Date();
  // Wrapped usually counts Jan 1 → ~Nov 15 and comes out in early December
  const y = (now.getMonth() === 11 && now.getDate() >= 4) ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(y, 10, 15).getTime();
}
function rangeBounds() {
  const lastT = ALL.length ? ALL[ALL.length - 1].t : Date.now();
  switch (range.key) {
    case 'wrapped': { const c = wrappedCutoff(); return [c, Infinity, 'Since last Wrapped (' + fmtDate(c) + ')']; }
    case 'last4w': return [lastT - 28 * DAY, Infinity, 'Last 4 weeks of your data'];
    case 'last6m': return [lastT - 182 * DAY, Infinity, 'Last 6 months of your data'];
    case 'year': return [new Date(range.y, 0, 1).getTime(), new Date(range.y + 1, 0, 1).getTime(), String(range.y)];
    case 'custom': return [range.from, range.to, fmtDate(range.from) + ' → ' + fmtDate(range.to - 1)];
    default: return [-Infinity, Infinity, 'All time'];
  }
}
function renderRanges() {
  const years = [...new Set(ALL.map(r => new Date(r.t).getFullYear()))].sort((a, b) => b - a);
  const btn = (k, l, y = '') => `<button type="button" class="btn btn--line btn--sm ${range.key === k && (!y || range.y === y) ? 'on' : ''}" data-r="${k}" data-y="${y}">${l}</button>`;
  $('#ranges').innerHTML = [['all', 'All time'], ['wrapped', 'Since last Wrapped'], ['last4w', 'Last 4 weeks'], ['last6m', 'Last 6 months']]
    .map(([k, l]) => btn(k, l)).concat(years.map(y => btn('year', y, y))).join('');
}

// ---------- rendering ----------
function update() {
  const [a, b, title] = rangeBounds();
  VIEW = ALL.filter(r => r.t >= a && r.t < b);
  AGG = aggregate(VIEW);
  renderRanges();
  $('#rangeTitle').textContent = title;
  // the recap picks "since last cutoff" by default; pass a year if one is selected here
  $('#btnRecap').href = 'recap' + (DEMO ? '?demo=1' : '') + (range.key === 'year' ? (DEMO ? '&' : '?') + 'p=' + range.y : '');
  topLimit = 50;
  renderKpis(a, b); renderTimeline(); renderTop(); renderClock(); renderHabits();
}
function renderKpis(a, b) {
  const A = AGG;
  if (!VIEW.length) { $('#kpis').innerHTML = '<p class="mut small" style="padding:var(--s-4)">No plays in this range.</p>'; return; }
  const spanStart = isFinite(a) ? a : A.first, spanEnd = Math.min(isFinite(b) ? b : Infinity, ALL[ALL.length - 1].t + 1);
  const nDays = Math.max(1, Math.round((spanEnd - spanStart) / DAY));
  const topA = [...A.artists.values()].sort((x, y) => y.ms - x.ms)[0];
  const topT = [...A.tracks.values()].sort((x, y) => y.ms - x.ms)[0];
  const k = (l, v, d = '', cls = '', ncls = '') => `<div class="stat ${cls}"><div class="meta">${l}</div><div class="n ${ncls}" title="${v.replace(/<[^>]+>/g, '')}">${v}</div><div class="d">${d}</div></div>`;
  $('#kpis').innerHTML = [
    k('Minutes listened (music)', fmtMin(A.ms), `${fmtHrs(A.ms)} hours · ${(A.ms / DAY).toFixed(1)} days`, 'big'),
    k('Streams', fmtInt(A.streams), `plays ≥ 30 s · ${fmtInt(A.plays)} total plays`),
    k('Avg per day', fmtInt(mins(A.ms) / nDays) + ' min', `over ${fmtInt(nDays)} days`),
    k('Different tracks', fmtInt(A.tracks.size)),
    k('Different artists', fmtInt(A.artists.size)),
    k('Different albums', fmtInt(A.albums.size)),
    k('Top artist', esc(topA ? topA.name : '—'), topA ? fmtMin(topA.ms) + ' min' : '', '', 'sm'),
    k('Top track', esc(topT ? topT.name : '—'), topT ? esc(topT.sub) + ' · ' + fmtInt(topT.plays) + ' streams' : '', '', 'sm'),
    k('Longest streak', A.streak + ' days', A.streakEnd ? 'ended ' + fmtDate(Date.parse(A.streakEnd + 'T12:00:00')) : ''),
    k('Biggest day', A.topDay ? fmtMin(A.topDay[1]) + ' min' : '—', A.topDay ? fmtDate(Date.parse(A.topDay[0] + 'T12:00:00')) : ''),
    k('Podcasts', fmtMin(A.pms) + ' min', fmtInt(A.pplays) + ' episodes played'),
  ].join('');
}

function barChart(el, items, {h = 180, fmt = v => fmtMin(v) + ' min', every = 1} = {}) {
  const W = Math.max(el.clientWidth || 600, 280), padL = 40, padB = 20, max = Math.max(1, ...items.map(i => i[1]));
  const n = items.length, bw = (W - padL) / Math.max(n, 1);
  const nice = niceMax(mins(max));
  let s = `<svg width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">`;
  for (let g = 0; g <= 4; g++) {
    const v = nice * g / 4, y = h - padB - (h - padB - 8) * v / nice;
    s += `<line x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${y + 3}" text-anchor="end">${v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : Math.round(v)}</text>`;
  }
  items.forEach(([lab, v], i) => {
    const bh = (h - padB - 8) * mins(v) / nice, x = padL + i * bw;
    s += `<rect class="b" x="${x + bw * 0.12}" y="${h - padB - bh}" width="${Math.max(1, bw * 0.76)}" height="${bh}"><title>${esc(lab)}: ${fmt(v)}</title></rect>`;
    if (i % every === 0) s += `<text x="${x + bw / 2}" y="${h - 5}" text-anchor="middle">${esc(lab)}</text>`;
  });
  el.innerHTML = s + '</svg><div class="meta unit">minutes</div>';
}
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; }

function renderTimeline() {
  const el = $('#timeline');
  if (!VIEW.length) { el.innerHTML = ''; return; }
  const buckets = new Map();
  const keyOf = {
    month: t => { const d = new Date(t); return [d.getFullYear() * 12 + d.getMonth(), d.toLocaleDateString(undefined, {month: 'short', year: '2-digit'})]; },
    week: t => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return [d.getTime(), d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'})]; },
    day: t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return [d.getTime(), d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'})]; },
  }[tlGrain];
  for (const r of VIEW) { if (!r.tr) continue; const [k, l] = keyOf(r.t); const b = buckets.get(k) || {l, v: 0}; b.v += r.ms; buckets.set(k, b); }
  if (!buckets.size) { el.innerHTML = '<p class="mut small">No music in this range.</p>'; return; }
  const keys = [...buckets.keys()].sort((a, b) => a - b), items = [];
  if (tlGrain === 'month') for (let k = keys[0]; k <= keys[keys.length - 1]; k++) { const y = Math.floor(k / 12), m = k % 12; items.push([buckets.get(k)?.l || new Date(y, m, 1).toLocaleDateString(undefined, {month: 'short', year: '2-digit'}), buckets.get(k)?.v || 0]); }
  else { const step = tlGrain === 'week' ? 7 : 1; for (let t = keys[0]; t <= keys[keys.length - 1]; ) { const d = new Date(t); items.push([buckets.get(t)?.l || d.toLocaleDateString(undefined, {month: 'short', day: 'numeric'}), buckets.get(t)?.v || 0]); d.setDate(d.getDate() + step); t = d.getTime(); } }
  barChart(el, items, {h: 220, every: Math.max(1, Math.ceil(items.length / 14))});
}

function sortedTop() {
  const by = $('#sortBy').value, q = $('#q').value.trim().toLowerCase();
  let list = topTab === 'genres' ? genreList() : [...({tracks: AGG.tracks, artists: AGG.artists, albums: AGG.albums, shows: AGG.shows}[topTab]).values()];
  if (q) list = list.filter(e => (e.name + ' ' + (e.sub || '')).toLowerCase().includes(q));
  return list.sort((a, b) => (b[by] - a[by]) || (b.ms - a.ms));
}
const topUri = e => Object.entries(e.uris || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
// Artwork hook (phase 2): return an image URL for an entry, or null for none.
const thumbOf = () => null;

function renderTop() {
  $('#genreBox').classList.toggle('hidden', topTab !== 'genres');
  if (topTab === 'genres') renderGenreBox();
  const by = $('#sortBy').value, list = sortedTop(), max = (list[0] && list[0][by]) || 1;
  const rows = list.slice(0, topLimit).map((e, i) => {
    let name = esc(e.name);
    if (topTab === 'tracks') { const u = topUri(e); if (u) name += ` <a class="mut" href="https://open.spotify.com/track/${encodeURIComponent(u)}" target="_blank" rel="noopener" title="Open in Spotify" data-ext>↗</a>`; }
    const img = thumbOf(e);
    const sub = e.sub ? `<div class="s">${esc(e.sub)}${e.al && topTab === 'tracks' ? ' · ' + esc(e.al) : ''}</div>` : '';
    const right = topTab === 'genres' ? `${fmtMin(e.ms)} min<div class="s">${e.artists} artists</div>` : `${fmtMin(e.ms)} min<div class="s">${fmtInt(e.plays)} streams</div>`;
    return `<tr class="click" data-i="${i}"><td class="rk">${pad(i + 1)}</td><td class="nm">${img ? `<img src="${esc(img)}" alt="" width="36" height="36">` : ''}${name}${sub}</td><td class="bar"><div class="barbg"><div class="barfg" style="width:${(100 * e[by] / max).toFixed(1)}%"></div></div></td><td class="num">${right}</td></tr>`;
  });
  $('#topTable').innerHTML = rows.join('') || `<tr><td class="mut">${topTab === 'genres' ? 'No genre data yet for this range. Genres are looked up in the background; check back in a few minutes.' : 'Nothing here.'}</td></tr>`;
  $('#btnMore').classList.toggle('hidden', list.length <= topLimit);
  $('#btnMore').textContent = `Show more (${fmtInt(list.length)} total)`;
  $('#topTable').onclick = ev => { if (ev.target.closest('[data-ext]')) return; const tr = ev.target.closest('tr[data-i]'); if (tr) openDetail(list[+tr.dataset.i]); };
}

// ---------- genres (MusicBrainz, looked up by the server, shared cache) ----------
function artistGenres(name) {
  const g = GENRES[name.toLowerCase()];
  if (!g || !g.length) return null;
  const tot = g.reduce((s, x) => s + x[1], 0) || 1;
  return g.map(([n, w]) => [n, w / tot]);
}
function genreList() {
  const m = new Map();
  for (const a of AGG.artists.values()) {
    const gs = artistGenres(a.name); if (!gs) continue;
    for (const [g, w] of gs) { const e = m.get(g) || {name: g, ms: 0, plays: 0, artists: 0, top: []}; e.ms += a.ms * w; e.plays += a.plays * w; e.artists++; e.top.push(a); m.set(g, e); }
  }
  for (const e of m.values()) e.sub = e.top.sort((x, y) => y.ms - x.ms).slice(0, 3).map(a => a.name).join(', ');
  return [...m.values()];
}
function renderGenreBox() {
  let covered = 0; for (const a of AGG.artists.values()) if (GENRES[a.name.toLowerCase()]) covered += a.ms;
  const g = ME?.genres;
  $('#genreBox').innerHTML = `Genres come from <a class="u" href="https://musicbrainz.org" target="_blank" rel="noopener">MusicBrainz</a>, weighted by your minutes per artist. ` +
    (g ? `Artists looked up so far: ${fmtInt(g.done)} of ${fmtInt(g.total)}. ` : '') + `Genre data covers <b>${Math.round(100 * covered / Math.max(1, AGG.ms))}%</b> of your listening in this range.`;
}

// ---------- detail popup ----------
function openDetail(e) {
  let rows, title = esc(e.name), sub = e.sub ? esc(e.sub) : '';
  if (topTab === 'tracks') rows = VIEW.filter(r => r.tr && (r.ar + '\u0001' + r.tr).toLowerCase() === (e.sub + '\u0001' + e.name).toLowerCase());
  else if (topTab === 'artists') rows = VIEW.filter(r => r.ar === e.name);
  else if (topTab === 'albums') rows = VIEW.filter(r => r.al && (r.ar + '\u0001' + r.al).toLowerCase() === (e.sub + '\u0001' + e.name).toLowerCase());
  else if (topTab === 'shows') rows = VIEW.filter(r => r.show === e.name);
  else { const names = new Set(e.top.map(a => a.name)); rows = VIEW.filter(r => r.ar && names.has(r.ar)); sub = e.top.length + ' artists'; }
  const A = aggregate(rows);
  const allTime = topTab === 'artists' ? ALL.find(r => r.ar === e.name) : null;
  let html = `<div class="panel-head"><div><div class="meta">${{tracks: 'Track', artists: 'Artist', albums: 'Album', shows: 'Podcast', genres: 'Genre'}[topTab]}</div><h2 class="display" style="font-size:var(--fs-h3)">${title}</h2><div class="small mut">${sub}</div></div><span class="sp"></span><button type="button" class="btn btn--line btn--sm" id="modalClose">Close</button></div>
    <div class="stats" style="margin:var(--s-4) 0">
      <div class="stat"><div class="meta">Minutes</div><div class="n">${fmtMin(e.ms)}</div></div>
      <div class="stat"><div class="meta">Streams</div><div class="n">${fmtInt(Math.round(e.plays))}</div></div>
      <div class="stat"><div class="meta">First played</div><div class="n sm">${rows[0] ? fmtDateTime(rows[0].t) : '—'}</div>${allTime ? `<div class="d">first ever: ${fmtDate(allTime.t)}</div>` : ''}</div>
      <div class="stat"><div class="meta">Last played</div><div class="n sm">${rows.length ? fmtDateTime(rows[rows.length - 1].t) : '—'}</div></div>
    </div><div id="mChart" class="chart"></div>`;
  const listOf = (m, label) => { const l = [...m.values()].sort((a, b) => b.ms - a.ms).slice(0, 15); return l.length > 1 ? `<h3 class="meta" style="margin:var(--s-5) 0 var(--s-2)">${label}</h3><table class="list">` + l.map((x, i) => `<tr><td class="rk">${pad(i + 1)}</td><td class="nm">${esc(x.name)}${x.sub && label !== 'Top tracks' ? '<div class="s">' + esc(x.sub) + '</div>' : ''}</td><td class="num">${fmtMin(x.ms)} min<div class="s">${fmtInt(x.plays)} streams</div></td></tr>`).join('') + '</table>' : ''; };
  if (topTab === 'artists' || topTab === 'albums' || topTab === 'genres') html += listOf(A.tracks, 'Top tracks');
  if (topTab === 'genres') html += listOf(A.artists, 'Top artists');
  if (topTab === 'artists') { const g = GENRES[e.name.toLowerCase()]; if (g?.length) html += '<div class="pillrow" style="margin-top:var(--s-4)">' + g.slice(0, 8).map(x => `<span class="tag">${esc(x[0])}</span>`).join('') + '</div>'; }
  if (topTab === 'shows') { const eps = new Map(); for (const r of rows) { const x = eps.get(r.ep) || {name: r.ep, ms: 0, plays: 0}; x.ms += r.ms; if (r.ms >= STREAM_MS) x.plays++; eps.set(r.ep, x); } html += listOf(eps, 'Episodes'); }
  $('#modalBody').innerHTML = html;
  $('#modal').style.display = 'flex';
  $('#modalClose').onclick = closeModal;
  const months = new Map();
  for (const r of rows) { const d = new Date(r.t), k = d.getFullYear() * 12 + d.getMonth(); months.set(k, (months.get(k) || 0) + r.ms); }
  const ks = [...months.keys()].sort((a, b) => a - b), items = [];
  if (ks.length) for (let k = ks[0]; k <= ks[ks.length - 1]; k++) items.push([new Date(Math.floor(k / 12), k % 12, 1).toLocaleDateString(undefined, {month: 'short', year: '2-digit'}), months.get(k) || 0]);
  barChart($('#mChart'), items, {h: 160, every: Math.max(1, Math.ceil(items.length / 10))});
}
function closeModal() { $('#modal').style.display = 'none'; }

function renderClock() {
  const hl = h => h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p';
  barChart($('#hours'), AGG.hours.map((v, h) => [hl(h), v]), {every: 3});
  barChart($('#weekdays'), AGG.wd.map((v, i) => [WD[i], v]));
}
function renderHabits() {
  const A = AGG, pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';
  const peakH = A.hours.indexOf(Math.max(...A.hours));
  if (!FIRST) { FIRST = new Map(); for (const r of ALL) if (r.ar && !FIRST.has(r.ar)) FIRST.set(r.ar, r.t); }
  const from = rangeBounds()[0], recentNew = [...A.artists.values()].filter(a => FIRST.get(a.name) >= from).length;
  const line = (l, v) => `<tr><td>${l}</td><td class="num" style="width:auto">${v}</td></tr>`;
  const needExt = '<span class="mut">needs extended history</span>';
  $('#habits').innerHTML = '<table class="list">' + [
    line('Skipped tracks', A.withSkipInfo ? pct(A.skips, A.withSkipInfo) : needExt),
    line('Played on shuffle', A.withSkipInfo ? pct(A.shuffles, A.withSkipInfo) : needExt),
    line('Plays under 30 s', pct(A.plays - A.streams, A.plays)),
    line('Avg minutes per play', A.plays ? (mins(A.ms) / A.plays).toFixed(1) : '—'),
    line('Favourite hour', VIEW.length ? (peakH % 12 || 12) + (peakH < 12 ? ' am' : ' pm') : '—'),
    line('Days with any listening', fmtInt(A.days.size)),
    line(range.key === 'all' ? 'Artists discovered' : 'New artists (first ever play in this range)', fmtInt(recentNew)),
  ].join('') + '</table>';
  const list = (m, title) => { const l = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8), tot = l.reduce((s, x) => s + x[1], 0) || 1; return l.length ? `<div class="meta" style="margin:var(--s-4) 0 var(--s-1)">${title}</div><table class="list">` + l.map(([k, v]) => line(esc(k), fmtMin(v) + ' min · ' + Math.round(100 * v / tot) + '%')).join('') + '</table>' : ''; };
  $('#devices').innerHTML = (list(A.pf, 'Platforms') + list(A.cc, 'Countries')) || `<p class="mut small">${needExt}</p>`;
}

// ---------- data loading ----------
function decode(d) {
  GENRES = d.genres || {};
  return d.rows.map(([t, ms, ti, ei, pi, ci, fl]) => {
    const r = {t, ms};
    if (ti >= 0) { const T = d.tracks[ti]; r.tr = T[0]; r.ar = T[1]; r.al = T[2]; if (T[3]) r.u = T[3]; }
    else { const E = d.episodes[ei]; r.ep = E[0]; r.show = E[1]; }
    if (pi >= 0) r.pf = d.platforms[pi]; if (ci >= 0) r.cc = d.countries[ci];
    if (fl & 4) { r.x = 1; r.sk = fl & 1 ? 1 : 0; r.sh = fl & 2 ? 1 : 0; }
    return r;
  });
}
function renderCoverage() {
  if (!ALL.length) { $('#coverage').textContent = ''; return; }
  const ext = ALL.some(r => r.x);
  $('#coverage').innerHTML = `<b>${fmtInt(ALL.length)}</b> plays · ${fmtDate(ALL[0].t)} → ${fmtDate(ALL[ALL.length - 1].t)} · ${ext ? 'extended history' : 'basic history (last year only; request extended history for everything)'}`;
}
function showUpload(show) { $('#importCard').classList.toggle('hidden', !show); }

async function load() {
  setStatus('Loading…');
  let d;
  if (DEMO) {
    d = await api('static/demo.json');
    ME = null;
    $('#demoNote').classList.remove('hidden'); $('#topBtns').classList.add('hidden'); $('#who').textContent = 'Demo account';
  } else {
    try { ME = await api('api/me'); } catch (e) { if (e.status === 401) { location.replace('signin'); return; } throw e; }
    $('#who').textContent = ME.email;
    d = await api('api/plays');
  }
  ALL = decode(d);
  FIRST = null;
  setStatus('');
  const c = new Date(wrappedCutoff());
  $('#dWrapped').value = c.getFullYear() + '-' + pad(c.getMonth() + 1) + '-' + pad(c.getDate());
  renderCoverage();
  if (!ALL.length) {
    showUpload(true); $('#dashView').classList.add('hidden');
    if (ME) $('#remState').innerHTML = ME.remind_at ? `We'll remind you on ${fmtDate(ME.remind_at)}.` : `Want a reminder email? <a class="u" href="account">Set one up</a>.`;
    return;
  }
  $('#welcome').classList.add('hidden');
  $('#dashView').classList.remove('hidden');
  update();
}

async function handleFiles(files) {
  if (!files.length || DEMO) return;
  const msg = $('#upMsg'), prog = $('#upProg');
  msg.className = 'small'; prog.classList.remove('hidden'); prog.firstElementChild.style.width = '2%';
  try {
    const {recs, files: used} = await readFiles(files, s => msg.textContent = s);
    if (!recs.length) throw new Error('No listening history found. Upload my_spotify_data.zip, or the Streaming_History_Audio_*.json files inside it.');
    msg.textContent = `Found ${fmtInt(recs.length)} plays in ${used} file(s). Uploading…`;
    const r = await uploadRecs(recs, (f, sent) => { prog.firstElementChild.style.width = (2 + 98 * f).toFixed(1) + '%'; msg.textContent = `Uploading… ${fmtInt(sent)} of ${fmtInt(recs.length)} plays`; });
    msg.textContent = `Done: ${fmtInt(r.added)} new plays added (${fmtInt(r.rows - r.added)} were already there).`;
    await load();
    if (r.added) showUpload(false);
  } catch (e) { msg.className = 'err'; msg.textContent = 'Upload failed: ' + e.message; prog.classList.add('hidden'); }
}

// ---------- events ----------
$('#ranges').onclick = e => { const b = e.target.closest('button'); if (!b) return; range = {key: b.dataset.r, y: +b.dataset.y}; update(); };
$('#btnCustom').onclick = () => { const f = $('#dFrom').value, t = $('#dTo').value; if (!f || !t) return; range = {key: 'custom', from: Date.parse(f + 'T00:00:00'), to: Date.parse(t + 'T00:00:00') + DAY}; update(); };
$('#dWrapped').onchange = e => { if (e.target.value) { localStorage.setItem('ts-wrapped', e.target.value); if (range.key === 'wrapped') update(); } };
$('#topTabs').onclick = e => { const b = e.target.closest('button[data-t]'); if (!b) return; topTab = b.dataset.t; topLimit = 50; $$('#topTabs button[data-t]').forEach(x => x.classList.toggle('on', x === b)); renderTop(); };
$('#sortBy').onchange = renderTop; $('#q').oninput = () => { topLimit = 50; renderTop(); };
$('#btnMore').onclick = () => { topLimit += 100; renderTop(); };
$$('[data-tg]').forEach(b => b.onclick = () => { tlGrain = b.dataset.tg; $$('[data-tg]').forEach(x => x.classList.toggle('on', x === b)); renderTimeline(); });
$('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (AGG) { renderTimeline(); renderClock(); } }, 200); });
$('#btnUpload').onclick = () => showUpload($('#importCard').classList.contains('hidden'));
$('#btnPick').onclick = () => $('#file').click();
$('#file').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hover'); }));
document.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) { showUpload(true); handleFiles([...e.dataTransfer.files]); } });

load().catch(e => setStatus('Error: ' + e.message));
