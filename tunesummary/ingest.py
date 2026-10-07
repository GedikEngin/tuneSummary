"""Validate and store the compact play batches the browser sends, and export them back out.

The browser unzips Spotify's export and sends columnar batches (strings de-duplicated):
  {"tracks": [[track, artist, album, track_id|null], ...], "episodes": [[episode, show], ...],
   "platforms": [...], "countries": [...],
   "rows": [[ts_ms, ms_played, track_idx|-1, episode_idx|-1, platform_idx|-1, country_idx|-1, flags], ...]}
flags: 1 = skipped, 2 = shuffle, 4 = the row carries skip/shuffle info (extended history),
       8 = from Last.fm (server → browser only; length estimated).
"""
import re
import time
from datetime import datetime, timezone

MAX_ROWS = 25000          # per batch
MAX_STR = 400
MIN_TS = 1136073600000    # 2006-01-01, before Spotify existed
TRACK_ID = re.compile(r"^[A-Za-z0-9]{1,40}$")
COLS = ("user_id", "ts", "ms", "track", "artist", "album", "track_id", "episode", "show",
        "skipped", "shuffle", "platform", "country", "source")


class BadBatch(ValueError):
    pass


def _s(v, required=False):
    if v is None or v == "":
        if required:
            raise BadBatch("missing name")
        return None
    if not isinstance(v, str):
        raise BadBatch("bad string")
    return v[:MAX_STR]


def _lst(d, k):
    v = d.get(k) or []
    if not isinstance(v, list):
        raise BadBatch(f"{k} must be a list")
    return v


def parse_batch(d, uid):
    if not isinstance(d, dict):
        raise BadBatch("expected an object")
    tracks, eps = _lst(d, "tracks"), _lst(d, "episodes")
    plats, ctrs, rows = _lst(d, "platforms"), _lst(d, "countries"), _lst(d, "rows")
    if len(rows) > MAX_ROWS:
        raise BadBatch(f"at most {MAX_ROWS} rows per batch")
    T = []
    for t in tracks:
        if not isinstance(t, list) or len(t) < 3:
            raise BadBatch("bad track")
        tid = t[3] if len(t) > 3 else None
        T.append((_s(t[0], True), _s(t[1]) or "Unknown", _s(t[2]) or "",
                  tid if isinstance(tid, str) and TRACK_ID.match(tid) else None))
    E = []
    for e in eps:
        if not isinstance(e, list) or len(e) < 2:
            raise BadBatch("bad episode")
        E.append((_s(e[0], True), _s(e[1]) or "Unknown show"))
    P = [_s(p) for p in plats]
    C = [(_s(c) or "")[:8] or None for c in ctrs]
    max_ts = (time.time() + 2 * 86400) * 1000
    out = []
    for r in rows:
        if not isinstance(r, list) or len(r) != 7 or not all(isinstance(x, int) and not isinstance(x, bool) for x in r):
            raise BadBatch("bad row")
        ts, ms, ti, ei, pi, ci, fl = r
        if not (MIN_TS <= ts <= max_ts) or not (0 <= ms <= 86400000):
            continue
        rec = {"user_id": uid, "ts": ts, "ms": ms, "platform": P[pi] if 0 <= pi < len(P) else None,
               "country": C[ci] if 0 <= ci < len(C) else None}
        if 0 <= ti < len(T):
            rec["track"], rec["artist"], rec["album"], rec["track_id"] = T[ti]
        elif 0 <= ei < len(E):
            rec["episode"], rec["show"] = E[ei]
        else:
            raise BadBatch("row points at no track or episode")
        if fl & 4:
            rec["skipped"], rec["shuffle"] = int(bool(fl & 1)), int(bool(fl & 2))
        out.append(rec)
    return out


def store(db, rows):
    sql = "INSERT OR IGNORE INTO plays(%s) VALUES(%s)" % (",".join(COLS), ",".join("?" * len(COLS)))
    return db.tx(lambda c: c.executemany(sql, [tuple(r.get(k) for k in COLS) for r in rows]).rowcount)


def finish_upload(db, uid):
    """After an upload: if the user now has extended history, drop basic-history rows (minute-precision
    timestamps, no skip info) inside the period the extended history covers, so plays aren't counted twice.
    Then drop Last.fm scrobbles inside the export's window (the export is authoritative there)."""
    from .lastfm import drop_inside_export
    ext = db.one("SELECT MIN(ts) lo, MAX(ts) hi FROM plays WHERE user_id=? AND skipped IS NOT NULL", (uid,))
    n = 0
    if ext["lo"] is not None:
        n = db.x("DELETE FROM plays WHERE user_id=? AND source IS NULL AND skipped IS NULL AND ts BETWEEN ? AND ?",
                 (uid, ext["lo"] - 60000, ext["hi"] + 60000)).rowcount  # basic times are cut to the minute
    return n + drop_inside_export(db, uid)


def compact(db, uid):
    """All of a user's plays in the same columnar shape (the browser aggregates any date range itself)."""
    T, Ti, E, Ei, P, Pi, C, Ci, rows = [], {}, [], {}, [], {}, [], {}, []

    def idx(lst, ix, key):
        if key not in ix:
            ix[key] = len(lst)
            lst.append(list(key) if isinstance(key, tuple) else key)
        return ix[key]

    for r in db.conn.execute("SELECT * FROM plays WHERE user_id=? ORDER BY ts", (uid,)):
        if r["track"] is not None:
            t, e = idx(T, Ti, (r["track"], r["artist"], r["album"], r["track_id"])), -1
        else:
            t, e = -1, idx(E, Ei, (r["episode"], r["show"]))
        p = idx(P, Pi, r["platform"]) if r["platform"] else -1
        c = idx(C, Ci, r["country"]) if r["country"] else -1
        fl = 0 if r["skipped"] is None else 4 | (r["skipped"] and 1) | (2 if r["shuffle"] else 0)
        if r["source"] == "lastfm":
            fl |= 8
        rows.append([r["ts"], r["ms"], t, e, p, c, fl])
    return {"tracks": T, "episodes": E, "platforms": P, "countries": C, "rows": rows}


def export(db, uid):
    """The user's plays in Spotify's extended-history JSON shape, so the data can go anywhere."""
    iso = lambda ms: datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return [{"ts": iso(r["ts"]), "ms_played": r["ms"], "master_metadata_track_name": r["track"],
             "master_metadata_album_artist_name": r["artist"], "master_metadata_album_album_name": r["album"],
             "spotify_track_uri": ("spotify:track:" + r["track_id"]) if r["track_id"] else None,
             "episode_name": r["episode"], "episode_show_name": r["show"],
             "skipped": None if r["skipped"] is None else bool(r["skipped"]),
             "shuffle": None if r["shuffle"] is None else bool(r["shuffle"]),
             "platform": r["platform"], "conn_country": r["country"],
             **({"tunesummary_source": "lastfm"} if r["source"] == "lastfm" else {})}
            for r in db.q("SELECT * FROM plays WHERE user_id=? ORDER BY ts", (uid,))]
