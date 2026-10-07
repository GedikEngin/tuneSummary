'use strict';
// Shared chrome for every TuneSummary page: top bar, footer, theme toggle, API helper, ad slot.
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const REPO = 'https://github.com/GedikEngin/tuneSummary';

async function api(path, opts = {}) {
  const r = await fetch(path, {credentials: 'same-origin', ...opts});
  let body = null;
  try { body = await r.json(); } catch (e) {}
  if (!r.ok) { const err = new Error((body && body.detail) || r.statusText || 'Request failed'); err.status = r.status; throw err; }
  return body;
}
const postJSON = (path, data) => api(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data || {})});

let CONFIG = {google: false, ads: null, signed_in: false};
const configReady = api('api/config').then(c => { CONFIG = c; return c; }).catch(() => CONFIG);

function chrome() {
  const here = document.body.dataset.page || '';
  const link = (href, label, key, cls = '') => `<a href="${href}" class="${cls}${here === key ? ' active' : ''}">${label}</a>`;
  const bar = $('#bar');
  if (bar) {
    bar.className = 'bar';
    bar.innerHTML = `<div class="wrap bar-inner">
      <a href="./" class="mark">TuneSummary <span>/ gedik.tech</span></a>
      <nav class="nav">${link('guide', 'How it works', 'guide', 'opt')}${link('privacy', 'Privacy', 'privacy', 'opt')}<span id="navAuth">${link('signin', 'Sign in', 'signin')}</span></nav>
      <button class="toggle" id="toggle" type="button" aria-label="Switch colour theme"></button></div>`;
    const tg = $('#toggle');
    const label = () => tg.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? 'Light' : 'Dark';
    label();
    tg.onclick = () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('eg-survey-theme', next); } catch (e) {}
      label(); document.dispatchEvent(new Event('themechange'));
    };
    configReady.then(c => { if (c.signed_in) $('#navAuth').innerHTML = link('app', 'My stats', 'app') + link('account', 'Account', 'account'); });
  }
  const foot = $('#foot');
  if (foot) {
    foot.className = 'foot';
    foot.innerHTML = `<div class="wrap foot-grid">
      <div><div class="meta"><b>TuneSummary</b> · free &amp; open source (MIT)</div>
      <p class="small mut" style="margin-top:6px;max-width:52ch">Listening stats from your own Spotify data export. Not affiliated with, endorsed by or sponsored by Spotify. Spotify is a trademark of Spotify AB.</p></div>
      <div class="links meta"><a href="guide">Guide</a><a href="privacy">Privacy</a><a href="terms">Terms</a><a href="${REPO}" target="_blank" rel="noopener">Source ↗</a><a href="/">gedik.tech ↗</a></div></div>`;
  }
}

// One ad slot per page at most, only when the server has an AdSense client configured and the user isn't a supporter.
async function fillAdSlot() {
  const slot = $('.ad-slot');
  if (!slot) return;
  const c = await configReady;
  if (!c.ads) { slot.remove(); return; }
  slot.innerHTML = '<div class="meta">Advertisement · keeps TuneSummary free</div>';
  const s = document.createElement('script');
  s.async = true; s.crossOrigin = 'anonymous';
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(c.ads.client);
  document.head.appendChild(s);
  const ins = document.createElement('ins');
  ins.className = 'adsbygoogle'; ins.style.display = 'block';
  ins.dataset.adClient = c.ads.client; if (c.ads.slot) ins.dataset.adSlot = c.ads.slot;
  ins.dataset.adFormat = 'auto'; ins.dataset.fullWidthResponsive = 'true';
  slot.appendChild(ins);
  (window.adsbygoogle = window.adsbygoogle || []).push({});
}

// Rewarded-ad hook used by the recap unlock and the Last.fm "update" button. Placeholder until Google Ad Manager
// rewarded ads are wired in: show something in `box` for `seconds`, then resolve true if the reward was earned.
window.TSRewarded = window.TSRewarded || {
  show(box, seconds) {
    return new Promise(res => {
      let left = seconds;
      const paint = () => { box.innerHTML = `<div><div class="meta">Advertisement</div><p class="display" style="font-size:1.6rem;margin:8px 0">Ad placeholder</p><p class="small mut">Rewarded ads aren't live yet. Continuing in <b>${left}</b> s…</p></div>`; };
      paint();
      const t = setInterval(() => { left--; if (left <= 0) { clearInterval(t); res(true); } else paint(); }, 1000);
    });
  },
};

chrome();
fillAdSlot();
