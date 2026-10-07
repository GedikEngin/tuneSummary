// DOM-less test of the browser code: parse a real-format export zip with upload.js, then (optionally)
// upload it to a running server and render the dashboard with dash.js in a fake DOM.
//   node tests/test_client.js EXPORT.zip                       parser only
//   node tests/test_client.js EXPORT.zip BASE_URL COOKIE       + upload + dashboard render through BASE_URL
const fs = require('fs'), vm = require('vm'), path = require('path');
const [zipPath, BASE, COOKIE] = process.argv.slice(2);
const web = path.join(__dirname, '..', 'web');
const src = f => fs.readFileSync(path.join(web, 'static/js', f), 'utf8');
const strip = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) fails++; };

const els = {};
const mk = id => ({id, innerHTML: '', textContent: '', value: '', style: {}, clientWidth: 900, dataset: {}, className: '',
  classList: {s: new Set(['hidden']), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, toggle(c, on) { (on ?? !this.s.has(c)) ? this.s.add(c) : this.s.delete(c); }, contains(c) { return this.s.has(c); }},
  addEventListener() {}, click() {}, scrollIntoView() {}, remove() {}, appendChild() {}, firstElementChild: {style: {}}, closest: () => null});
const store = {};
const ctx = {console, setTimeout, clearTimeout, setInterval: () => 0, URLSearchParams, TextDecoder, TextEncoder, Date, Math, JSON, Map, Set, Promise,
  isFinite, Infinity, Blob, Response, DecompressionStream, CompressionStream, Uint8Array, DataView, ArrayBuffer, Event: class {},
  location: {search: '', replace: u => { ctx.redirected = u; }, href: ''},
  document: {body: {dataset: {page: 'app'}}, documentElement: {getAttribute: () => null, setAttribute() {}}, head: {appendChild() {}},
    querySelector: s => els[s] || (els[s] = mk(s)), querySelectorAll: () => [], addEventListener() {}, createElement: () => mk('x'), dispatchEvent() {}},
  window: {addEventListener() {}}, localStorage: {getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = v},
  alert: m => console.log('ALERT', m), confirm: () => true, module: undefined,
  fetch: (u, o = {}) => fetch(new URL(u, BASE + '/app'), {...o, headers: {...(o.headers || {}), Cookie: 'ts_session=' + COOKIE, Origin: new URL(BASE).origin}})};
vm.createContext(ctx);

(async () => {
  vm.runInContext(src('upload.js'), ctx);
  const buf = fs.readFileSync(zipPath);
  const file = {name: path.basename(zipPath), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)};
  ctx.files = [file];
  const {recs, files} = await vm.runInContext('readFiles(files)', ctx);
  ok(recs.length > 1000 && files >= 1, `parsed ${recs.length} plays from ${files} history file(s) in the zip`);
  ok(recs.every((r, i) => !i || recs[i - 1].t <= r.t), 'sorted by time');
  ok(recs.some(r => r.x && r.pf), 'extended fields kept (skip info, platform)');
  const batches = vm.runInContext('toBatches(files_recs = ' + JSON.stringify(recs.slice(0, 50000)) + ')', ctx);
  ok(batches.reduce((s, b) => s + b.rows.length, 0) === Math.min(recs.length, 50000), `${batches.length} batch(es), rows preserved`);
  const raw = JSON.stringify(recs).length, compact = batches.reduce((s, b) => s + JSON.stringify(b).length, 0);
  ok(compact < raw, `compact batches ${Math.round(compact / 1024)} KB vs ${Math.round(raw / 1024)} KB plain records`);
  if (!BASE) process.exit(fails ? 1 : 0);

  // full browser flow against a server
  vm.runInContext(src('common.js'), ctx);
  ctx.recs = recs;
  const up = await vm.runInContext('uploadRecs(recs)', ctx);
  ok(up.rows === recs.length, `uploaded ${up.rows} plays, ${up.added} new`);
  vm.runInContext(src('dash.js'), ctx);
  await new Promise(r => setTimeout(r, 2500));
  ok(!ctx.redirected, 'dashboard did not bounce to sign-in');
  const k = strip(els['#kpis'].innerHTML);
  ok(/Minutes listened/.test(k) && /Top artist/.test(k), 'KPIs: ' + k.slice(0, 160));
  ok(/<rect class="b"/.test(els['#timeline'].innerHTML), 'timeline chart rendered');
  ok(els['#topTable'].innerHTML.includes('data-i="0"'), 'top tracks: ' + strip(els['#topTable'].innerHTML).slice(0, 100));
  vm.runInContext("topTab='artists';renderTop();openDetail(sortedTop()[0]);", ctx);
  ok(/Minutes/.test(els['#modalBody'].innerHTML), 'artist detail popup: ' + strip(els['#modalBody'].innerHTML).slice(0, 100));
  vm.runInContext("range={key:'wrapped'};update();", ctx);
  ok(/Since last Wrapped/.test(els['#rangeTitle'].textContent), 'range: ' + els['#rangeTitle'].textContent + ' → ' + strip(els['#kpis'].innerHTML).slice(0, 80));
  vm.runInContext("range={key:'all'};update();topTab='genres';renderTop();", ctx);
  ok(true, 'genres tab: ' + strip(els['#genreBox'].innerHTML).slice(-80) + ' | ' + strip(els['#topTable'].innerHTML).slice(0, 80));
  ok(/Skipped tracks \d+%/.test(strip(els['#habits'].innerHTML)), 'habits: ' + strip(els['#habits'].innerHTML).slice(0, 120));
  ok(/Platforms/.test(els['#devices'].innerHTML), 'devices rendered');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
