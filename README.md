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

No Spotify API calls are made. Users can download all their data as JSON or delete their account at any time.

## Stack

Python 3.11+, FastAPI, SQLite (WAL), plain HTML/CSS/JS (no build step, no third-party scripts).
The look follows the "Survey" design system of [gedik.tech](https://gedik.tech).

```
tunesummary/app.py      routes, auth, sessions, reminders scheduler
tunesummary/ingest.py   upload validation, storage, export
tunesummary/genres.py   MusicBrainz genre worker
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

## Tests

```sh
uv run pytest -q
node tests/test_client.js path/to/my_spotify_data.zip   # parser + dashboard in a DOM-less harness
```

## Data model

`users` (email, plan `free|supporter`, reminder state), `sessions` and `login_tokens` (only SHA-256 hashes
are stored), `plays` (unique on user, timestamp, track, episode), `artists` (shared genre cache),
`counters` (daily page-view / sign-up counts, no identifiers).

## License

MIT. See `LICENSE`.
