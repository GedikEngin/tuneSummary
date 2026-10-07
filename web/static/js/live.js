'use strict';
// Live updates via Last.fm on the stats page: link a profile, show "last updated", and the
// "Update my latest stats" button (free, rewarded ad, or supporter-only, per TS_LIVE_GATE on the server).
const Live = (() => {
  let ST = null, onNewPlays = null, poll = 0;
  const box = () => $('#liveBox');
  const ago = t => {
    const s = (Date.now() - t) / 1000;
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 129600) return Math.round(s / 3600) + ' h ago';
    return new Date(t).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
  };
  const at = t => new Date(t).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
  const credit = () => `<a href="${ST && ST.profile ? esc(ST.profile) : 'https://www.last.fm'}" target="_blank" rel="noopener">Powered by AudioScrobbler&nbsp;↗</a>`;
  const busy = () => ST && (ST.state === 'queued' || ST.state === 'syncing');

  function render() {
    const b = box();
    if (!ST.linked) {
      const how = `<a class="u" href="guide#lastfm">How to set it up →</a>`;
      const form = CONFIG.lastfm_auth
        ? `<a class="btn btn--ink" href="auth/lastfm">Connect with Last.fm <span class="arr">→</span></a>`
        : `<form id="lfForm" class="row"><input type="text" id="lfUser" placeholder="Last.fm username" autocomplete="off" autocapitalize="off" spellcheck="false" required maxlength="15">
             <button class="btn btn--ink" type="submit">Link <span class="arr">→</span></button></form>`;
      b.innerHTML = `<div class="callout live"><div class="meta">Live updates · Last.fm</div>
        <p class="small">Keep your stats current between exports. Spotify can send every play to Last.fm; link your Last.fm profile and new plays show up here. ${how}</p>
        <div style="margin-top:var(--s-4)">${form}</div><p class="small" id="lfMsg" style="margin-top:var(--s-3)"></p>
        <p class="meta lf-credit">${credit()}</p></div>`;
      const f = $('#lfForm');
      if (f) f.onsubmit = async e => {
        e.preventDefault();
        const m = $('#lfMsg'); m.className = 'small'; m.textContent = 'Checking…';
        try { ST = await postJSON('api/lastfm/link', {username: $('#lfUser').value.trim()}); render(); watch(); }
        catch (err) { m.className = 'err'; m.textContent = err.message; }
      };
      return;
    }
    let line;
    if (busy()) line = '<span class="lf-spin" aria-hidden="true"></span> Updating from Last.fm…';
    else if (ST.state === 'error') line = `<span class="err">${esc(ST.error || 'The last update failed.')}</span>`;
    else line = ST.synced_at ? `Last updated <b>${ago(ST.synced_at)}</b>` + (ST.added ? ` · ${ST.added.toLocaleString()} new plays` : '') : 'Not updated yet';
    const auto = ST.auto_hours ? ` · updates itself every ${ST.auto_hours >= 24 ? 'day' : ST.auto_hours + ' h'}` : '';
    let btn = '';
    if (ST.mode === 'supporter') btn = `<a class="btn btn--line btn--sm" href="supporter">Live updates: supporters</a>`;
    else {
      const wait = ST.next_at && ST.next_at > Date.now();
      btn = `<button class="btn btn--ink btn--sm" id="lfGo" type="button" ${busy() || wait ? 'disabled' : ''}>↻ Update my latest stats</button>` +
        (ST.mode === 'ad' && !wait ? '<span class="meta">short ad · keeps it free</span>' : '') +
        (wait && !busy() ? `<span class="meta">next at ${at(ST.next_at)}</span>` : '');
    }
    b.innerHTML = `<div class="callout live"><div class="row" style="align-items:center">
        <div style="flex:1;min-width:220px"><div class="meta">Live updates · Last.fm · <a class="u" href="${esc(ST.profile)}" target="_blank" rel="noopener">${esc(ST.user)}</a></div>
        <p class="small" id="lfLine">${line}</p>
        <p class="small mut">${ST.plays.toLocaleString()} plays from Last.fm${auto}. Lengths are estimated; your next export replaces them.</p></div>
        <div class="row">${btn}</div></div>
        <div id="lfAd" class="ad-box hidden"></div><p class="small" id="lfMsg"></p>
        <p class="meta lf-credit">${credit()}</p></div>`;
    const go = $('#lfGo');
    if (go) go.onclick = ST.mode === 'ad' ? viaAd : refresh;
  }

  async function refresh() {
    const m = $('#lfMsg');
    try { ST = await postJSON('api/lastfm/refresh'); render(); watch(); }
    catch (e) { m.className = 'err'; m.textContent = e.message; }
  }

  async function viaAd() {
    const m = $('#lfMsg'), ad = $('#lfAd');
    $('#lfGo').disabled = true; m.className = 'small'; m.textContent = '';
    try {
      const s = await postJSON('api/lastfm/refresh/ad/start');
      ad.classList.remove('hidden');
      const ok = await window.TSRewarded.show(ad, s.seconds);
      if (!ok) throw new Error("The ad didn't finish.");
      ST = await postJSON('api/lastfm/refresh/ad/finish', {nonce: s.nonce});
      render(); watch();
    } catch (e) { ad.classList.add('hidden'); m.className = 'err'; m.textContent = e.message; const g = $('#lfGo'); if (g) g.disabled = false; }
  }

  function watch() {
    clearTimeout(poll);
    if (!busy()) return;
    const before = ST.plays;
    const tick = async () => {
      try { ST = await api('api/lastfm'); } catch (e) { return; }
      if (busy()) { poll = setTimeout(tick, 3000); return; }
      render();
      if (ST.plays !== before && onNewPlays) onNewPlays();
    };
    poll = setTimeout(tick, 2000);
  }

  return {
    async init(me, reload) {
      onNewPlays = reload;
      await configReady;
      if (!CONFIG.lastfm || !me || !me.lastfm) { box().classList.add('hidden'); return; }
      ST = me.lastfm;
      box().classList.remove('hidden');
      render(); watch();
      const q = new URLSearchParams(location.search).get('lastfm');
      if (q === 'failed') { const m = $('#lfMsg'); m.className = 'err'; m.textContent = "Linking Last.fm didn't work. Try again."; }
      if (q) history.replaceState(null, '', location.pathname);
    },
    get state() { return ST; },
  };
})();
