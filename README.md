# TuneSummary

Free, open source listening stats for Spotify listeners, built from **your own Spotify data export**.
Minutes, streams, top tracks / artists / albums / genres / podcasts, time-of-day and weekday patterns, habits,
devices and countries, for any date range (all time, since your last Wrapped cutoff, any year, custom dates).

Live at **https://gedik.tech/tunesummary/**. Not affiliated with Spotify.

## How it works

1. Sign in with an email magic link (no passwords; optional Google sign-in).
2. Follow the guide to request your **Extended streaming history** at spotify.com/account/privacy.
   Optionally get a reminder email when it's likely ready.
3. Upload `my_spotify_data.zip`. The **browser** opens the zip and sends only compact play rows
   (gzip'd, in batches); account details, search history etc. never leave the device.
4. The server stores plays per user (de-duplicated, so re-uploads only add new plays) and looks up
   artist genres on [MusicBrainz](https://musicbrainz.org) in the background (1 request/s, shared cache).
5. The dashboard downloads your plays in a columnar format and aggregates everything client-side, so
   every range is instant.

No Spotify API calls are made.

## Live updates (Last.fm)

An export is a snapshot, so users can optionally link a **Last.fm** profile (Spotify scrobbles to Last.fm once they
connect it under Last.fm → Settings → Applications). `tunesummary/lastfm.py` imports scrobbles from
`user.getRecentTracks` (200 per page, `from=` the newest one we have) as plays with `source='lastfm'`:

- **The export wins.** Only scrobbles that *started after* the export's last play are imported, and uploading a newer
  export deletes scrobbles inside its window, so nothing is counted twice.
- **Lengths are estimated** (Last.fm doesn't record them): the longest play of that track in the user's own export,
  else `track.getInfo` (shared cache, max 150 lookups per sync), else 3.5 min. Rows are stored with `ts` = start + length,
  like exports.
- First sync goes back to the export's end or at most 12 months; big backlogs are fetched oldest-first, 150 pages per run.
- One background worker does all syncs, ≤ 4 requests/s, backing off on Last.fm error 29. Private profiles (error 17) get a
  clear message.
- Linking: Last.fm web auth (`/auth/lastfm` → `auth.getSession`, only the verified username is kept) when
  `TS_LASTFM_SHARED_SECRET` is set, otherwise a public username (checked with `user.getInfo`).
- **Connection health** (`tunesummary/lastfm_care.py`): Spotify's link to Last.fm expires after ~180 days and scrobbles
  then stop silently. A linked user is *stale* when the newest scrobble on Last.fm is > 7 days old, or nothing at all
  arrived 3 days after linking. Stale users get a dismissible dashboard banner with the fix (Last.fm → Settings →
  Applications → Spotify Scrobbling → Connect/Reconnect) that clears once a newer scrobble shows up (that also counts
  as a reconnect). Emails (opt-out: "Last.fm reminders" on the account page, or the `&k=lastfm` unsubscribe link):
  one when a user turns stale, one more 14 days later if still stale, and an "expires soon" heads-up 170 days after
  linking, then every 175 days after a detected reconnect or the previous heads-up.

Who can refresh is set by `TS_LIVE_GATE` (same idea as the recap gate; the first sync after linking is always free):

| Value | "↻ Update my latest stats" | Background sync |
|---|---|---|
| `off` (default) | syncs now, at most every `TS_LIVE_MANUAL_MINUTES` | everyone, every `TS_LIVE_AUTO_HOURS` |
| `ad` | free users watch a rewarded ad (`/api/lastfm/refresh/ad/start` → `/finish`, server-recorded), once per `TS_LIVE_AD_HOURS`; supporters skip it | supporters, every `TS_LIVE_SUPPORTER_HOURS` |
| `supporter` | supporters only | supporters, every `TS_LIVE_SUPPORTER_HOURS` |

Last.fm's API terms apply: credit ("Powered by AudioScrobbler", linking to Last.fm) is shown wherever Last.fm data is
used, and the API is licensed for **non-commercial use** only. Switching `TS_LIVE_GATE` to `ad`/`supporter` (or running
ads next to Last.fm data) needs a commercial agreement with Last.fm (partners@last.fm) first.

## Recap story

`/tunesummary/recap` plays an animated, tap-through story of a period (since the last year-end cutoff, any year, or all time):
intro, minutes, top artist, top 5 tracks, genre mix, listening clock, biggest day + longest streak, a listening personality
(one of 8 archetypes picked deterministically from the stats, e.g. Loyalist, Night Owl, Repeat Offender) and a summary card.
Every slide is drawn on a canvas by one function per slide (`web/static/js/recapdraw.js`), so the live story, the
1080×1920 PNG of each slide and the video (MediaRecorder, MP4 where supported, else WebM) all come from the same code.
Numbers come from `recapdata.js` (pure functions, tested in node). `recap?demo=1` uses the demo account.

Access is set by `TS_RECAP_GATE`:

| Value | Who gets the full story + video |
|---|---|
| `off` (default) | everyone |
| `supporter` | users whose `plan` is `supporter` (read from the database, never from the client) |
| `ad` | supporters, or anyone who watches a rewarded ad: `POST /api/recap/unlock/start` returns a nonce, `.../finish` after `TS_RECAP_AD_SECONDS` records the unlock for that sign-in session |

Everyone else gets intro, minutes, top artist and the summary card. The ad itself is a placeholder hook
(`window.TSRewarded.show(box, seconds)` in `recap.js`) meant to be swapped for Google Ad Manager rewarded ads. Users can download all their data as JSON or delete their account at any time.

## Link previews

Every page gets a canonical URL, Open Graph + Twitter card tags and icons from `social()` in `app.py`. The preview image
`web/static/og.png` (1200×630) is rendered from `scripts/og.html` in headless Chrome against a live page (so the
self-hosted fonts load).

## Stack

Python 3.11+, FastAPI, SQLite (WAL), plain HTML/CSS/JS (no build step, no third-party scripts).
The look follows the "Survey" design system of [gedik.tech](https://gedik.tech).

```
tunesummary/app.py      routes, auth, sessions, reminders scheduler
tunesummary/ingest.py   upload validation, storage, export
tunesummary/genres.py   MusicBrainz genre worker
tunesummary/lastfm.py   Last.fm client, scrobble import + dedupe, sync worker
tunesummary/lastfm_care.py  connection health: stale detection, reconnect + "expires soon" emails
tunesummary/mailer.py   email sending (SMTP or log backend; swap for an API provider here)
tunesummary/emails.py   email texts
web/                    pages + static/{css,js,fonts}
tests/                  pytest + node tests
```

## Run it yourself

```sh
uv sync
cp .env.example .env            # edit; TS_MAIL_BACKEND=log writes emails to data/outbox.log
set -a; . ./.env; set +a
uv run tunesummary              # http://127.0.0.1:8797/tunesummary/
```

Configuration is all environment variables; see `.env.example`. Notable ones:

| Variable | Meaning |
|---|---|
| `TS_BASE_PATH` | URL prefix the app is served under (default `/tunesummary`) |
| `TS_PUBLIC_URL` | public URL used in email links |
| `TS_SMTP_*`, `TS_MAIL_FROM` | outgoing mail; `TS_MAIL_DAILY_CAP` limits sends per 24 h |
| `TS_GOOGLE_CLIENT_ID/SECRET` | enables "Continue with Google" (redirect URI `<public url>/auth/google/callback`) |
| `TS_ADSENSE_CLIENT/SLOT` | enables the single ad slot (off by default; never shown to `supporter` plan users) |
| `TS_RECAP_GATE` | `off` / `ad` / `supporter`: who gets the full recap (see above) |
| `TS_RECAP_AD_SECONDS` | length of the rewarded-ad placeholder (default 15) |
| `TS_LASTFM_API_KEY` / `_SHARED_SECRET` | enables Last.fm live updates (hidden when empty); the secret switches linking to Last.fm web auth |
| `TS_LIVE_GATE` | `off` / `ad` / `supporter`: who can refresh from Last.fm (see above) |

## Tests

```sh
uv run pytest -q
node tests/test_client.js path/to/my_spotify_data.zip   # parser + dashboard in a DOM-less harness
node tests/test_recap.js [path/to/my_spotify_data.zip]  # recap numbers, archetypes, dry run of every slide
```

## Data model

`users` (email, plan `free|supporter`, reminder state), `sessions` and `login_tokens` (only SHA-256 hashes
are stored), `plays` (unique on user, timestamp, track, episode; `source` NULL = export, `lastfm` = scrobble), `artists` (shared genre cache),
`recap_unlocks` (rewarded-ad views, by session hash), `live_refreshes` (ad-paid Last.fm refreshes), `track_lengths`
(shared Last.fm track-length cache), `counters` (daily page-view / sign-up counts, no identifiers).

## License

MIT. See `LICENSE`.
