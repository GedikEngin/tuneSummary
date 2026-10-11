'use strict';
// Recap soundtrack: 30-second song previews under the story slides, like Spotify Wrapped (songs per slide come from
// RecapData.soundtrack, audio from /api/preview on our own server). Web Audio, so slides crossfade (iOS ignores
// <audio>.volume) and pausing the story freezes the music with it. Live playback only: exported videos stay silent.
const RecapAudio = (() => {
  const FADE_IN = 0.7, FADE_OUT = 0.9, VOL = 0.85;
  let ctx = null, master = null, plan = {}, cur = null, muted = false, onNow = () => {};
  const bytes = new Map(), bufs = new Map(), meta = new Map();
  try { muted = localStorage.getItem('ts-recap-muted') === '1'; } catch (e) {}
  const key = s => (s.artist + '\u0001' + s.track).toLowerCase();
  const dec = s => { try { return decodeURIComponent(s || ''); } catch (e) { return s || ''; } };

  // Call straight from the click that starts the story: browsers only allow sound after a user gesture.
  function unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = muted ? 0 : 1; master.connect(ctx.destination);
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}  // iOS: play with the ringer off
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    load(plan);  // decode anything prefetched before the context existed
    return true;
  }

  // plan: {slideId: {artist, track}}. Starts downloading every song (in slide order; fine before unlock(), so the
  // cover page can prefetch); decoding waits for the audio context. Failures just mean that slide is silent.
  function load(p) {
    plan = p || {};
    for (const s of Object.values(plan)) {
      const k = key(s);
      if (!bytes.has(k)) bytes.set(k, fetch('api/preview?a=' + encodeURIComponent(s.artist) + '&t=' + encodeURIComponent(s.track))
        .then(r => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const h = n => dec(r.headers.get(n));
          meta.set(k, {title: h('X-Preview-Title') || s.track, artist: h('X-Preview-Artist') || s.artist,
            source: r.headers.get('X-Preview-Source') || '', link: h('X-Preview-Link')});
          return r.arrayBuffer();
        })
        .catch(() => null));
      if (ctx && !bufs.has(k)) bufs.set(k, bytes.get(k)
        .then(ab => ab && new Promise((res, rej) => ctx.decodeAudioData(ab.slice(0), res, rej)))  // callback form: older Safari
        .catch(() => null));
    }
  }

  function fadeOut(c) {
    if (!c || !c.src) return;
    const t = ctx.currentTime, g = c.g.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + FADE_OUT);
    try { c.src.stop(t + FADE_OUT + 0.05); } catch (e) {}
  }
  function stop() { if (cur) fadeOut(cur); cur = null; onNow(null); }

  // The story moved to slide `id`: keep the song if it's the same one, else crossfade to this slide's song (or silence).
  function slide(id) {
    if (!ctx) return;
    const s = plan[id];
    if (!s) { stop(); return; }
    const k = key(s);
    if (cur && cur.k === k && !cur.ended) return;
    stop();
    const p = bufs.get(k);
    if (!p) return;
    const me = cur = {k};
    p.then(buf => {
      if (cur !== me || !buf) return;
      const src = ctx.createBufferSource(), g = ctx.createGain(), t = ctx.currentTime, d = buf.duration;
      src.buffer = buf; src.connect(g); g.connect(master);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(VOL, t + FADE_IN);
      if (d > FADE_IN + FADE_OUT) { g.gain.setValueAtTime(VOL, t + d - FADE_OUT); g.gain.linearRampToValueAtTime(0, t + d); }
      src.onended = () => { me.ended = true; if (cur === me) onNow(null); };
      src.start(t);
      me.src = src; me.g = g;
      onNow({...(meta.get(k) || {}), title: s.track, artist: s.artist});  // the names as in the user's own history
    });
  }

  // Pausing the story (button, hold, hidden tab, open sheet) freezes the audio clock, fades and all.
  function pause(v) {
    if (!ctx) return;
    if (v && ctx.state === 'running') ctx.suspend().catch(() => {});
    else if (!v && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  function setMuted(v) {
    muted = !!v;
    try { localStorage.setItem('ts-recap-muted', muted ? '1' : '0'); } catch (e) {}
    if (master) { const t = ctx.currentTime; master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(master.gain.value, t); master.gain.linearRampToValueAtTime(muted ? 0 : 1, t + 0.25); }
  }

  return {unlock, load, slide, stop, pause, setMuted, get muted() { return muted; }, get supported() { return !!(window.AudioContext || window.webkitAudioContext); },
    set onNow(fn) { onNow = fn || (() => {}); }};
})();
if (typeof module !== 'undefined') module.exports = RecapAudio;
