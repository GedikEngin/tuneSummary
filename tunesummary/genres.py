"""Background genre lookups via MusicBrainz (free, no key). One shared cache for all users, max ~1 request/s."""
import json
import logging
import threading
import time
import urllib.parse

import httpx

log = logging.getLogger("tunesummary.genres")
UA = "TuneSummary/0.1 (+https://gedik.tech/tunesummary; open source listening stats)"
_last = [0.0]


def _mb(url):
    wait = 1.1 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()
    r = httpx.get(url, timeout=20, headers={"User-Agent": UA, "Accept": "application/json"})
    if r.status_code == 503:  # rate limited: back off and let the caller retry later
        time.sleep(5)
    r.raise_for_status()
    return r.json()


def musicbrainz_genres(name):
    """Returns [[genre, weight], ...] (top few, weights = vote counts); [] if unknown.
    Raises on network errors so the artist is retried later instead of being cached as genre-less."""
    q = 'artist:"%s"' % name.replace("\\", "\\\\").replace('"', '\\"')
    s = _mb("https://musicbrainz.org/ws/2/artist/?fmt=json&limit=5&query=" + urllib.parse.quote(q))
    cands = [a for a in s.get("artists", []) if a.get("score", 0) >= 85]
    hit = next((a for a in cands if a["name"].lower() == name.lower()), cands[0] if cands else None)
    if not hit:
        return []
    d = _mb(f"https://musicbrainz.org/ws/2/artist/{hit['id']}?fmt=json&inc=genres")
    g = sorted([x for x in d.get("genres", []) if x.get("count", 0) > 0], key=lambda x: -x["count"])
    if not g:
        g = sorted([x for x in hit.get("tags", []) if x.get("count", 0) > 1], key=lambda x: -x["count"])[:3]
    top = g[0]["count"] if g else 1
    return [[x["name"], x["count"]] for x in g if x["count"] >= max(1, top * 0.3)][:4]


class GenreWorker(threading.Thread):
    """Looks up artists nobody has looked up yet, most-listened first (across all users)."""

    def __init__(self, db, lookup=musicbrainz_genres):
        super().__init__(daemon=True, name="genres")
        self.db, self.lookup = db, lookup
        self.wake = threading.Event()
        self.failures = {}

    def pending(self, limit=50):
        return self.db.q("""SELECT p.artist name, lower(p.artist) k, SUM(p.ms) tot FROM plays p
                            LEFT JOIN artists a ON a.name_key = lower(p.artist)
                            WHERE p.artist IS NOT NULL AND a.name_key IS NULL
                            GROUP BY lower(p.artist) ORDER BY tot DESC LIMIT ?""", (limit,))

    def step(self):
        rows = [r for r in self.pending() if self.failures.get(r["k"], 0) < 3]
        for r in rows:
            try:
                genres = self.lookup(r["name"])
            except Exception as e:
                self.failures[r["k"]] = self.failures.get(r["k"], 0) + 1
                log.info("musicbrainz %r: %s", r["name"], e)
                continue
            self.db.x("INSERT OR REPLACE INTO artists(name_key, name, genres, checked_at) VALUES(?,?,?,?)",
                      (r["k"], r["name"], json.dumps(genres), time.time()))
        return len(rows)

    def run(self):
        while True:
            try:
                n = self.step()
            except Exception:
                log.exception("genre worker")
                n = 0
            if not n:
                self.wake.wait(600)
                self.wake.clear()
