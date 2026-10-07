'use strict';
// Recap numbers: everything the story slides show, computed from the same decoded plays the dashboard uses.
// Pure functions (no DOM), so tests/test_recap.js can run them in node.
const RecapData = (() => {
  const DAY = 86400000, STREAM_MS = 30000;
  const pad = n => String(n).padStart(2, '0');
  const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const noon = k => Date.parse(k + 'T12:00:00');

  // Same compact format as /api/plays and static/demo.json (see dash.js decode()).
  function decode(d) {
    const rows = d.rows.map(([t, ms, ti, ei, pi, ci, fl]) => {
      const r = {t, ms};
      if (ti >= 0) { const T = d.tracks[ti]; r.tr = T[0]; r.ar = T[1]; r.al = T[2]; }
      else { const E = d.episodes[ei]; r.ep = E[0]; r.show = E[1]; }
      if (pi >= 0) r.pf = d.platforms[pi];
      if (fl & 4) { r.x = 1; r.sk = fl & 1 ? 1 : 0; r.sh = fl & 2 ? 1 : 0; }
      return r;
    }).sort((a, b) => a.t - b.t);
    return {rows, genres: d.genres || {}};
  }

  // Spotify's year-end summary usually counts Jan 1 to about Nov 15. Same rule (and saved override) as the dashboard.
  function cutoff(now, saved) {
    if (saved) return Date.parse(saved + 'T00:00:00');
    const y = (now.getMonth() === 11 && now.getDate() >= 4) ? now.getFullYear() : now.getFullYear() - 1;
    return new Date(y, 10, 15).getTime();
  }

  // Periods the user can pick: since the last cutoff, each calendar year with plays, all time.
  function periods(rows, now = new Date(), saved = null) {
    const out = [];
    const c = cutoff(now, saved);
    out.push({key: 'wrapped', label: 'Since last Wrapped cutoff', from: c, to: Infinity, kind: 'year'});
    const years = [...new Set(rows.map(r => new Date(r.t).getFullYear()))].sort((a, b) => b - a);
    for (const y of years) out.push({key: String(y), label: String(y), from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime(), kind: 'year', year: y});
    out.push({key: 'all', label: 'All time', from: -Infinity, to: Infinity, kind: 'all'});
    for (const p of out) p.plays = countIn(rows, p.from, p.to);
    return out;
  }
  function countIn(rows, a, b) { let n = 0; for (const r of rows) if (r.tr && r.t >= a && r.t < b) n++; return n; }
  // The requested period if it has music in it, else the first one that does.
  function pickPeriod(list, key) {
    return list.find(p => p.key === key && p.plays) || list.find(p => p.plays >= 50) || list.find(p => p.plays) || list[list.length - 1];
  }

  // ---------- archetypes ----------
  // Each scores metric / threshold; the highest score >= 0.75 wins (ties go to the earlier one), else the all-rounder.
  const pct = v => Math.round(100 * v) + '%';
  const hourName = h => (h % 12 || 12) + (h < 12 ? ' am' : ' pm');
  const ARCHETYPES = [
    {key: 'loyalist', name: 'The Loyalist', line: 'One artist basically has a key to your place.',
      score: S => S.topArtistShare / 0.2, because: S => `${S.topArtist} got ${pct(S.topArtistShare)} of your listening`},
    {key: 'repeat', name: 'The Repeat Offender', line: "You don't play songs. You wear them out.",
      score: S => S.dayRepeat ? S.dayRepeat.plays / 8 : 0, because: S => `“${S.dayRepeat.track}” ${S.dayRepeat.plays} times in one day`},
    {key: 'nightowl', name: 'The Night Owl', line: 'Your best listening starts after everyone else logs off.',
      score: S => S.nightShare / 0.28, because: S => `${pct(S.nightShare)} of your minutes after 10 pm`},
    {key: 'earlybird', name: 'The Early Riser', line: 'Soundtrack first. Coffee second.',
      score: S => S.morningShare / 0.25, because: S => `${pct(S.morningShare)} of your minutes before 10 am`},
    {key: 'explorer', name: 'The Explorer', line: 'Your queue has a passport, and it is full of stamps.',
      score: S => S.newArtistShare === null ? 0 : (S.artists >= 25 ? S.newArtistShare / 0.45 : 0),
      because: S => `${S.newArtists.toLocaleString('en-US')} artists you had never played before`},
    {key: 'skipper', name: 'The Skipper', line: 'Ten seconds is a fair trial. Next.',
      score: S => S.skipRate === null ? 0 : S.skipRate / 0.3, because: S => `you skipped ${pct(S.skipRate)} of tracks`},
    {key: 'marathoner', name: 'The Marathoner', line: "Headphones aren't an accessory. They're a body part.",
      score: S => Math.max(S.avgActiveMin / 150, S.biggestMin / 480), because: S => `${Math.round(S.avgActiveMin)} minutes on an average listening day`},
    {key: 'genrehopper', name: 'The Genre Hopper', line: 'Your queue has no dress code.',
      score: S => S.genreCoverage >= 0.3 ? S.genresOver5 / 6 : 0, because: S => `${S.genresOver5} genres each above 5% of your listening`},
  ];
  const ALLROUNDER = {key: 'allrounder', name: 'The All-Rounder', line: 'No extremes, no ruts. Just steady good taste.',
    because: S => `peak hour ${hourName(S.peakHour)}, top artist at ${pct(S.topArtistShare)}`};
  function archetype(S) {
    const scored = ARCHETYPES.map(a => ({a, s: a.score(S) || 0}));
    let best = null, second = null;
    for (const x of scored) { if (!best || x.s > best.s) { second = best; best = x; } else if (!second || x.s > second.s) second = x; }
    const pick = best.s >= 0.75 ? best.a : ALLROUNDER;
    const runner = pick === ALLROUNDER ? null : (second && second.s >= 0.75 ? second.a : null);
    return {key: pick.key, name: pick.name, line: pick.line, because: pick.because(S),
      runnerUp: runner ? runner.name : null, scores: Object.fromEntries(scored.map(x => [x.a.key, +x.s.toFixed(3)]))};
  }

  // ---------- the recap ----------
  function compute(all, genres, period, now = Date.now()) {
    const a = period.from, b = period.to;
    const rows = all.filter(r => r.t >= a && r.t < b);
    const music = rows.filter(r => r.tr);
    const R = {period: {key: period.key, label: period.label, kind: period.kind, year: period.year || null}, plays: music.length};
    if (!music.length) { R.empty = true; return R; }
    const first = music[0].t, last = music[music.length - 1].t;
    R.period.first = first; R.period.last = last;
    R.period.from = isFinite(a) ? a : first; R.period.to = isFinite(b) ? Math.min(b - 1, last) : last;

    let ms = 0, streams = 0, skips = 0, withSkip = 0;
    const tracks = new Map(), artists = new Map(), albums = new Set(), days = new Map(), hours = new Array(24).fill(0), perDayTrack = new Map();
    for (const r of music) {
      ms += r.ms; const st = r.ms >= STREAM_MS; if (st) streams++;
      if (r.x) { withSkip++; if (r.sk) skips++; }
      const tk = (r.ar + '\u0001' + r.tr).toLowerCase();
      let t = tracks.get(tk); if (!t) tracks.set(tk, t = {name: r.tr, artist: r.ar, ms: 0, plays: 0});
      t.ms += r.ms; if (st) t.plays++;
      let ar = artists.get(r.ar); if (!ar) artists.set(r.ar, ar = {name: r.ar, ms: 0, plays: 0});
      ar.ms += r.ms; if (st) ar.plays++;
      if (r.al) albums.add((r.ar + '\u0001' + r.al).toLowerCase());
      const dk = dayKey(r.t), d = new Date(r.t);
      days.set(dk, (days.get(dk) || 0) + r.ms);
      hours[d.getHours()] += r.ms;
      if (st) { const k = dk + '\u0002' + tk; perDayTrack.set(k, (perDayTrack.get(k) || 0) + 1); }
    }
    const minutes = ms / 60000;
    const spanDays = Math.max(1, Math.round((R.period.to - R.period.from) / DAY) + 1);
    R.totals = {ms, minutes: Math.round(minutes), hours: ms / 3600000, days: ms / DAY, streams, tracks: tracks.size, artists: artists.size,
      albums: albums.size, activeDays: days.size, spanDays, avgPerDay: minutes / spanDays, avgActive: minutes / days.size};

    const byMs = [...artists.values()].sort((x, y) => (y.ms - x.ms) || x.name.localeCompare(y.name));
    R.topArtists = byMs.slice(0, 5).map(x => ({name: x.name, minutes: Math.round(x.ms / 60000), plays: x.plays, share: x.ms / ms}));
    R.topArtist = R.topArtists[0];
    R.topTracks = [...tracks.values()].sort((x, y) => (y.plays - x.plays) || (y.ms - x.ms) || x.name.localeCompare(y.name)).slice(0, 5)
      .map(x => ({name: x.name, artist: x.artist, plays: x.plays, minutes: Math.round(x.ms / 60000)}));

    // genres: each artist's MusicBrainz genres (weighted), times that artist's minutes
    const gm = new Map(); let covered = 0;
    for (const ar of artists.values()) {
      const g = genres[ar.name.toLowerCase()]; if (!g || !g.length) continue;
      covered += ar.ms;
      const tot = g.reduce((s, x) => s + x[1], 0) || 1;
      for (const [n, w] of g) gm.set(n, (gm.get(n) || 0) + ar.ms * w / tot);
    }
    const gl = [...gm.entries()].sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0]));
    const gtot = covered || 1;
    R.genres = {coverage: covered / ms, list: gl.slice(0, 5).map(([name, v]) => ({name, share: v / gtot, minutes: Math.round(v / 60000)})),
      other: Math.max(0, 1 - gl.slice(0, 5).reduce((s, x) => s + x[1], 0) / gtot), count: gl.length,
      over5: gl.filter(x => x[1] / gtot >= 0.05).length};
    R.genres.top = R.genres.list[0] ? R.genres.list[0].name : null;
    R.genres.ok = R.genres.coverage >= 0.15 && R.genres.list.length > 0;

    // clock
    const share = hs => hs.reduce((s, h) => s + hours[h], 0) / ms;
    const peakHour = hours.indexOf(Math.max(...hours));
    const buckets = {morning: share([5, 6, 7, 8, 9, 10, 11]), afternoon: share([12, 13, 14, 15, 16]), evening: share([17, 18, 19, 20, 21]), night: share([22, 23, 0, 1, 2, 3, 4])};
    const span = {morning: 7, afternoon: 5, evening: 5, night: 7};  // compare per hour, buckets differ in length
    const type = Object.entries(buckets).sort((x, y) => y[1] / span[y[0]] - x[1] / span[x[0]])[0][0];
    R.clock = {hours: hours.map(v => Math.round(v / 60000)), peakHour, peakLabel: hourName(peakHour), buckets, type,
      title: {morning: 'Early riser', afternoon: 'Afternoon person', evening: 'Evening regular', night: 'Night owl'}[type]};

    // days
    const dk = [...days.keys()].sort();
    const big = [...days.entries()].sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0]))[0];
    R.biggestDay = {date: noon(big[0]), minutes: Math.round(big[1] / 60000)};
    let best = 0, cur = 0, prev = null, bestEnd = null;
    for (const k of dk) { const t = noon(k); cur = (prev !== null && Math.round((t - prev) / DAY) === 1) ? cur + 1 : 1; if (cur > best) { best = cur; bestEnd = t; } prev = t; }
    R.streak = {days: best, end: bestEnd, start: bestEnd - (best - 1) * DAY};

    // habits
    const firstEver = new Map();
    for (const r of all) if (r.ar && !firstEver.has(r.ar)) firstEver.set(r.ar, r.t);
    // "new" only means something if there's at least two months of history before the period
    const newArtists = isFinite(a) && all.length && all[0].t < a - 60 * DAY ? [...artists.keys()].filter(n => firstEver.get(n) >= a).length : null;
    let dr = null;
    for (const [k, n] of perDayTrack) if (!dr || n > dr.n || (n === dr.n && k < dr.k)) dr = {k, n};
    const drTrack = dr ? tracks.get(dr.k.split('\u0002')[1]) : null;
    R.habits = {skipRate: withSkip >= 50 ? skips / withSkip : null, newArtists,
      dayRepeat: dr && dr.n >= 2 ? {track: drTrack.name, artist: drTrack.artist, plays: dr.n, date: noon(dr.k.split('\u0002')[0])} : null};

    R.stats = {topArtist: R.topArtist.name, topArtistShare: R.topArtist.share, dayRepeat: R.habits.dayRepeat,
      nightShare: share([22, 23, 0, 1, 2, 3]), morningShare: share([5, 6, 7, 8, 9]), newArtists: newArtists || 0,
      newArtistShare: newArtists === null ? null : newArtists / artists.size, artists: artists.size,
      skipRate: R.habits.skipRate, avgActiveMin: R.totals.avgActive, biggestMin: R.biggestDay.minutes,
      genreCoverage: R.genres.coverage, genresOver5: R.genres.over5, peakHour};
    R.archetype = archetype(R.stats);
    return R;
  }

  return {decode, cutoff, periods, pickPeriod, compute, archetype, ARCHETYPES};
})();
if (typeof module !== 'undefined') module.exports = RecapData;
