'use strict';
// Small per-page behaviour: sign-in form, reminder form, verify, unsubscribe, account.
const page = document.body.dataset.page;
const qs = new URLSearchParams(location.search);

async function requestLink(email, remindDays, msgEl, btn) {
  msgEl.textContent = 'Sending…'; msgEl.className = 'small'; btn.disabled = true;
  try {
    await postJSON('api/auth/request', {email, remind_days: remindDays});
    msgEl.innerHTML = `<b>Check your inbox.</b> We sent a sign-in link to ${esc(email)}. It works once, for 20 minutes. Not there? Check spam.`;
  } catch (e) {
    msgEl.textContent = e.message; msgEl.className = 'err';
  } finally { btn.disabled = false; }
}

if (page === 'signin') {
  const err = qs.get('error');
  if (err) { const el = $('#signErr'); el.classList.remove('hidden'); el.textContent = err === 'expired' ? 'That sign-in link has expired or was already used. Request a new one below.' : 'Google sign-in didn\'t work. Try the email link instead.'; }
  configReady.then(c => { if (c.google) $('#googleBox').classList.remove('hidden'); if (c.signed_in && !err) location.replace('app'); });
  $('#signForm').onsubmit = e => { e.preventDefault(); requestLink($('#signEmail').value.trim(), null, $('#signMsg'), $('#signForm button')); };
}

if (page === 'guide') {
  configReady.then(c => { if (c.lastfm) { $('#lastfm').classList.remove('hidden'); if (location.hash === '#lastfm') $('#lastfm').scrollIntoView(); } });
  configReady.then(c => { if (c.signed_in) $('#remindForm').innerHTML = '<p>You\'re signed in. Set or change your reminder on your <a href="account">account page</a>, or <a href="app">upload your export</a> if it has arrived.</p>'; });
  $('#remindForm').onsubmit = e => { e.preventDefault(); requestLink($('#remEmail').value.trim(), $('#remOn').checked ? +$('#remDays').value : null, $('#remMsg'), $('#remindForm button')); };
}

if (page === 'verify') {
  if (!document.querySelector('#verifyForm input[name=t]').value) { $('#verifyForm').classList.add('hidden'); $('#verifyBad').classList.remove('hidden'); }
}

if (page === 'unsub') {
  if (qs.get('k') === 'lastfm' || document.querySelector('#unsubForm input[name=k]').value === 'lastfm') {
    $('#unsubWhat').textContent = "Press the button and we won't send you any more Last.fm emails (stopped scrobbling, connection expiring). Your account and data stay as they are.";
    $('#unsubDoneWhat').textContent = 'No more Last.fm emails.';
  }
  if (qs.get('done')) { $('#unsubForm').classList.add('hidden'); $(qs.get('missing') ? '#unsubMissing' : '#unsubDone').classList.remove('hidden'); }
  else if (!document.querySelector('#unsubForm input[name=u]').value) { $('#unsubForm').classList.add('hidden'); $('#unsubMissing').classList.remove('hidden'); }
}

if (page === 'account') {
  const fmtD = t => t ? new Date(t).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'}) : '—';
  let ME = null;
  const load = async () => {
    try { ME = await api('api/me'); } catch (e) { if (e.status === 401) location.replace('signin'); else { $('#accErr').textContent = e.message; $('#accErr').classList.remove('hidden'); } return; }
    const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    $('#accSpec').innerHTML = row('Email', esc(ME.email)) + row('Plan', ME.plan === 'supporter' ? 'Supporter · thank you' : 'Free') +
      row('Member since', fmtD(ME.created)) + row('Plays stored', ME.plays.toLocaleString() + (ME.plays ? ` (${fmtD(ME.first)} → ${fmtD(ME.last)})` : '')) +
      row('Last upload', ME.last_upload ? fmtD(ME.last_upload) : 'not yet · <a class="u" href="app">upload</a>');
    const lf = ME.lastfm;
    if (lf) {
      $('#accLf').classList.remove('hidden');
      if (lf.linked) {
        $('#accLfText').innerHTML = `Linked to <a class="u" href="${esc(lf.profile)}" target="_blank" rel="noopener">${esc(lf.user)} ↗</a>${lf.verified ? ' (verified)' : ''}. ${lf.plays.toLocaleString()} plays imported from Last.fm${lf.synced_at ? ', last updated ' + new Date(lf.synced_at).toLocaleString() : ''}. Unlinking deletes those plays (your export data stays).`;
        $('#accLfBtns').innerHTML = '<button class="btn btn--line" id="accLfUn" type="button">Unlink Last.fm</button>';
        $('#accLfRemWrap').classList.remove('hidden');
        $('#accLfRem').checked = !!lf.reminders;
        $('#accLfRem').onchange = async () => {
          try { await postJSON('api/lastfm/reminders', {on: $('#accLfRem').checked}); $('#accLfMsg').className = 'small'; $('#accLfMsg').textContent = $('#accLfRem').checked ? 'Last.fm reminders on.' : 'Last.fm reminders off.'; }
          catch (e) { $('#accLfMsg').textContent = e.message; $('#accLfMsg').className = 'err'; }
        };
        $('#accLfUn').onclick = async () => {
          if (!confirm('Unlink Last.fm and delete the plays imported from it?')) return;
          try { const r = await postJSON('api/lastfm/unlink', {}); $('#accLfMsg').textContent = `Unlinked. Deleted ${r.deleted_plays.toLocaleString()} Last.fm plays.`; load(); }
          catch (e) { $('#accLfMsg').textContent = e.message; $('#accLfMsg').className = 'err'; }
        };
      } else {
        $('#accLfRemWrap').classList.add('hidden');
        $('#accLfText').innerHTML = 'Not linked. Link your Last.fm profile on <a class="u" href="app">your stats page</a> to keep your stats current between exports.';
        $('#accLfBtns').innerHTML = '';
      }
    }
    $('#accRem').checked = ME.reminders && !!ME.remind_at;
    $('#accRemMsg').textContent = ME.remind_at ? 'Next reminder: ' + new Date(ME.remind_at).toLocaleString() : (ME.last_upload ? 'You\'ve uploaded, so no reminders are needed.' : 'No reminder scheduled.');
  };
  const saveRem = async () => {
    try { await postJSON('api/reminders', {on: $('#accRem').checked, days: +$('#accDays').value}); await load(); }
    catch (e) { $('#accRemMsg').textContent = e.message; }
  };
  $('#accRem').onchange = saveRem; $('#accDays').onchange = () => { if ($('#accRem').checked) saveRem(); };
  $('#accDelPlays').onclick = async () => {
    if (!confirm('Delete all your stored plays? Your account stays; you can upload again any time.')) return;
    const r = await postJSON('api/plays/delete'); $('#accDataMsg').textContent = `Deleted ${r.deleted_plays.toLocaleString()} plays.`; load();
  };
  $('#accDel').onclick = async () => {
    const typed = prompt('This deletes your account and ALL your data right now. It can\'t be undone.\n\nType your email address to confirm:');
    if (typed === null) return;
    try { await postJSON('api/delete-account', {confirm: typed}); location.href = './?deleted=1'; }
    catch (e) { $('#accDataMsg').textContent = e.message; $('#accDataMsg').className = 'err'; }
  };
  $('#accOut').onclick = async () => { await postJSON('api/logout'); location.href = './'; };
  load();
}
