"""Live updates from Last.fm: users link their (public) Last.fm profile, we import scrobbles as plays.

Spotify can scrobble to Last.fm (Last.fm settings → Applications → Spotify), so a linked profile keeps the stats
current between data exports. Rules:
  * The export is authoritative for the period it covers. Scrobbles are only imported when they started after the
    export's last play, and scrobbles inside an export's window are dropped when an export is uploaded.
  * Scrobbles have no listening length. ms is estimated: the longest play of the same track in the user's own
    export (≈ its duration), else a cached Last.fm track.getInfo duration, else 3.5 minutes.
  * Stored rows: ts = scrobble start + estimated ms (exports store the END of a play), source = 'lastfm'.
  * Rate limits: at most ~4 requests/s from this server (Last.fm allows 5/s), back off on error 29.
"""
import hashlib
import logging
import threading
import time
import urllib.parse

import httpx

log = logging.getLogger("tunesummary.lastfm")
API = "https://ws.audioscrobbler.com/2.0/"
UA = "TuneSummary/0.1 (+https://gedik.tech/tunesummary; open source listening stats)"
DEFAULT_MS = 210000                 # 3.5 min when a track's length is unknown
FIRST_SYNC_DAYS = 365               # without an export, the first sync goes back this far
MAX_PAGES = 150                     # 200 scrobbles a page → up to 30k scrobbles per sync
MAX_INFO_LOOKUPS = 150              # track.getInfo calls per sync (the rest get DEFAULT_MS)
TEMPORARY = {8, 11, 16, 29}         # Last.fm error codes worth retrying
MAX_STR = 400


class LastfmError(Exception):
    def __init__(self, code, message):
        super().__init__(f"Last.fm error {code}: {message}")
        self.code = code
        self.message = message


class Client:
    """Thin Last.fm API client. `http_get(params) -> (status, json)` can be swapped out in tests."""

    def __init__(self, api_key, secret="", http_get=None, min_interval=0.25):
        self.key, self.secret = api_key, secret
        self.http_get = http_get or self._get
        self.min_interval = min_interval
        self.lock = threading.Lock()
        self.last = 0.0

    @staticmethod
    def _get(params):
        r = httpx.get(API, params=params, timeout=30, headers={"User-Agent": UA})
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, {"error": 8, "message": f"HTTP {r.status_code}"}

    def sign(self, params):
        """api_sig: md5 of the sorted key+value pairs (minus format/callback) followed by the shared secret."""
        s = "".join(k + str(params[k]) for k in sorted(params) if k not in ("format", "callback"))
        return hashlib.md5((s + self.secret).encode()).hexdigest()

    def call(self, method, signed=False, **params):
        params = {"method": method, "api_key": self.key, **{k: v for k, v in params.items() if v is not None}}
        if signed:
            params["api_sig"] = self.sign(params)
        params["format"] = "json"
        for attempt in range(4):
            with self.lock:  # one request at a time, spaced out, for the whole process
                wait = self.min_interval - (time.time() - self.last)
                if wait > 0:
                    time.sleep(wait)
                self.last = time.time()
                status, data = self.http_get(params)
            if isinstance(data, dict) and "error" in data:
                code = int(data.get("error") or 0)
                if code in TEMPORARY and attempt < 3:
                    time.sleep(self.backoff(attempt, code))
                    continue
                raise LastfmError(code, str(data.get("message", ""))[:200])
            if status >= 500 and attempt < 3:
                time.sleep(self.backoff(attempt, 0))
                continue
            if status >= 400 or not isinstance(data, dict):
                raise LastfmError(status, "unexpected response")
            return data
        raise LastfmError(29, "rate limited")

    @staticmethod
    def backoff(attempt, code):
        return (10 if code == 29 else 2) * (attempt + 1)

    def auth_url(self, callback):
        return "https://www.last.fm/api/auth/?" + urllib.parse.urlencode({"api_key": self.key, "cb": callback})

    def session_user(self, token):
        """Web auth: trade the callback token for a session; we only keep the verified username."""
        d = self.call("auth.getSession", signed=True, token=token)
        return d["session"]["name"]

    def user_info(self, user):
        return self.call("user.getInfo", user=user)["user"]

    def recent(self, user, page=1, frm=None, to=None):
        return self.call("user.getRecentTracks", user=user, limit=200, page=page, extended=0,
                         **{"from": frm, "to": to})

    def latest(self, user):
        """Unix time of the user's newest scrobble (any age), or None if they have none."""
        items, _ = parse_recent(self.call("user.getRecentTracks", user=user, limit=1, page=1, extended=0))
        return max((s["uts"] for s in items), default=None)

    def duration_ms(self, artist, track):
        try:
            d = self.call("track.getInfo", artist=artist, track=track, autocorrect=1)
        except LastfmError as e:
            if e.code == 6:  # track not found
                return 0
            raise
        try:
            return int(d.get("track", {}).get("duration") or 0)
        except (TypeError, ValueError):
            return 0


def _txt(v):
    if isinstance(v, dict):
        v = v.get("#text") or v.get("name") or ""
    v = (v or "").strip() if isinstance(v, str) else ""
    return v[:MAX_STR] or None


def parse_recent(d):
    """user.getRecentTracks JSON → ([{uts, track, artist, album}], total_pages). Skips the "now playing" entry."""
    rt = (d or {}).get("recenttracks") or {}
    items = rt.get("track") or []
    if isinstance(items, dict):  # Last.fm returns an object instead of a list when there's exactly one track
        items = [items]
    out = []
    for t in items:
        if not isinstance(t, dict):
            continue
        if (t.get("@attr") or {}).get("nowplaying") == "true":
            continue
        try:
            uts = int((t.get("date") or {}).get("uts"))
        except (TypeError, ValueError):
            continue
        name, artist = _txt(t.get("name")), _txt(t.get("artist"))
        if not name or not artist:
            continue
        out.append({"uts": uts, "track": name, "artist": artist, "album": _txt(t.get("album")) or ""})
    try:
        pages = int((rt.get("@attr") or {}).get("totalPages") or 1)
    except (TypeError, ValueError):
        pages = 1
    return out, pages


def export_window(db, uid):
    """(first, last) ts in ms of the user's export plays (source NULL), or (None, None)."""
    r = db.one("SELECT MIN(ts) lo, MAX(ts) hi FROM plays WHERE user_id=? AND source IS NULL", (uid,))
    return r["lo"], r["hi"]


def drop_inside_export(db, uid):
    """Export data wins: remove scrobbles that started inside the export's window."""
    lo, hi = export_window(db, uid)
    if lo is None:
        return 0
    return db.x("DELETE FROM plays WHERE user_id=? AND source='lastfm' AND ts-ms<=? AND ts>=?",
                (uid, hi, lo)).rowcount


def known_lengths(db, uid):
    """Longest export play per (artist, track) ≈ track length; only plays that look complete-ish (≥ 60 s)."""
    return {(r["a"], r["t"]): r["m"] for r in db.q(
        """SELECT lower(artist) a, lower(track) t, MAX(ms) m FROM plays
           WHERE user_id=? AND source IS NULL AND track IS NOT NULL AND ms>=60000 GROUP BY 1, 2""", (uid,))}


def estimate_lengths(db, client, uid, scrobbles, lookups=MAX_INFO_LOOKUPS):
    own = known_lengths(db, uid)
    keys = {(s["artist"].lower(), s["track"].lower()): (s["artist"], s["track"]) for s in scrobbles}
    out, missing = {}, []
    cached = {}
    klist = list(keys)
    for i in range(0, len(klist), 400):
        chunk = [a + "\u0001" + t for a, t in klist[i:i + 400]]
        for r in db.q("SELECT k, ms FROM track_lengths WHERE k IN (%s)" % ",".join("?" * len(chunk)), chunk):
            cached[r["k"]] = r["ms"]
    for k in klist:
        if own.get(k):
            out[k] = min(own[k], 1800000)
        elif cached.get(k[0] + "\u0001" + k[1]):
            out[k] = cached[k[0] + "\u0001" + k[1]]
        elif (k[0] + "\u0001" + k[1]) not in cached:
            missing.append(k)
    # Look up the most-played unknown tracks first.
    counts = {}
    for s in scrobbles:
        k = (s["artist"].lower(), s["track"].lower())
        counts[k] = counts.get(k, 0) + 1
    missing.sort(key=lambda k: -counts.get(k, 0))
    for k in missing[:lookups]:
        try:
            ms = client.duration_ms(*keys[k])
        except LastfmError as e:
            log.info("track.getInfo %r: %s", keys[k], e)
            break
        db.x("INSERT OR REPLACE INTO track_lengths(k, ms, checked_at) VALUES(?,?,?)", (k[0] + "\u0001" + k[1], ms, time.time()))
        if ms:
            out[k] = min(ms, 1800000)
    return {k: out.get(k) or DEFAULT_MS for k in keys}


def to_rows(uid, scrobbles, lengths):
    rows = []
    for s in scrobbles:
        ms = lengths.get((s["artist"].lower(), s["track"].lower()), DEFAULT_MS)
        rows.append({"user_id": uid, "ts": s["uts"] * 1000 + ms, "ms": ms, "track": s["track"], "artist": s["artist"],
                     "album": s["album"], "source": "lastfm"})
    return rows


def sync_start(db, uid, now=None):
    """Unix seconds to fetch scrobbles from: after the newest scrobble we have, after the export's last play,
    and no further back than FIRST_SYNC_DAYS."""
    now = now or time.time()
    u = db.one("SELECT lastfm_cursor FROM users WHERE id=?", (uid,))
    _, hi = export_window(db, uid)
    start = now - FIRST_SYNC_DAYS * 86400
    if hi:
        start = max(start, hi / 1000)
    if u and u["lastfm_cursor"]:
        start = max(start, u["lastfm_cursor"])
    return int(start) + 1


def sync_user(db, client, uid, now=None, max_pages=MAX_PAGES):
    """Fetch new scrobbles for one user and store them. Returns (plays added, more_left).
    Big backlogs go oldest-first, max_pages at a time, so the cursor never skips anything."""
    from . import ingest
    u = db.one("SELECT lastfm_user FROM users WHERE id=?", (uid,))
    if not u or not u["lastfm_user"]:
        return 0, False
    start = sync_start(db, uid, now)
    _, hi = export_window(db, uid)
    first, pages = parse_recent(client.recent(u["lastfm_user"], page=1, frm=start))
    more = pages > max_pages
    if more:  # pages run newest → oldest; take the oldest chunk now, the rest next time
        got = []
        for page in range(pages, pages - max_pages, -1):
            got.extend(parse_recent(client.recent(u["lastfm_user"], page=page, frm=start))[0])
    else:
        got = list(first)
        for page in range(2, pages + 1):
            got.extend(parse_recent(client.recent(u["lastfm_user"], page=page, frm=start))[0])
    # Newest scrobble on Last.fm at all (even ones the export already covers): the connection-health signal.
    newest = max((s["uts"] for s in first + got), default=None)
    if newest is None and not db.one("SELECT lastfm_newest FROM users WHERE id=?", (uid,))["lastfm_newest"]:
        newest = client.latest(u["lastfm_user"])  # nothing new since `start`; is there anything older?
    if newest:
        db.x("UPDATE users SET lastfm_newest=MAX(COALESCE(lastfm_newest, 0), ?) WHERE id=?", (newest, uid))
    got = [s for s in got if s["uts"] >= start and (hi is None or s["uts"] * 1000 > hi)]
    added = 0
    if got:
        rows = to_rows(uid, got, estimate_lengths(db, client, uid, got))
        added = ingest.store(db, rows)
        newest = max(s["uts"] for s in got)
        db.x("UPDATE users SET lastfm_cursor=MAX(COALESCE(lastfm_cursor, 0), ?) WHERE id=?", (newest, uid))
    return added, more


class SyncWorker(threading.Thread):
    """Runs Last.fm syncs one at a time: queued ones (button / just linked) first, then scheduled ones."""

    def __init__(self, db, client, due_fn, on_done=None):
        super().__init__(daemon=True, name="lastfm")
        self.db, self.client, self.due_fn, self.on_done = db, client, due_fn, on_done
        self.wake = threading.Event()

    def run_one(self, uid):
        self.db.x("UPDATE users SET lastfm_state='syncing' WHERE id=?", (uid,))
        try:
            added, more = sync_user(self.db, self.client, uid)
        except LastfmError as e:
            msg = {17: "Your Last.fm listening history is private. Turn off \"Hide recent listening information\" in Last.fm settings → Privacy.",
                   6: "That Last.fm user doesn't exist."}.get(e.code, "Last.fm didn't answer. We'll try again later.")
            self.db.x("UPDATE users SET lastfm_state='error', lastfm_error=?, lastfm_tried_at=? WHERE id=?", (msg, time.time(), uid))
            log.info("sync %s: %s", uid, e)
            return None
        except Exception:
            log.exception("sync %s", uid)
            self.db.x("UPDATE users SET lastfm_state='error', lastfm_error=?, lastfm_tried_at=? WHERE id=?",
                      ("Something went wrong. We'll try again later.", time.time(), uid))
            return None
        now = time.time()
        self.db.x("""UPDATE users SET lastfm_state=?, lastfm_error=NULL, lastfm_synced_at=?, lastfm_tried_at=?,
                      lastfm_added=? WHERE id=?""", ("queued" if more else "ok", now, now, added, uid))
        if self.on_done:
            self.on_done(uid, added)
        return added

    def step(self, now=None):
        rows = self.db.q("SELECT id FROM users WHERE lastfm_user IS NOT NULL AND lastfm_state='queued' ORDER BY lastfm_tried_at LIMIT 20")
        ids = [r["id"] for r in rows] or self.due_fn(now or time.time())
        for uid in ids:
            self.run_one(uid)
        return len(ids)

    def run(self):
        self.db.x("UPDATE users SET lastfm_state='queued' WHERE lastfm_state='syncing'")  # interrupted by a restart
        while True:
            try:
                n = self.step()
            except Exception:
                log.exception("lastfm worker")
                n = 0
            if not n:
                self.wake.wait(60)
                self.wake.clear()
