'use strict';
// Recap player: cover page (period + name), then a full-screen tap-through story drawn by RecapDraw on a canvas.
// Also: per-slide PNG export, whole-story video export (MediaRecorder), and the switchable gate (TS_RECAP_GATE).
(() => {
  const Q = new URLSearchParams(location.search);
  const DEMO = Q.get('demo') === '1';
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const D = RecapDraw, W = D.W;
  // seconds per slide: live story / video
  const LIVE = {intro: 4.5, minutes: 6, artist: 6, tracks: 7, genres: 7, clock: 7, days: 7.5, persona: 7.5, outro: 8, locked: 9};
  const VID = {intro: 3, minutes: 3.6, artist: 3.4, tracks: 3.6, genres: 3.6, clock: 3.6, days: 3.8, persona: 3.6, outro: 4};
  const HOLD = new Set(['locked', 'outro']); // don't auto-advance past these

  let DATA = null, PERIODS = [], period = null, R = null, ACCESS = {gate: 'off', full: true};
  let name = '', slides = D.FULL, idx = 0, el = 0, last = 0, paused = false, hold = false, raf = 0, H = 1920, scale = 1, drawnKey = '';
  const cv = $('#cv'), ctx = cv.getContext('2d');
  try { name = localStorage.getItem('ts-recap-name') || ''; } catch (e) {}

  // ---------- rewarded-ad hook ----------
  // Placeholder until Google Ad Manager rewarded ads are wired in: show something in `box` for `seconds`, then
  // resolve true if the reward was earned. Replace window.TSRewarded.show with the GAM rewarded-ad flow later.
  window.TSRewarded = window.TSRewarded || {
    show(box, seconds) {
      return new Promise(res => {
        let left = seconds;
        const paint = () => { box.innerHTML = `<div><div class="meta">Advertisement</div><p class="display" style="font-size:1.6rem;margin:8px 0">Ad placeholder</p><p class="small mut">Rewarded ads aren't live yet. Unlocking in <b>${left}</b> s…</p></div>`; };
        paint();
        const t = setInterval(() => { left--; if (left <= 0) { clearInterval(t); res(true); } else paint(); }, 1000);
      });
    },
  };

  // ---------- loading + cover ----------
  async function load() {
    let d;
    if (DEMO) {
      d = await api('static/demo.json');
      $('#coverKicker').textContent = 'Demo recap';
      $('#backLink').href = 'app?demo=1';
    } else {
      try { ACCESS = await api('api/recap/access'); } catch (e) { if (e.status === 401) { location.replace('signin'); return; } throw e; }
      d = await api('api/plays');
    }
    DATA = RecapData.decode(d);
    let saved = null; try { saved = localStorage.getItem('ts-wrapped'); } catch (e) {}
    PERIODS = RecapData.periods(DATA.rows, new Date(), saved);
    period = RecapData.pickPeriod(PERIODS, Q.get('p') || 'wrapped');
    cover();
    if (Q.get('autoplay') === '1' && period.plays) play(+(Q.get('slide') || 0));
  }

  function cover() {
    const box = $('#coverBody');
    if (!DATA.rows.some(r => r.tr)) {
      box.innerHTML = `<div class="callout"><div class="meta">Nothing to show yet</div><p class="small">Upload your Spotify export on <a class="u" href="app">your stats page</a> first, then come back for your recap.</p></div>`;
      return;
    }
    const shown = PERIODS.filter(p => p.plays).slice(0, 6);
    const lock = ACCESS.full ? '' : `<p class="small mut rc-note">${ACCESS.gate === 'ad'
      ? 'Free: intro, minutes, top artist and your summary card. Watch one short ad to unlock the full story and the video, or <a class="u" href="supporter">become a supporter</a>.'
      : 'Free: intro, minutes, top artist and your summary card. The full story and the video are for <a class="u" href="supporter">supporters</a>.'}</p>`;
    box.innerHTML = `
      <div class="rc-field"><span class="meta">Period</span><div class="rc-chips" id="chips">${shown.map(p =>
        `<button type="button" class="btn btn--line btn--sm${p === period ? ' on' : ''}" data-k="${esc(p.key)}">${esc(p.label)}</button>`).join('')}</div>
        <p class="meta" id="pInfo" style="margin-top:var(--s-2)"></p></div>
      <label class="rc-field" style="display:block"><span class="meta">Name on your recap (optional)</span>
        <input class="rc-name" id="nm" maxlength="28" autocomplete="nickname" placeholder="e.g. Sam" value="${esc(name)}"></label>
      <button type="button" class="btn btn--ink rc-play" id="bPlay">▶ Play your recap</button>
      ${lock}
      ${DEMO ? '<p class="small mut rc-note">This is the made-up demo account. <a class="u" href="guide">Get your own →</a></p>' : ''}
      <p class="meta rc-note">Made in your browser from your own export · nothing is posted anywhere</p>`;
    const info = () => { $('#pInfo').textContent = RecapData.compute(DATA.rows, DATA.genres, period).plays.toLocaleString('en-US') + ' plays in this period'; };
    info();
    $('#chips').onclick = e => { const b = e.target.closest('button[data-k]'); if (!b) return; period = PERIODS.find(p => p.key === b.dataset.k); $$('#chips button').forEach(x => x.classList.toggle('on', x === b)); info(); };
    $('#nm').oninput = e => { name = e.target.value.trim().slice(0, 28); try { localStorage.setItem('ts-recap-name', name); } catch (er) {} };
    $('#bPlay').onclick = () => play(0);
  }

  // ---------- player ----------
  const fontsReady = () => document.fonts ? Promise.all(['400 100px "Instrument Serif"', 'italic 400 100px "Instrument Serif"', '400 30px "IBM Plex Mono"', '400 40px "IBM Plex Sans"']
    .map(f => document.fonts.load(f).catch(() => null))) : Promise.resolve();
  function buildSlides() { slides = ACCESS.full || DEMO ? D.FULL : D.FREE; }
  async function play(start = 0) {
    R = RecapData.compute(DATA.rows, DATA.genres, period);
    if (R.empty) return;
    buildSlides();
    await fontsReady();
    $('#cover').classList.add('hidden'); $('#stage').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#bars').innerHTML = slides.map(() => '<span><i></i></span>').join('');
    $('#bVid').classList.toggle('hidden', !videoType());
    layout(); go(Math.min(start, slides.length - 1));
    paused = Q.get('still') === '1';
    cancelAnimationFrame(raf); last = 0; raf = requestAnimationFrame(tick);
  }
  function close() {
    cancelAnimationFrame(raf); raf = 0;
    $('#stage').classList.add('hidden'); $('#cover').classList.remove('hidden');
    document.body.style.overflow = '';
  }
  const lum = hex => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255; };
  function go(i) {
    idx = Math.max(0, Math.min(slides.length - 1, i)); el = 0; drawnKey = '';
    const id = slides[idx], bgc = D.bgOf(id, R), light = lum(bgc) > 0.6;
    $('#frame').style.color = light ? '#151513' : '#F1EEE6';
    $('#stage').style.background = innerWidth < 700 ? bgc : (light ? '#2a2925' : '#0b0b0a');
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = bgc;
    $('#alt').textContent = `Slide ${idx + 1} of ${slides.length}. ` + D.SLIDES[id].alt(R);
    $('#bImg').disabled = id === 'locked';
    $('#bReplay').classList.toggle('hidden', id !== 'outro');
    $('#bVid').textContent = ACCESS.full || DEMO ? 'Save video' : 'Save video 🔒';
    const cta = $('#cta');
    cta.classList.toggle('hidden', id !== 'locked');
    if (id === 'locked') {
      cta.innerHTML = (ACCESS.gate === 'ad' ? `<button type="button" class="rc-btn ink" id="cAd">Watch a short ad to unlock</button>` : '') +
        `<a class="rc-btn" href="supporter">Become a supporter</a><button type="button" class="rc-btn" id="cSkip">Skip to summary →</button>`;
      if ($('#cAd')) $('#cAd').onclick = unlock;
      $('#cSkip').onclick = () => go(idx + 1);
    }
  }
  function layout() {
    const vw = innerWidth, vh = innerHeight, phone = vw < 700;
    let cw, ch;
    if (phone) { cw = vw; ch = vh; } else { ch = vh - 32; cw = ch * 9 / 16; if (cw > vw - 32) { cw = vw - 32; ch = cw * 16 / 9; } }
    H = Math.round(Math.max(1920, Math.min(2400, W * ch / cw)));
    const cssH = cw * H / W; if (cssH > ch) cw = ch * W / H;
    const fr = $('#frame'); fr.style.width = cw + 'px'; fr.style.height = cw * H / W + 'px';
    scale = Math.min(1, cw * (devicePixelRatio || 1) / W);
    cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
    drawnKey = '';
  }
  function render() {
    const id = slides[idx], p = RM ? 99 : el / 1000, key = RM || paused || hold ? id + ':' + Math.round(p * 1000) + ':' + cv.width : '';
    if (key && key === drawnKey) return;
    drawnKey = key;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    D.draw(ctx, id, H, p, R, {live: true, name, full: ACCESS.full || DEMO});
  }
  function tick(now) {
    const dt = last ? Math.min(100, now - last) : 0; last = now;
    const id = slides[idx], dur = LIVE[id];
    if (!paused && !hold && !document.hidden && $('#overlay').classList.contains('hidden')) {
      el = Math.min(el + dt, HOLD.has(id) ? dur * 1000 : el + dt);
      if (el >= dur * 1000 && !HOLD.has(id)) go(idx + 1);
    }
    render();
    $$('#bars i').forEach((b, i) => { b.style.width = i < idx ? '100%' : i > idx ? '0' : Math.min(100, el / 10 / LIVE[slides[idx]]) + '%'; });
    raf = requestAnimationFrame(tick);
  }
  function setPaused(v) { paused = v; $('#bPause').textContent = v ? '▶' : '❚❚'; $('#bPause').setAttribute('aria-label', v ? 'Play' : 'Pause'); }

  // tap left/right, hold to pause
  let downAt = 0, holdT = 0;
  $('#tap').addEventListener('pointerdown', e => { downAt = performance.now(); clearTimeout(holdT); holdT = setTimeout(() => { hold = true; }, 220); });
  $('#tap').addEventListener('pointerup', e => {
    clearTimeout(holdT);
    if (hold) { hold = false; return; }
    const r = $('#tap').getBoundingClientRect();
    if (e.clientX - r.left < r.width * 0.33) { if (el > 1500 && idx === 0) el = 0; else go(idx - 1); } else go(idx + 1);
  });
  ['pointercancel', 'pointerleave'].forEach(ev => $('#tap').addEventListener(ev, () => { clearTimeout(holdT); hold = false; }));
  $('#tap').addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if ($('#stage').classList.contains('hidden')) return;
    if (!$('#overlay').classList.contains('hidden')) { if (e.key === 'Escape') closeOverlay(); return; }
    if (e.key === 'ArrowRight') go(idx + 1);
    else if (e.key === 'ArrowLeft') go(idx - 1);
    else if (e.key === ' ') { e.preventDefault(); setPaused(!paused); }
    else if (e.key === 'Escape') close();
  });
  $('#bPause').onclick = () => setPaused(!paused);
  $('#bClose').onclick = close;
  $('#bReplay').onclick = () => go(0);
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (raf) layout(); }, 120); });

  // ---------- overlay sheets ----------
  function sheet(html) { $('#overlayBody').innerHTML = html; $('#overlay').classList.remove('hidden'); }
  function closeOverlay() { $('#overlay').classList.add('hidden'); $('#overlayBody').innerHTML = ''; }
  $('#overlay').onclick = e => { if (e.target.id === 'overlay') closeOverlay(); };

  async function unlock() {
    if (ACCESS.gate !== 'ad') {
      sheet(`<div class="meta signal">Supporters</div><h2>The full recap is a supporter feature</h2><p class="small mut">Top tracks, genres, your listening clock, big days, your personality and the video export.</p>
        <div class="row"><a class="btn btn--ink" href="supporter">Become a supporter</a><button class="btn btn--line" type="button" id="oX">Not now</button></div>`);
      $('#oX').onclick = closeOverlay; return;
    }
    sheet(`<div class="meta signal">Unlock</div><h2>Watch one short ad, get the whole story</h2>
      <p class="small mut">Unlocks the full recap and the video export for this sign-in. Ads keep TuneSummary free.</p>
      <div id="adBox" class="rc-adbox hidden"></div><p class="err small" id="adErr"></p>
      <div class="row" id="adBtns"><button class="btn btn--ink" type="button" id="oAd">Watch ad (${ACCESS.ad_seconds || 15} s)</button><a class="btn btn--line" href="supporter">Supporter instead</a><button class="btn btn--line" type="button" id="oX">Not now</button></div>`);
    $('#oX').onclick = closeOverlay;
    $('#oAd').onclick = async () => {
      $('#adBtns').classList.add('hidden');
      try {
        const s = await postJSON('api/recap/unlock/start');
        $('#adBox').classList.remove('hidden');
        const ok = await window.TSRewarded.show($('#adBox'), s.seconds);
        if (!ok) throw new Error("The ad didn't finish.");
        const r = await postJSON('api/recap/unlock/finish', {nonce: s.nonce});
        if (!r.full) throw new Error('Unlock failed.');
        ACCESS.full = true; closeOverlay();
        const at = slides.indexOf('locked');
        buildSlides(); $('#bars').innerHTML = slides.map(() => '<span><i></i></span>').join('');
        go(at > 0 ? at : 0); setPaused(false);
      } catch (e) { $('#adErr').textContent = e.message; $('#adBtns').classList.remove('hidden'); }
    };
  }

  // ---------- export: images ----------
  function renderStill(id) {
    const c = document.createElement('canvas'); c.width = W; c.height = 1920;
    D.draw(c.getContext('2d'), id, 1920, 99, R, {name, full: ACCESS.full || DEMO});
    return c;
  }
  const blobOf = (c, type = 'image/png') => new Promise(res => c.toBlob(res, type));
  async function deliver(blob, fname, title) {
    const file = typeof File !== 'undefined' ? new File([blob], fname, {type: blob.type}) : null;
    if (file && matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({files: [file]})) {
      try { await navigator.share({files: [file], title}); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  const fileBase = () => 'tunesummary-recap-' + (period.key === 'wrapped' ? 'this-year' : period.key);
  $('#bImg').onclick = async () => {
    const id = slides[idx]; if (id === 'locked') return;
    const was = paused; setPaused(true);
    const blob = await blobOf(renderStill(id));
    await deliver(blob, `${fileBase()}-${String(idx + 1).padStart(2, '0')}-${id}.png`, 'My TuneSummary recap');
    setPaused(was);
  };

  // ---------- export: video ----------
  function videoType() {
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
    return ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(t => { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } }) || null;
  }
  // Plays the whole story into an off-screen 1080×1920 canvas in real time and records it. Resolves to a Blob.
  async function recordVideo(onProgress = () => {}, isCancelled = () => false) {
    const type = videoType(); if (!type) throw new Error('Video recording is not supported in this browser.');
    const seq = D.FULL, total = seq.reduce((s, id) => s + VID[id], 0);
    const c = document.createElement('canvas'); c.width = W; c.height = 1920;
    c.style.cssText = 'position:fixed;left:-20000px;top:0;width:108px;height:192px;pointer-events:none';
    document.body.appendChild(c);
    const g = c.getContext('2d');
    D.draw(g, seq[0], 1920, 0, R, {name, full: true});
    const stream = c.captureStream(30), rec = new MediaRecorder(stream, {mimeType: type, videoBitsPerSecond: 8000000}), chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    rec.start(1000);
    const t0 = performance.now();
    await new Promise(res => {
      const step = () => {
        const t = (performance.now() - t0) / 1000;
        if (t >= total || isCancelled()) { res(); return; }
        let a = 0, i = 0; while (i < seq.length - 1 && t >= a + VID[seq[i]]) { a += VID[seq[i]]; i++; }
        D.draw(g, seq[i], 1920, t - a, R, {name, full: true});
        onProgress(t / total);
        requestAnimationFrame(step);
      };
      step();
    });
    rec.stop(); await stopped;
    stream.getTracks().forEach(t => t.stop()); c.remove();
    if (isCancelled()) return null;
    return new Blob(chunks, {type: type.split(';')[0]});
  }
  $('#bVid').onclick = async () => {
    if (!(ACCESS.full || DEMO)) { setPaused(true); unlock(); return; }
    setPaused(true);
    let cancelled = false;
    sheet(`<div class="meta signal">Video</div><h2>Making your video…</h2><p class="small mut">It plays the story once in the background (about ${Math.round(D.FULL.reduce((s, id) => s + VID[id], 0))} seconds). Keep this tab open.</p>
      <div class="prog" style="margin-top:var(--s-4)"><div id="vProg" style="width:0"></div></div><div class="row"><button class="btn btn--line" type="button" id="vX">Cancel</button></div>`);
    $('#vX').onclick = () => { cancelled = true; closeOverlay(); };
    try {
      const blob = await recordVideo(f => { const b = $('#vProg'); if (b) b.style.width = (100 * f).toFixed(1) + '%'; }, () => cancelled);
      if (!blob) return;
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm', url = URL.createObjectURL(blob);
      sheet(`<div class="meta signal">Video</div><h2>Your video is ready</h2><video class="rc-prev" src="${url}" controls playsinline muted loop autoplay></video>
        <p class="small mut" style="margin-top:var(--s-2)">${(blob.size / 1048576).toFixed(1)} MB · ${ext.toUpperCase()} · 1080×1920</p>
        <div class="row"><button class="btn btn--ink" type="button" id="vSave">Save video</button><button class="btn btn--line" type="button" id="vX">Close</button></div>`);
      $('#vSave').onclick = () => deliver(blob, fileBase() + '.' + ext, 'My TuneSummary recap');
      $('#vX').onclick = () => { closeOverlay(); URL.revokeObjectURL(url); };
    } catch (e) {
      sheet(`<div class="meta signal">Video</div><h2>Couldn't make the video</h2><p class="small">${esc(e.message)}</p><div class="row"><button class="btn btn--line" type="button" id="vX">Close</button></div>`);
      $('#vX').onclick = closeOverlay;
    }
  };

  // for tests and the screenshot script
  window.__recap = {recordVideo, renderStill, get R() { return R; }, get slides() { return slides; }, go: i => go(i), videoType, pause: v => setPaused(v)};
  load().catch(e => { $('#coverBody').innerHTML = `<p class="err">Couldn't load your recap: ${esc(e.message)}</p>`; });
})();
