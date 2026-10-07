'use strict';
// Recap slides, drawn on a canvas. One drawing function per slide, called with the time since the slide started,
// so the same code makes the live story, the 1080×1920 PNGs and the video frames.
// Logical size is always 1080 wide; height is 1920 for exports and taller on tall phones (layouts anchor to H).
const RecapDraw = (() => {
  const W = 1080;
  const F = {serif: '"Instrument Serif", "Times New Roman", serif', mono: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    sans: '"IBM Plex Sans", system-ui, -apple-system, sans-serif'};
  // Palettes grow out of the Survey system (paper, ink, one signal orange) with a few print-like spot colours.
  const PAL = {
    paper: {bg: '#F1EEE6', ink: '#151513', mut: '#7A776D', acc: '#C2410C', acc2: '#24356B', soft: '#E2DCCD', light: true},
    night: {bg: '#121310', ink: '#ECE8DD', mut: '#8E8B82', acc: '#FF7A3D', acc2: '#E9C46A', soft: '#26271F'},
    signal: {bg: '#C2410C', ink: '#FFF4E8', mut: '#F6C3A0', acc: '#151513', acc2: '#FFD9B0', soft: '#AE3A0A'},
    navy: {bg: '#1D2B57', ink: '#F1EEE6', mut: '#A3AECF', acc: '#FF7A3D', acc2: '#9FB7E8', soft: '#283872'},
    moss: {bg: '#1E3529', ink: '#ECE8DD', mut: '#9DB09F', acc: '#E9C46A', acc2: '#FF7A3D', soft: '#2A4637'},
    blush: {bg: '#F2D7CB', ink: '#151513', mut: '#86665A', acc: '#C2410C', acc2: '#1D2B57', soft: '#E7C3B4', light: true},
    butter: {bg: '#F3E3B3', ink: '#151513', mut: '#776B4E', acc: '#1D2B57', acc2: '#C2410C', soft: '#E6D296', light: true},
  };
  // MusicBrainz genres are lower case: "r&b" → "R&B", "turkish pop" → "Turkish pop"
  const gname = s => s.replace(/\br&b\b/g, 'R&B').replace(/\b(edm|uk|us|idm|j|k)(?=[ -]|$)/g, m => m.toUpperCase()).replace(/^./, c => c.toUpperCase());
  const SERIES = p => [p.acc, p.acc2, p.ink, '#E9C46A', '#F2A58C'];

  // ---------- helpers ----------
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const eo = t => 1 - Math.pow(1 - t, 3);
  const eo4 = t => 1 - Math.pow(1 - t, 4);
  const eback = t => { const c = 1.5; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const k = (p, start, dur = 0.7, e = eo) => e(clamp((p - start) / dur));
  const n0 = v => Math.round(v).toLocaleString('en-US');
  const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const fmtD = (t, y = true) => { const d = new Date(t); return d.getDate() + ' ' + MON[d.getMonth()] + (y ? ' ' + d.getFullYear() : ''); };

  function font(g, size, fam = 'serif', style = '', weight = 400) { g.font = `${style} ${weight} ${size}px ${F[fam]}`; }
  function spacing(g, px) { if ('letterSpacing' in g) g.letterSpacing = px + 'px'; }
  // Largest size <= size (>= min) at which s fits maxW.
  function fit(g, s, maxW, size, fam = 'serif', style = '', min = 40) {
    let z = size; font(g, z, fam, style);
    while (z > min && g.measureText(s).width > maxW) { z -= 4; font(g, z, fam, style); }
    return z;
  }
  function ellip(g, s, maxW) {
    if (g.measureText(s).width <= maxW) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (g.measureText(s.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1; }
    return s.slice(0, lo).trimEnd() + '…';
  }
  function wrap(g, s, maxW, maxLines = 3) {
    const words = String(s).split(/\s+/), lines = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (g.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) { const rest = lines.slice(maxLines - 1).join(' '); lines.length = maxLines - 1; lines.push(ellip(g, rest, maxW)); }
    return lines.map(l => ellip(g, l, maxW));
  }
  // Big title that may take two lines: shrinks until it fits in `lines` lines.
  function fitBlock(g, s, maxW, size, fam, style, min, lines = 2) {
    let z = size;
    for (;;) { font(g, z, fam, style); const l = wrap(g, s, maxW, 99); if ((l.length <= lines && l.every(x => g.measureText(x).width <= maxW)) || z <= min) return {size: z, lines: wrap(g, s, maxW, lines)}; z -= 6; }
  }
  function txt(g, s, x, y, {size = 40, fam = 'sans', style = '', color = '#000', align = 'left', alpha = 1, ls = 0, maxW = 0} = {}) {
    font(g, size, fam, style); spacing(g, ls);
    g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic';
    const a = g.globalAlpha; g.globalAlpha = a * alpha;
    g.fillText(maxW ? ellip(g, s, maxW) : s, x, y);
    g.globalAlpha = a; spacing(g, 0);
  }
  const mono = (g, s, x, y, color, o = {}) => txt(g, String(s).toUpperCase(), x, y, {size: 28, fam: 'mono', color, ls: 3, ...o});
  // Fade + rise in, starting at `at` seconds.
  function rise(g, p, at, fn, dist = 46, dur = 0.7) {
    const v = k(p, at, dur);
    if (v <= 0) return;
    g.save(); g.globalAlpha *= v; g.translate(0, (1 - v) * dist); fn(v); g.restore();
  }
  function rule(g, x1, y, x2, color, alpha = 0.35, w = 2) { g.save(); g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = w; g.beginPath(); g.moveTo(x1, y); g.lineTo(x2, y); g.stroke(); g.restore(); }
  function square(g, x, y, s, color) { g.fillStyle = color; g.fillRect(x, y, s, s); }

  // Paper grain: one small noise tile, repeated. Static, so it costs little in the video encoder.
  let grainTile = null;
  function grain(g, H, pal) {
    if (typeof document === 'undefined' || !document.createElement) return;
    if (!grainTile) {
      grainTile = document.createElement('canvas'); grainTile.width = grainTile.height = 192;
      const c = grainTile.getContext('2d'), im = c.createImageData(192, 192), r = rng(42);
      for (let i = 0; i < im.data.length; i += 4) { const v = r() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 22; }
      c.putImageData(im, 0, 0);
    }
    g.save(); g.globalAlpha = pal.light ? 0.55 : 0.35; g.globalCompositeOperation = pal.light ? 'multiply' : 'screen';
    g.fillStyle = g.createPattern(grainTile, 'repeat'); g.fillRect(0, 0, W, H); g.restore();
  }

  // Header (label + page number) and, for exports, the footer watermark.
  function frame(g, H, pal, S, label, o) {
    const top = o.live ? 112 : 84;
    square(g, 80, top - 22, 22, pal.acc === pal.bg ? pal.ink : pal.acc);
    mono(g, 'TuneSummary', 118, top, pal.ink, {size: 26});
    if (o.live) { font(g, 26, 'mono'); spacing(g, 3); const w = g.measureText('TUNESUMMARY').width; spacing(g, 0); mono(g, '/ ' + label, 118 + w + 22, top, pal.mut, {size: 26, maxW: W - 420 - w}); }
    else mono(g, label, W - 80, top, pal.mut, {size: 26, align: 'right'});
    rule(g, 80, top + 26, W - 80, pal.ink, 0.25);
    if (!o.live) {
      rule(g, 80, H - 118, W - 80, pal.ink, 0.25);
      square(g, 80, H - 82, 18, pal.acc === pal.bg ? pal.ink : pal.acc);
      mono(g, 'TuneSummary recap', 112, H - 64, pal.ink, {size: 24});
      mono(g, 'gedik.tech/tunesummary', W - 80, H - 64, pal.mut, {size: 24, align: 'right'});
    }
  }
  // Background colour + grain, rendered once per palette and height, then blitted (compositing the grain every
  // frame costs ~30 ms on software canvases, which starves the video recorder).
  const bgCache = new Map();
  function bg(g, H, pal) {
    if (typeof document === 'undefined' || !document.createElement) { g.fillStyle = pal.bg; g.fillRect(0, 0, W, H); return; }
    const key = pal.bg + '|' + H;
    let c = bgCache.get(key);
    if (!c) {
      c = document.createElement('canvas'); c.width = W; c.height = H;
      const cg = c.getContext('2d'); cg.fillStyle = pal.bg; cg.fillRect(0, 0, W, H); grain(cg, H, pal);
      if (bgCache.size > 24) bgCache.clear();
      bgCache.set(key, c);
    }
    g.drawImage(c, 0, 0);
  }

  // ---------- generative pieces ----------
  // A poster of flat shapes on a 3×3 grid, seeded by a name: same artist, same poster.
  function poster(g, seed, x0, y0, size, pal, p) {
    const r = rng(hash(seed)), cell = size / 3, cols = [pal.acc, pal.acc2, pal.ink, pal.soft];
    const kinds = ['circle', 'half', 'quarter', 'stripes', 'ring', 'tri', 'dots', 'half'];
    const n = 6 + Math.floor(r() * 3), used = new Set();
    for (let i = 0; i < n; i++) {
      let c; do c = Math.floor(r() * 9); while (used.has(c) && used.size < 9); used.add(c);
      const span = r() < 0.25 && c % 3 < 2 && c < 6 ? 2 : 1;
      const x = x0 + (c % 3) * cell, y = y0 + Math.floor(c / 3) * cell, s = cell * span;
      const kind = kinds[Math.floor(r() * kinds.length)], col = cols[Math.floor(r() * cols.length)], rot = Math.floor(r() * 4) * Math.PI / 2;
      const v = k(p, 0.15 + i * 0.09, 0.8, eback);
      if (v <= 0) continue;
      g.save(); g.translate(x + s / 2, y + s / 2); g.rotate(rot + (kind === 'ring' ? p * 0.25 : 0)); g.scale(v, v);
      g.fillStyle = col; g.strokeStyle = col;
      const h = s / 2 - 6;
      if (kind === 'circle') { g.beginPath(); g.arc(0, 0, h, 0, Math.PI * 2); g.fill(); }
      else if (kind === 'half') { g.beginPath(); g.arc(0, h, h * 2 - 10, Math.PI, 0); g.closePath(); g.save(); g.clip(); g.fillRect(-h, -h, h * 2, h * 2); g.restore(); }
      else if (kind === 'quarter') { g.beginPath(); g.moveTo(-h, h); g.arc(-h, h, h * 2, -Math.PI / 2, 0); g.closePath(); g.fill(); }
      else if (kind === 'stripes') { for (let j = 0; j < 5; j++) g.fillRect(-h, -h + j * (h * 2 / 5), h * 2, h * 2 / 10); }
      else if (kind === 'ring') { g.lineWidth = h * 0.32; g.beginPath(); g.arc(0, 0, h * 0.8, 0, Math.PI * 1.5); g.stroke(); }
      else if (kind === 'tri') { g.beginPath(); g.moveTo(-h, h); g.lineTo(h, h); g.lineTo(-h, -h); g.closePath(); g.fill(); }
      else if (kind === 'dots') { for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) { g.beginPath(); g.arc(-h + h / 4 + a * h / 2, -h + h / 4 + b * h / 2, h / 9, 0, Math.PI * 2); g.fill(); } }
      g.restore();
    }
  }
  // Concentric grooves with a turning highlight, like a record seen from above.
  function grooves(g, cx, cy, pal, p, rMax = 640) {
    const v = k(p, 0, 1.2);
    g.save(); g.strokeStyle = pal.ink; g.lineWidth = 2;
    for (let r = 90, i = 0; r < rMax * v; r += 24, i++) { g.globalAlpha = 0.10 + (i % 4 === 0 ? 0.08 : 0); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke(); }
    g.globalAlpha = 1; g.strokeStyle = pal.acc; g.lineWidth = 10; g.lineCap = 'round';
    const a0 = -Math.PI / 2 + p * 0.6;
    for (const [r, len] of [[rMax * 0.82, 0.9], [rMax * 0.6, 0.5], [rMax * 0.4, 1.3]]) if (r < rMax * v) { g.beginPath(); g.arc(cx, cy, r, a0 + r / 200, a0 + r / 200 + len); g.stroke(); }
    const s = k(p, 0.3, 0.9, eback);
    g.fillStyle = pal.acc; g.beginPath(); g.arc(cx, cy, 120 * s, 0, Math.PI * 2); g.fill();
    g.fillStyle = pal.bg; g.beginPath(); g.arc(cx, cy, 14 * s, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  // ---------- slides ----------
  function periodWords(R) {
    const P = R.period;
    if (P.kind === 'all') return {big: ['Your story', 'in sound.'], em: 'story', range: fmtD(P.from) + ' — ' + fmtD(P.to), short: 'All time'};
    if (P.key === 'wrapped') return {big: ['Your year', 'in sound.'], em: 'year', range: fmtD(P.from) + ' — ' + fmtD(P.to), short: fmtD(P.from) + ' — ' + fmtD(P.to)};
    return {big: ['Your ' + P.year, 'in sound.'], em: String(P.year), range: fmtD(P.from) + ' — ' + fmtD(P.to), short: String(P.year)};
  }
  // Draws "Your <em>year</em>" with the em word in italic accent.
  function mixedLine(g, line, em, x, y, size, pal) {
    const i = em ? line.indexOf(em) : -1;
    if (i < 0) { txt(g, line, x, y, {size, fam: 'serif', color: pal.ink}); return; }
    const a = line.slice(0, i), b = line.slice(i, i + em.length), c = line.slice(i + em.length);
    font(g, size, 'serif'); const wa = g.measureText(a).width;
    font(g, size, 'serif', 'italic'); const wb = g.measureText(b).width;
    txt(g, a, x, y, {size, fam: 'serif', color: pal.ink});
    txt(g, b, x + wa, y, {size, fam: 'serif', style: 'italic', color: pal.acc});
    txt(g, c, x + wa + wb, y, {size, fam: 'serif', color: pal.ink});
  }

  function sIntro(g, H, p, R, o) {
    const pal = PAL.paper, w = periodWords(R);
    bg(g, H, pal);
    grooves(g, W * 0.74, H * 0.3, pal, p, 600);
    frame(g, H, pal, null, 'Recap', o);
    const y = H * 0.56;
    rise(g, p, 0.25, () => mono(g, o.name ? 'For ' + o.name : 'Your listening recap', 80, y, pal.acc, {size: 30, maxW: W - 160}));
    let size = 210; font(g, size, 'serif'); while (size > 120 && g.measureText(w.big[0]).width > W - 160) { size -= 6; font(g, size, 'serif'); }
    rise(g, p, 0.45, () => mixedLine(g, w.big[0], w.em, 74, y + size * 1.0, size, pal));
    rise(g, p, 0.65, () => mixedLine(g, w.big[1], null, 74, y + size * 1.9, size, pal));
    rise(g, p, 0.95, () => { rule(g, 80, y + size * 2.25, W - 80, pal.ink, 0.6); mono(g, w.range, 80, y + size * 2.25 + 52, pal.ink, {size: 28}); mono(g, n0(R.plays) + ' plays', W - 80, y + size * 2.25 + 52, pal.mut, {size: 28, align: 'right'}); });
  }

  function sMinutes(g, H, p, R, o) {
    const pal = PAL.night, T = R.totals;
    bg(g, H, pal); frame(g, H, pal, null, '02 Minutes', o);
    const y0 = H * 0.2;
    rise(g, p, 0.1, () => mono(g, 'You listened for', 80, y0, pal.mut, {size: 30}));
    const v = Math.round(T.minutes * k(p, 0.25, 1.5, eo4));
    const z = fit(g, n0(T.minutes), W - 150, 300, 'serif', '', 120);
    rise(g, p, 0.2, () => txt(g, n0(v), 70, y0 + z * 0.95, {size: z, fam: 'serif', color: pal.ink}), 30, 0.5);
    rise(g, p, 0.5, () => txt(g, 'minutes.', 76, y0 + z * 0.95 + 130, {size: 130, fam: 'serif', style: 'italic', color: pal.acc}));
    const days = T.days;
    const y1 = y0 + z * 0.95 + 250;
    rise(g, p, 1.5, () => {
      const what = days >= 1 ? `${days >= 10 ? Math.round(days) : days.toFixed(1)} whole days` : T.hours >= 1 ? `${T.hours.toFixed(1)} hours` : `${n0(T.minutes)} minutes`;
      txt(g, `That's ${what} of sound,`, 80, y1, {size: 46, color: pal.ink, maxW: W - 160});
      txt(g, `about ${n0(T.avgPerDay)} minutes for every day.`, 80, y1 + 62, {size: 46, color: pal.mut, maxW: W - 160});
    });
    // one block per day of listening (or per N days for long periods)
    // one block per unit of listening; the unit is picked so there are at most ~60 blocks
    const units = [[1, '1 hour'], [2, '2 hours'], [4, '4 hours'], [6, '6 hours'], [12, '12 hours'], [24, '24 hours'], [48, '2 days'], [120, '5 days'], [240, '10 days'], [720, '30 days']];
    const [uh, ulabel] = units.find(u => T.hours / u[0] <= 60) || units[units.length - 1];
    const n = T.hours / uh, cols = n > 40 ? 10 : 8, gap = 14, s = (W - 160 - gap * (cols - 1)) / cols;
    const top = y1 + 130, rows = Math.ceil(n / cols), maxRows = Math.floor((H - (o.live ? 300 : 230) - top) / (s + gap));
    const shown = Math.min(rows, maxRows);
    const fill = n * k(p, 1.0, 1.6, eo);
    for (let i = 0; i < shown * cols; i++) {
      const x = 80 + (i % cols) * (s + gap), y = top + Math.floor(i / cols) * (s + gap);
      if (i >= Math.ceil(n)) break;
      g.save(); g.strokeStyle = pal.ink; g.globalAlpha = 0.25; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, s - 2, s - 2); g.restore();
      const f = clamp(fill - i);
      if (f > 0) { g.fillStyle = pal.acc; g.fillRect(x, y + s * (1 - f), s, s * f); }
    }
    rise(g, p, 2, () => mono(g, `■ = ${ulabel} of listening`, 80, top + shown * (s + gap) + 30, pal.mut, {size: 24}));
  }

  function sArtist(g, H, p, R, o) {
    const A = R.topArtist, keys = ['signal', 'navy', 'moss', 'blush', 'butter'], pal = PAL[keys[hash(A.name) % keys.length]];
    bg(g, H, pal); frame(g, H, pal, null, '03 Top artist', o);
    const size = Math.min(W - 160, H * 0.42);
    poster(g, A.name, (W - size) / 2, H * 0.11, size, pal, p);
    const y = H * 0.11 + size + 90;
    rise(g, p, 0.7, () => mono(g, 'Your top artist', 80, y, pal.mut, {size: 30}));
    font(g, 10, 'serif');
    const b = fitBlock(g, A.name, W - 160, 200, 'serif', '', 80, 2);
    rise(g, p, 0.85, () => b.lines.forEach((l, i) => txt(g, l, 74, y + b.size * (0.95 + i * 0.92), {size: b.size, fam: 'serif', color: pal.ink})));
    const y2 = y + b.size * (0.95 + (b.lines.length - 1) * 0.92) + 80;
    rise(g, p, 1.2, () => {
      txt(g, `${n0(A.minutes)} minutes, ${Math.round(A.share * 100)}% of everything you played.`, 80, y2, {size: 42, color: pal.ink, maxW: W - 160});
      mono(g, `#1 of ${n0(R.totals.artists)} artists · ${n0(A.plays)} plays`, 80, y2 + 64, pal.mut, {size: 26});
    });
  }

  function sTracks(g, H, p, R, o) {
    const pal = PAL.paper, L = R.topTracks;
    bg(g, H, pal); frame(g, H, pal, null, '04 Top tracks', o);
    const bottom = H - (o.live ? 300 : 200), rh = Math.min(250, (bottom - 420) / 5), dy = Math.max(0, (bottom - 420 - rh * 5) * 0.45), top = 420 + dy;
    rise(g, p, 0.1, () => { txt(g, 'On', 74, 330 + dy, {size: 170, fam: 'serif', color: pal.ink}); font(g, 170, 'serif'); txt(g, 'repeat.', 74 + g.measureText('On ').width, 330 + dy, {size: 170, fam: 'serif', style: 'italic', color: pal.acc}); });
    const max = L[0] ? L[0].plays || 1 : 1;
    L.forEach((t, i) => {
      const y = top + i * rh, v = k(p, 0.45 + i * 0.16, 0.7);
      if (v <= 0) return;
      g.save(); g.globalAlpha = v; g.translate((1 - v) * 120, 0);
      rule(g, 80, y, W - 80, pal.ink, i ? 0.2 : 0.6);
      txt(g, String(i + 1).padStart(2, '0'), 80, y + rh * 0.62, {size: Math.min(130, rh * 0.62), fam: 'serif', style: 'italic', color: i ? pal.mut : pal.acc});
      const x = 250, z = fit(g, t.name, W - x - 80, i ? 64 : 76, 'serif', '', 44);
      txt(g, t.name, x, y + rh * 0.42, {size: z, fam: 'serif', color: pal.ink, maxW: W - x - 80});
      mono(g, t.artist, x, y + rh * 0.42 + 46, pal.mut, {size: 24, maxW: W - x - 300});
      mono(g, n0(t.plays) + ' plays', W - 80, y + rh * 0.42 + 46, pal.ink, {size: 24, align: 'right'});
      const bw = (W - x - 80) * (t.plays / max) * k(p, 0.7 + i * 0.16, 0.9);
      g.fillStyle = i ? pal.ink : pal.acc; g.globalAlpha *= i ? 0.7 : 1; g.fillRect(x, y + rh * 0.42 + 70, bw, 8);
      g.restore();
    });
  }

  function sGenres(g, H, p, R, o) {
    const pal = PAL.navy, G = R.genres;
    bg(g, H, pal); frame(g, H, pal, null, '05 Your sound', o);
    let items, title, center, note = '';
    if (G.ok) {
      items = G.list.map(x => ({name: gname(x.name), share: x.share})); if (G.other > 0.005) items.push({name: 'everything else', share: G.other, other: true});
      title = gname(G.top); center = Math.round(G.list[0].share * 100) + '%';
      if (G.coverage < 0.6) note = `genres known for ${Math.round(G.coverage * 100)}% of your minutes`;
    } else {
      items = R.topArtists.map(a => ({name: a.name, share: a.share}));
      const rest = 1 - items.reduce((s, x) => s + x.share, 0); if (rest > 0.005) items.push({name: 'everyone else', share: rest, other: true});
      title = 'five names'; center = Math.round(items[0].share * 100) + '%'; note = 'genres are still being looked up, check back soon';
    }
    rise(g, p, 0.1, () => {
      txt(g, G.ok ? 'Mostly' : 'Your sound, in', 74, 300, {size: 120, fam: 'serif', color: pal.ink});
      const z = fit(g, title + '.', W - 160, 130, 'serif', 'italic', 64);
      txt(g, title + '.', 74, 300 + Math.max(z, 100) * 1.0, {size: z, fam: 'serif', style: 'italic', color: pal.acc, maxW: W - 160});
    });
    const cx = W / 2, cy = Math.max(H * 0.45, 820), R0 = 270, th = 110, cols = SERIES(pal);
    const sweep = k(p, 0.4, 1.5, eo) * Math.PI * 2;
    let a = -Math.PI / 2;
    g.save(); g.lineWidth = th;
    items.forEach((it, i) => {
      const len = it.share * Math.PI * 2, end = Math.min(a + len, -Math.PI / 2 + sweep);
      if (end > a) { g.strokeStyle = it.other ? 'rgba(241,238,230,.18)' : cols[i % cols.length]; g.beginPath(); g.arc(cx, cy, R0, a, Math.max(a, end - 0.012)); g.stroke(); }
      a += len;
    });
    g.restore();
    rise(g, p, 1.1, () => { txt(g, center, cx, cy + 30, {size: 120, fam: 'serif', color: pal.ink, align: 'center'}); mono(g, 'of it', cx, cy + 82, pal.mut, {size: 24, align: 'center'}); }, 20);
    const ly = cy + R0 + th / 2 + 80, lh = Math.min(70, (H - (o.live ? 300 : 200) - ly) / items.length);
    items.forEach((it, i) => rise(g, p, 0.9 + i * 0.12, () => {
      const y = ly + i * lh;
      g.fillStyle = it.other ? 'rgba(241,238,230,.18)' : cols[i % cols.length]; g.fillRect(80, y - 30, 30, 30);
      txt(g, it.name, 136, y, {size: 40, color: it.other ? pal.mut : pal.ink, maxW: W - 400});
      mono(g, Math.round(it.share * 100) + '%', W - 80, y - 2, pal.ink, {size: 28, align: 'right'});
    }, 20));
    if (note) rise(g, p, 1.8, () => mono(g, note, 80, ly + items.length * lh + 16, pal.mut, {size: 22, maxW: W - 160}));
  }

  function sClock(g, H, p, R, o) {
    const C = R.clock, pal = C.type === 'morning' ? PAL.butter : C.type === 'afternoon' ? PAL.blush : PAL.night;
    bg(g, H, pal); frame(g, H, pal, null, '06 When you listen', o);
    rise(g, p, 0.1, () => {
      mono(g, 'Your clock says', 80, 240, pal.mut, {size: 30});
      const z = fit(g, C.title + '.', W - 160, 150, 'serif', 'italic', 80);
      txt(g, C.title + '.', 74, 240 + z * 0.95, {size: z, fam: 'serif', style: 'italic', color: pal.acc});
    });
    const cx = W / 2, cy = Math.max(H * 0.47, 900), r0 = 150, rl = 250, max = Math.max(1, ...C.hours);
    g.save(); g.strokeStyle = pal.ink; g.globalAlpha = 0.2; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, r0 - 14, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(cx, cy, r0 + rl + 14, 0, Math.PI * 2); g.stroke(); g.restore();
    g.save(); g.lineCap = 'round'; g.lineWidth = 30;
    C.hours.forEach((m, h) => {
      const ang = h / 24 * Math.PI * 2 - Math.PI / 2, len = Math.max(6, rl * m / max) * k(p, 0.4 + h * 0.035, 0.8, eback);
      g.strokeStyle = h === C.peakHour ? pal.acc : pal.ink; g.globalAlpha = h === C.peakHour ? 1 : 0.75;
      g.beginPath(); g.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0); g.lineTo(cx + Math.cos(ang) * (r0 + len), cy + Math.sin(ang) * (r0 + len)); g.stroke();
    });
    g.restore();
    rise(g, p, 0.3, () => [['12 am', 0], ['6 am', 6], ['12 pm', 12], ['6 pm', 18]].forEach(([l, h]) => {
      const ang = h / 24 * Math.PI * 2 - Math.PI / 2, rr = r0 + rl + 54;
      mono(g, l, cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr + 9, pal.mut, {size: 22, align: 'center'});
    }), 0);
    rise(g, p, 1.3, () => { txt(g, C.peakLabel, cx, cy + 22, {size: 84, fam: 'serif', color: pal.ink, align: 'center'}); mono(g, 'peak hour', cx, cy + 66, pal.mut, {size: 22, align: 'center'}); }, 16);
    const by = cy + r0 + rl + 170, B = C.buckets, cw = (W - 160) / 4;
    [['Morning', B.morning], ['Afternoon', B.afternoon], ['Evening', B.evening], ['Night', B.night]].forEach(([l, v], i) => rise(g, p, 1.5 + i * 0.1, () => {
      const x = 80 + i * cw, on = l.toLowerCase() === C.type;
      rule(g, x, by - 70, x + cw - 20, on ? pal.acc : pal.ink, on ? 1 : 0.3, on ? 6 : 2);
      txt(g, Math.round(v * 100) + '%', x, by, {size: 72, fam: 'serif', color: on ? pal.acc : pal.ink});
      mono(g, l, x, by + 44, pal.mut, {size: 22});
    }, 20));
  }

  function sDays(g, H, p, R, o) {
    const pal = PAL.blush, D = R.biggestDay, S = R.streak, T = R.totals;
    bg(g, H, pal); frame(g, H, pal, null, '07 Big days', o);
    const d = new Date(D.date);
    rise(g, p, 0.1, () => {
      mono(g, 'Your biggest day', 80, 250, pal.mut, {size: 30});
      const s = DOW[d.getDay()] + ', ' + fmtD(D.date, false);
      const z = fit(g, s, W - 160, 120, 'serif', '', 70);
      txt(g, s, 74, 250 + z * 1.0, {size: z, fam: 'serif', color: pal.ink});
      txt(g, d.getFullYear() + '', 76, 250 + z * 1.0 + 100, {size: 90, fam: 'serif', style: 'italic', color: pal.acc});
    });
    const by = 560, bw = W - 160, m = Math.max(D.minutes, T.avgActive) || 1;
    [['That day', D.minutes, pal.acc], ['A usual listening day', T.avgActive, pal.ink]].forEach(([l, v, c], i) => rise(g, p, 0.6 + i * 0.2, () => {
      const y = by + i * 120;
      mono(g, l, 80, y, pal.ink, {size: 24});
      mono(g, n0(v) + ' min', W - 80, y, pal.ink, {size: 24, align: 'right'});
      g.fillStyle = c; g.globalAlpha *= i ? 0.55 : 1; g.fillRect(80, y + 22, bw * (v / m) * k(p, 0.8 + i * 0.2, 1), 40);
    }, 20));
    const y2 = Math.max(H * 0.5, 920);
    rise(g, p, 1.0, () => { rule(g, 80, y2 - 60, W - 80, pal.ink, 0.5); mono(g, 'Longest streak', 80, y2, pal.mut, {size: 30}); });
    const z = 230, v = Math.round(S.days * k(p, 1.1, 1.2, eo4));
    rise(g, p, 1.1, () => {
      txt(g, n0(v), 70, y2 + z * 0.92, {size: z, fam: 'serif', color: pal.ink});
      font(g, z, 'serif'); const w = g.measureText(n0(S.days)).width;
      txt(g, S.days === 1 ? 'day' : 'days', 70 + w + 24, y2 + z * 0.92, {size: 110, fam: 'serif', style: 'italic', color: pal.acc});
      txt(g, `in a row with music, ${fmtD(S.start, false)} to ${fmtD(S.end)}.`, 80, y2 + z * 0.92 + 74, {size: 40, color: pal.ink, maxW: W - 160});
    }, 30);
    // tally marks, one per day (groups of five), or one per week for long streaks
    const perMark = S.days > 140 ? 7 : 1, marks = Math.ceil(S.days / perMark), top = y2 + z * 0.92 + 150;
    const mh = 64, gx = 22, groupW = 4 * gx + 40, perRow = Math.floor((W - 160) / groupW) * 5;
    const maxRows = Math.max(1, Math.floor((H - (o.live ? 300 : 210) - top) / (mh + 34)));
    const shown = Math.min(marks, perRow * maxRows), drawn = shown * k(p, 1.4, 1.6, eo);
    g.save(); g.strokeStyle = pal.ink; g.lineWidth = 6; g.lineCap = 'round';
    for (let i = 0; i < Math.floor(drawn); i++) {
      const row = Math.floor(i / perRow), j = i % perRow, grp = Math.floor(j / 5), inG = j % 5;
      const x = 80 + grp * groupW + inG * gx, y = top + row * (mh + 34);
      g.beginPath();
      if (inG < 4) { g.moveTo(x, y); g.lineTo(x, y + mh); } else { g.strokeStyle = pal.acc; g.moveTo(x - 4 * gx - 10, y + mh - 8); g.lineTo(x + 6, y + 8); }
      g.stroke(); g.strokeStyle = pal.ink;
    }
    g.restore();
    if (perMark > 1 || shown < marks) rise(g, p, 2, () => mono(g, perMark > 1 ? 'one mark = one week' : `+${n0(marks - shown)} more`, 80, top + Math.ceil(shown / perRow) * (mh + 34) + 10, pal.mut, {size: 22}), 0);
  }

  // A small emblem per personality.
  function emblem(g, key, cx, cy, s, pal, p) {
    const v = k(p, 0.2, 1.1, eback), t = p;
    g.save(); g.translate(cx, cy); g.scale(v, v); g.fillStyle = pal.acc; g.strokeStyle = pal.ink; g.lineWidth = 12; g.lineCap = 'round';
    const C = (x, y, r, fill = true) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); fill ? g.fill() : g.stroke(); };
    if (key === 'loyalist') { for (let i = 4; i >= 1; i--) { g.globalAlpha = 0.25 + 0.15 * (4 - i); C(0, 0, s * i / 4, false); } g.globalAlpha = 1; g.fillStyle = pal.ink; C(0, 0, s * 0.18); const a = t * 0.8; g.fillStyle = pal.acc2; C(Math.cos(a) * s * 0.75, Math.sin(a) * s * 0.75, s * 0.11); }
    else if (key === 'repeat') { g.rotate(t * 0.5); for (let i = 0; i < 3; i++) { g.globalAlpha = 1 - i * 0.28; g.beginPath(); g.arc(0, 0, s * (0.95 - i * 0.27), 0.3, Math.PI * 1.75); g.stroke(); } g.globalAlpha = 1; C(s * 0.95 * Math.cos(Math.PI * 1.75), s * 0.95 * Math.sin(Math.PI * 1.75), 20); }
    else if (key === 'nightowl') { g.fillStyle = pal.ink; C(0, 0, s * 0.8); g.fillStyle = pal.bg; C(s * 0.36, -s * 0.22, s * 0.7); g.fillStyle = pal.ink; const r = rng(7); for (let i = 0; i < 9; i++) { g.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(t * 2 + i)); C((r() - 0.3) * s * 2.2, (r() - 0.5) * s * 2, 6 + r() * 6); } }
    else if (key === 'earlybird') { g.fillStyle = pal.ink; g.beginPath(); g.arc(0, s * 0.4, s * 0.6, Math.PI, 0); g.fill(); for (let i = 0; i < 9; i++) { const a = Math.PI + i * Math.PI / 8; const l = s * (0.78 + 0.08 * Math.sin(t * 3 + i)); g.beginPath(); g.moveTo(Math.cos(a) * s * 0.72, s * 0.4 + Math.sin(a) * s * 0.72); g.lineTo(Math.cos(a) * (l + s * 0.2), s * 0.4 + Math.sin(a) * (l + s * 0.2)); g.stroke(); } rule(g, -s, s * 0.46, s, pal.ink, 1, 12); }
    else if (key === 'explorer') { const r = rng(11), pts = []; for (let i = 0; i < 9; i++) pts.push([(r() - 0.5) * s * 2, (r() - 0.5) * s * 1.7]); g.setLineDash([2, 22]); g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.setLineDash([]); pts.forEach(([x, y], i) => { g.fillStyle = i === pts.length - 1 ? pal.acc : pal.ink; C(x, y, i === pts.length - 1 ? 26 : 13); }); }
    else if (key === 'skipper') { for (let i = 0; i < 3; i++) { const x = -s * 0.75 + i * s * 0.6 + ((t * 120) % (s * 0.6)) * 0.3; g.globalAlpha = 0.4 + i * 0.3; g.beginPath(); g.moveTo(x, -s * 0.5); g.lineTo(x + s * 0.4, 0); g.lineTo(x, s * 0.5); g.stroke(); } g.globalAlpha = 1; g.fillStyle = pal.ink; g.fillRect(s * 0.85, -s * 0.5, 16, s); }
    else if (key === 'marathoner') { for (let i = 0; i < 4; i++) { g.globalAlpha = 0.35 + i * 0.2; const w = s * (1 - i * 0.18), h = s * (0.6 - i * 0.12); g.beginPath(); g.ellipse(0, 0, w, h, 0, 0, Math.PI * 2); g.lineWidth = 8; g.stroke(); } g.globalAlpha = 1; const a = t * 1.2; C(Math.cos(a) * s, Math.sin(a) * s * 0.6, 22); }
    else if (key === 'genrehopper') { const cols = [pal.acc, pal.ink, pal.acc2, pal.soft], q = s * 0.5; let i = 0; for (let a = -2; a < 2; a++) for (let b = -2; b < 2; b++) { g.fillStyle = cols[(i++ * 7 + a + 13) % 4]; const kk = k(p, 0.2 + i * 0.04, 0.5); if (kk > 0) g.fillRect(a * q + 4, b * q + 4, (q - 8) * kk, (q - 8)); } }
    else { for (let i = 0; i < 4; i++) { g.fillStyle = [pal.acc, pal.ink, pal.acc2, pal.soft][i]; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, s * 0.85, i * Math.PI / 2 + t * 0.2, (i + 1) * Math.PI / 2 + t * 0.2 - 0.06); g.closePath(); g.fill(); } }
    g.restore();
  }

  function sPersona(g, H, p, R, o) {
    const pal = PAL.signal, X = R.archetype;
    bg(g, H, pal); frame(g, H, pal, null, '08 Personality', o);
    const ps = {...pal, acc: pal.ink, ink: '#151513', acc2: pal.acc2, soft: pal.soft, bg: pal.bg};
    emblem(g, X.key, W / 2, H * 0.27, 210, ps, p);
    const y = Math.max(H * 0.5, 960);
    rise(g, p, 0.6, () => mono(g, 'Your listening personality', 80, y, pal.mut, {size: 28}));
    const name = X.name.replace(/^The /, '');
    const b = fitBlock(g, name, W - 160, 190, 'serif', '', 90, 2);
    rise(g, p, 0.8, () => {
      txt(g, 'The', 76, y + 100, {size: 90, fam: 'serif', style: 'italic', color: pal.ink});
      b.lines.forEach((l, i) => txt(g, l, 72, y + 100 + b.size * (0.95 + i * 0.9), {size: b.size, fam: 'serif', color: pal.ink}));
    });
    const yb = y + 100 + b.size * (0.95 + (b.lines.length - 1) * 0.9) + 90;
    rise(g, p, 1.2, () => { font(g, 46, 'sans'); wrap(g, X.line, W - 160, 3).forEach((l, i) => txt(g, l, 80, yb + i * 60, {size: 46, color: pal.ink})); });
    rise(g, p, 1.6, () => {
      const by = yb + 170; font(g, 26, 'mono'); spacing(g, 3);
      const ls = wrap(g, ('Because: ' + X.because).toUpperCase(), W - 220, 2), w = Math.max(...ls.map(l => g.measureText(l).width)); spacing(g, 0);
      g.strokeStyle = pal.ink; g.lineWidth = 2; g.strokeRect(80, by - 46, w + 52, 30 + ls.length * 40);
      ls.forEach((l, i) => mono(g, l, 106, by + i * 40, pal.ink, {size: 26}));
      if (X.runnerUp) mono(g, 'Runner-up: ' + X.runnerUp, 80, by + ls.length * 40 + 64, pal.mut, {size: 24});
    });
  }

  function sOutro(g, H, p, R, o) {
    const pal = PAL.paper, w = periodWords(R), T = R.totals;
    bg(g, H, pal); frame(g, H, pal, null, w.short, o);
    rise(g, p, 0.1, () => {
      if (o.name) mono(g, o.name, 80, 230, pal.acc, {size: 28, maxW: W - 160});
      mixedLine(g, w.big[0] + ',', w.em, 74, 360, 140, pal);
      txt(g, 'in numbers.', 74, 490, {size: 140, fam: 'serif', color: pal.ink});
    });
    const full = o.full !== false;
    const cells = [
      ['Minutes', n0(T.minutes)], ['Top artist', R.topArtist.name],
      ['Top track', full && R.topTracks[0] ? R.topTracks[0].name : '—'], ['Top genre', full && R.genres.ok ? gname(R.genres.top) : '—'],
      ['Personality', full ? R.archetype.name.replace(/^The /, '') : '—'], ['Longest streak', full ? R.streak.days + ' days' : '—'],
    ];
    if (!full) { cells[2] = ['Streams', n0(T.streams)]; cells[3] = ['Artists', n0(T.artists)]; cells[4] = ['Tracks', n0(T.tracks)]; cells[5] = ['Active days', n0(T.activeDays)]; }
    const top = 580, bottom = H - (o.live ? 300 : 170), ch = Math.min(300, (bottom - top) / 3), cw = (W - 160) / 2;
    cells.forEach(([l, v], i) => rise(g, p, 0.4 + i * 0.12, () => {
      const x = 80 + (i % 2) * cw, y = top + Math.floor(i / 2) * ch;
      g.save(); g.strokeStyle = pal.ink; g.globalAlpha = 0.3; g.lineWidth = 2; g.strokeRect(x, y, cw, ch); g.restore();
      if (i === 0) { g.fillStyle = 'rgba(194,65,12,.10)'; g.fillRect(x + 1, y + 1, cw - 2, ch - 2); }
      mono(g, l, x + 32, y + 58, i === 0 ? pal.acc : pal.mut, {size: 24});
      const b = fitBlock(g, v, cw - 64, i === 0 ? 120 : 76, 'serif', i === 4 ? 'italic' : '', 40, 2);
      const lh = b.size * 0.98, by = y + ch - 40 - (b.lines.length - 1) * lh;
      b.lines.forEach((ln, j) => txt(g, ln, x + 30, by + j * lh, {size: b.size, fam: 'serif', style: i === 4 ? 'italic' : '', color: i === 4 ? pal.acc : pal.ink}));
    }, 24));
    rise(g, p, 1.3, () => mono(g, 'Make yours, free: gedik.tech/tunesummary', 80, top + 3 * ch + 64, pal.ink, {size: 24, maxW: W - 160}));
  }

  function sLocked(g, H, p, R, o) {
    const pal = PAL.night;
    bg(g, H, pal); frame(g, H, pal, null, 'More', o);
    rise(g, p, 0.1, () => { txt(g, "There's", 74, 330, {size: 170, fam: 'serif', color: pal.ink}); txt(g, 'more.', 74, 490, {size: 170, fam: 'serif', style: 'italic', color: pal.acc}); });
    const items = ['Your top 5 tracks', 'Your genre mix', 'Your listening clock', 'Biggest day & longest streak', 'Your listening personality', 'Video of the whole story'];
    items.forEach((s, i) => rise(g, p, 0.4 + i * 0.1, () => {
      const y = 640 + i * 105;
      rule(g, 80, y - 62, W - 80, pal.ink, 0.2);
      // padlock
      g.save(); g.strokeStyle = pal.acc; g.lineWidth = 6; g.beginPath(); g.arc(102, y - 26, 14, Math.PI, 0); g.stroke(); g.fillStyle = pal.acc; g.fillRect(84, y - 26, 36, 28); g.restore();
      txt(g, s, 150, y, {size: 44, color: pal.ink});
    }, 20));
  }

  const SLIDES = {
    intro: {draw: sIntro, title: 'Intro', alt: R => `Your listening recap, ${periodWords(R).range}.`},
    minutes: {draw: sMinutes, title: 'Minutes', alt: R => `You listened for ${n0(R.totals.minutes)} minutes, that's ${R.totals.days.toFixed(1)} days.`},
    artist: {draw: sArtist, title: 'Top artist', alt: R => `Your top artist: ${R.topArtist.name}, ${n0(R.topArtist.minutes)} minutes.`},
    tracks: {draw: sTracks, title: 'Top tracks', alt: R => 'Top tracks: ' + R.topTracks.map((t, i) => `${i + 1}. ${t.name} by ${t.artist}`).join('; ')},
    genres: {draw: sGenres, title: 'Genres', alt: R => R.genres.ok ? 'Top genres: ' + R.genres.list.map(x => `${x.name} ${Math.round(x.share * 100)}%`).join(', ') : 'Your top artists by share of listening.'},
    clock: {draw: sClock, title: 'Clock', alt: R => `${R.clock.title}. Peak hour ${R.clock.peakLabel}.`},
    days: {draw: sDays, title: 'Big days', alt: R => `Biggest day ${fmtD(R.biggestDay.date)} with ${n0(R.biggestDay.minutes)} minutes. Longest streak ${R.streak.days} days.`},
    persona: {draw: sPersona, title: 'Personality', alt: R => `${R.archetype.name}. ${R.archetype.line}`},
    outro: {draw: sOutro, title: 'Summary', alt: R => `Summary: ${n0(R.totals.minutes)} minutes, top artist ${R.topArtist.name}.`},
    locked: {draw: sLocked, title: 'More', alt: () => 'The rest of your recap is locked.'},
  };
  const BG = {intro: 'paper', minutes: 'night', tracks: 'paper', genres: 'navy', persona: 'signal', outro: 'paper', locked: 'night', days: 'blush'};
  function bgOf(id, R) {
    if (id === 'artist') { const keys = ['signal', 'navy', 'moss', 'blush', 'butter']; return PAL[keys[hash(R.topArtist.name) % keys.length]].bg; }
    if (id === 'clock') return (R.clock.type === 'morning' ? PAL.butter : R.clock.type === 'afternoon' ? PAL.blush : PAL.night).bg;
    return PAL[BG[id]].bg;
  }
  const FULL = ['intro', 'minutes', 'artist', 'tracks', 'genres', 'clock', 'days', 'persona', 'outro'];
  const FREE = ['intro', 'minutes', 'artist', 'locked', 'outro'];

  // Draw slide `id` at time p (seconds since it started) into a context whose logical size is W × H.
  function draw(g, id, H, p, R, o = {}) {
    g.save(); g.textBaseline = 'alphabetic';
    SLIDES[id].draw(g, H, p, R, o);
    g.restore();
  }
  return {W, PAL, SLIDES, FULL, FREE, draw, bgOf, hash, fmtD};
})();
if (typeof module !== 'undefined') module.exports = RecapDraw;
