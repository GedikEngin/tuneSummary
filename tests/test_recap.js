// Recap tests: slide numbers + archetypes (recapdata.js) and a dry run of every slide drawing (recapdraw.js)
// against a recording fake canvas, for the demo account and (optionally) a real-format export zip.
//   TZ=America/Denver node tests/test_recap.js [EXPORT.zip]
const fs = require('fs'), vm = require('vm'), path = require('path');
const RD = require('../web/static/js/recapdata.js');
const DR = require('../web/static/js/recapdraw.js');
const web = path.join(__dirname, '..', 'web');
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fails++; };
const DAY = 86400000;

// ---------- synthetic listeners for the archetypes ----------
function listener({days = 120, perDay = 20, hours = [12, 13, 18, 19], artists = 30, topBias = 0, skip = 0.1, start = new Date(2025, 0, 1).getTime(), repeatTrack = 0, newEach = false}) {
  const rows = []; let s = 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let d = 0; d < days; d++) for (let i = 0; i < perDay; i++) {
    const h = hours[i % hours.length];
    const t = new Date(start + d * DAY); t.setHours(h, (i * 7) % 60, 0, 0);
    const a = rnd() < topBias ? 0 : 1 + Math.floor(rnd() * (newEach ? artists + d : artists));
    const tr = repeatTrack && d === 5 && i < repeatTrack ? 'Loop Song' : 'Song ' + Math.floor(rnd() * 8);
    rows.push({t: t.getTime(), ms: 180000, tr, ar: repeatTrack && tr === 'Loop Song' ? 'Loop Band' : 'Artist ' + a, al: 'LP', x: 1, sk: rnd() < skip ? 1 : 0, sh: 0});
  }
  return rows.sort((x, y) => x.t - y.t);
}
const yearOf = rows => ({key: '2025', label: '2025', from: new Date(2025, 0, 1).getTime(), to: new Date(2026, 0, 1).getTime(), kind: 'year', year: 2025});
const arche = (rows, genres = {}) => RD.compute(rows, genres, yearOf(rows)).archetype;

ok(arche(listener({topBias: 0.5})).key === 'loyalist', 'loyalist: half of all plays are one artist');
ok(arche(listener({repeatTrack: 14})).key === 'repeat', 'repeat offender: one song 14× in a day');
ok(arche(listener({hours: [22, 23, 0, 1, 2]})).key === 'nightowl', 'night owl: listens 10 pm – 3 am');
ok(arche(listener({hours: [6, 7, 8, 9]})).key === 'earlybird', 'early riser: listens 6–9 am');
{ // explorer: most artists in the period were never played before it
  const before = listener({days: 30, artists: 5, start: new Date(2024, 5, 1).getTime()});
  const during = listener({days: 120, artists: 80, newEach: true, perDay: 15});
  ok(arche(before.concat(during).sort((a, b) => a.t - b.t)).key === 'explorer', 'explorer: lots of first-time artists');
}
ok(arche(listener({skip: 0.6})).key === 'skipper', 'skipper: skips 60%');
ok(arche(listener({perDay: 80})).key === 'marathoner', 'marathoner: 4 h a day');
{
  const g = {}; for (let i = 0; i <= 30; i++) g['artist ' + i] = [['genre ' + (i % 8), 10]];
  ok(arche(listener({}), g).key === 'genrehopper', 'genre hopper: 8 even genres');
  ok(arche(listener({})).key === 'allrounder', 'all-rounder when nothing stands out');
}
{
  const rows = listener({topBias: 0.5});
  ok(JSON.stringify(arche(rows)) === JSON.stringify(arche(rows.slice())), 'archetype is deterministic');
  const a = arche(rows); ok(a.name && a.line && /Artist 0/.test(a.because), 'archetype copy: ' + a.name + ' — ' + a.because);
}

// ---------- slide data ----------
function check(label, rows, genres) {
  const ps = RD.periods(rows, new Date(2026, 9, 7));
  ok(ps[0].key === 'wrapped' && ps[ps.length - 1].key === 'all', `${label}: periods ${ps.map(p => p.key + '(' + p.plays + ')').join(' ')}`);
  const outs = [];
  for (const p of ps.filter(p => p.plays)) {
    const R = RD.compute(rows, genres, p);
    outs.push(R);
    const T = R.totals, sumTop = R.topArtists.reduce((s, a) => s + a.share, 0);
    ok(!R.empty && T.minutes > 0 && Math.abs(T.days - T.minutes / 1440) < 0.01, `${label} ${p.key}: ${T.minutes} min = ${T.days.toFixed(1)} days, ${T.artists} artists`);
    ok(R.topTracks.length >= 1 && R.topTracks.length <= 5 && R.topTracks.every((t, i) => !i || R.topTracks[i - 1].plays >= t.plays), `${label} ${p.key}: top tracks sorted (${R.topTracks[0].name} ×${R.topTracks[0].plays})`);
    ok(sumTop <= 1.0001 && R.topArtist.share > 0, `${label} ${p.key}: top artist ${R.topArtist.name} ${(R.topArtist.share * 100).toFixed(1)}%`);
    ok(R.clock.hours.length === 24 && Math.abs(Object.values(R.clock.buckets).reduce((s, v) => s + v, 0) - 1) < 1e-6, `${label} ${p.key}: clock buckets sum to 1, ${R.clock.title}, peak ${R.clock.peakLabel}`);
    ok(R.streak.days >= 1 && R.streak.days <= T.activeDays && R.biggestDay.minutes > 0, `${label} ${p.key}: streak ${R.streak.days} d, biggest day ${R.biggestDay.minutes} min`);
    const gsum = R.genres.list.reduce((s, x) => s + x.share, 0) + R.genres.other;
    ok(!R.genres.ok || Math.abs(gsum - 1) < 1e-6, `${label} ${p.key}: genres ${R.genres.ok ? R.genres.list.map(x => x.name).join(', ') : 'n/a (coverage ' + R.genres.coverage.toFixed(2) + ')'}`);
    ok(!!R.archetype.name, `${label} ${p.key}: personality ${R.archetype.name} (${R.archetype.because})`);
  }
  return outs;
}

// ---------- drawing dry run ----------
function fakeCtx() {
  const calls = {n: 0, text: []};
  const st = {font: '10px serif'};
  const g = new Proxy({}, {
    get(_, k) {
      if (k === '__calls') return calls;
      if (k === 'measureText') return s => { const m = /(\d+)px/.exec(st.font); return {width: String(s).length * (m ? +m[1] : 10) * 0.5}; };
      if (k === 'fillText') return (s, x, y) => { calls.n++; calls.text.push(String(s)); if (!isFinite(x) || !isFinite(y)) throw new Error('bad text pos for ' + s); };
      if (k === 'createPattern') return () => ({});
      if (k === 'letterSpacing') return st.letterSpacing || '0px';
      if (k in st) return st[k];
      return (...a) => { calls.n++; for (const v of a) if (typeof v === 'number' && !isFinite(v)) throw new Error(k + ' got ' + v); };
    },
    set(_, k, v) { st[k] = v; return true; },
    has(_, k) { return k === 'letterSpacing'; },
  });
  return g;
}
function drawAll(label, R, opts) {
  for (const id of [...DR.FULL, 'locked']) {
    for (const H of [1920, 2340]) for (const p of [0, 0.4, 1, 2, 3.5, 99]) {
      const g = fakeCtx();
      try { DR.draw(g, id, H, p, R, opts); } catch (e) { ok(false, `${label}: draw ${id} H=${H} p=${p}: ${e.message}`); return; }
      if (p === 99 && H === 1920 && opts.check) {
        const t = g.__calls.text.join(' | ');
        ok(g.__calls.n > 10 && !/undefined|NaN|null/.test(t), `${label}: ${id} → ${t.slice(0, 150)}`);
      }
    }
  }
}

(async () => {
  const demo = RD.decode(JSON.parse(fs.readFileSync(path.join(web, 'static/demo.json'), 'utf8')));
  const outs = check('demo', demo.rows, demo.genres);
  drawAll('demo', outs[0], {name: 'Sam', full: true, check: true});
  outs.forEach((R, i) => drawAll('demo#' + i, R, {live: i % 2 === 0, full: i % 3 !== 0}));
  const noGenre = RD.compute(demo.rows, {}, RD.periods(demo.rows)[0]);
  ok(!noGenre.genres.ok, 'no genre data → genre slide falls back to artists');
  drawAll('demo-nogenre', noGenre, {check: false});
  // tiny period: one play
  const one = RD.compute([{t: Date.UTC(2025, 3, 1, 12), ms: 200000, tr: 'Only', ar: 'Solo', al: 'X'}], {}, yearOf());
  ok(!one.empty && one.streak.days === 1 && one.topTracks.length === 1, 'single play still makes a recap');
  drawAll('single', one, {check: false});
  ok(RD.compute([], {}, yearOf()).empty, 'empty period flagged');
  // long names
  const long = RD.compute([{t: Date.UTC(2025, 3, 1, 12), ms: 200000, tr: 'A Very Long Track Title That Goes On And On (Extended Remastered Version 2011)', ar: 'The Extraordinarily Long Named Orchestra and Friends', al: 'X'}], {}, yearOf());
  drawAll('long-names', long, {check: true});

  const zip = process.argv[2];
  if (zip) {
    // parse the export with the real upload.js parser, then recap it
    const ctx = {console, TextDecoder, TextEncoder, Blob, Response, DecompressionStream, CompressionStream, Uint8Array, DataView, ArrayBuffer, Date, Math, JSON, Map, Set, Promise, isFinite, Infinity, setTimeout};
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(web, 'static/js/upload.js'), 'utf8'), ctx);
    const buf = fs.readFileSync(zip);
    ctx.files = [{name: path.basename(zip), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)}];
    const {recs} = await vm.runInContext('readFiles(files)', ctx);
    const rows = recs.map(r => ({...r})).sort((a, b) => a.t - b.t);
    const zo = check('zip', rows, {});
    zo.forEach((R, i) => drawAll('zip#' + i, R, {check: i === 0, full: true}));
  }
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
