"""30-second song previews for the recap story (like Spotify Wrapped's soundtrack).

Looks a track up on Deezer (free, no key) and falls back to the iTunes Search API. The match is cached for everyone in
`previews`; the audio itself is proxied by the app (same origin, so the browser can decode it with Web Audio and the
visitor's IP never reaches Deezer/Apple). Deezer preview URLs are signed and expire after ~15 min, so only the Deezer
track id is cached and a fresh URL is asked for when needed."""
import logging
import re
import time
import unicodedata
import urllib.parse

import httpx

log = logging.getLogger("tunesummary.previews")
UA = "TuneSummary/0.1 (+https://gedik.tech/tunesummary; open source listening stats)"
HIT_DAYS, MISS_DAYS = 60, 7
MAX_BYTES = 3 * 1024 * 1024
AUDIO_HOSTS = (".dzcdn.net", ".itunes.apple.com", ".mzstatic.com")
DAY = 86400


def key(artist, track):
    return (artist or "").strip().lower() + "\u0001" + (track or "").strip().lower()


FOLD = str.maketrans({"ı": "i", "İ": "I", "ø": "o", "Ø": "O", "ß": "ss", "æ": "ae", "Æ": "AE", "œ": "oe", "đ": "d", "ł": "l", "Ł": "L"})
VARIANT = re.compile(r"\b(live|remix|mix|edit|karaoke|instrumental|acoustic|cover|tribute|sped up|slowed|demo|version)\b")


def norm(s):
    """Lowercase, no accents, no '(feat. …)' / '- Remastered 2011' style suffixes, letters and digits only."""
    s = unicodedata.normalize("NFKD", (s or "").translate(FOLD)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", s)
    s = re.sub(r"\s+-\s+.*$", "", s)
    s = re.sub(r"\b(feat|ft|featuring)\b.*$", "", s)
    s = s.replace("&", "and")
    return re.sub(r"[^a-z0-9]+", "", s)


def same_artist(want, got):
    a, b = norm(want), norm(got)
    short, long_ = sorted((a, b), key=len)
    return bool(a and b) and (a == b or (len(short) >= 6 and len(short) >= 0.6 * len(long_) and short in long_))


def same_title(want, got):
    a, b = norm(want), norm(got)
    return bool(a and b) and (a == b or (min(len(a), len(b)) >= 4 and (b.startswith(a) or a.startswith(b))))


def pick(cands, artist, track):
    """cands: [(artist, title, item)] in the source's relevance order. Best first: the same title as written, then the
    same title once suffixes are dropped, then a prefix match; live/remix/karaoke-style versions only if asked for."""
    want = track.strip().lower()
    ok = [c for c in cands if same_artist(artist, c[0]) and same_title(track, c[1])]
    def rank(c):
        got = c[1].strip().lower()
        odd = bool(VARIANT.search(got)) and not VARIANT.search(want)
        return (odd, 0 if got == want else 1 if norm(got) == norm(want) else 2)
    return min(ok, key=rank) if ok else None


class Previews:
    def __init__(self, db, http=None):
        self.db = db
        self.http = http or httpx.Client(timeout=12, headers={"User-Agent": UA}, follow_redirects=True)

    # ---------- lookups ----------
    def deezer(self, artist, track):
        r = self.http.get("https://api.deezer.com/search", params={"q": f"{artist} {track}", "limit": 15})
        r.raise_for_status()
        items = [x for x in r.json().get("data", []) if x.get("preview") and x.get("readable", True)]
        hit = pick([(x.get("artist", {}).get("name", ""), x.get("title", ""), x) for x in items], artist, track)
        if hit:
            x = hit[2]
            return {"source": "deezer", "ref": str(x["id"]), "url": x["preview"], "link": x.get("link"),
                    "title": x.get("title"), "artist": x["artist"]["name"]}
        return None

    def itunes(self, artist, track):
        r = self.http.get("https://itunes.apple.com/search",
                          params={"term": f"{artist} {track}", "entity": "song", "media": "music", "limit": 15})
        r.raise_for_status()
        items = [x for x in r.json().get("results", []) if x.get("previewUrl")]
        hit = pick([(x.get("artistName", ""), x.get("trackName", ""), x) for x in items], artist, track)
        if hit:
            x = hit[2]
            return {"source": "itunes", "ref": str(x.get("trackId", "")), "url": x["previewUrl"], "link": x.get("trackViewUrl"),
                    "title": x.get("trackName"), "artist": x.get("artistName")}
        return None

    def find(self, artist, track, now=None):
        """Cached match for (artist, track): a dict, or None if neither source has it.
        A miss is only cached when both sources answered; on network errors the old row (if any) is kept."""
        now = now or time.time()
        k = key(artist, track)
        row = self.db.one("SELECT * FROM previews WHERE k=?", (k,))
        if row and now - row["checked_at"] < (HIT_DAYS if row["source"] else MISS_DAYS) * DAY:
            return dict(row) if row["source"] else None
        hit, errors = None, 0
        for fn in (self.deezer, self.itunes):
            try:
                hit = fn(artist, track)
            except (httpx.HTTPError, ValueError, KeyError) as e:
                log.info("preview lookup via %s failed: %s", fn.__name__, e)
                errors += 1
                continue
            if hit:
                break
        if not hit and errors:
            return dict(row) if row and row["source"] else None
        h = hit or {}
        self.db.x("INSERT OR REPLACE INTO previews(k, source, ref, url, link, title, artist, checked_at) VALUES(?,?,?,?,?,?,?,?)",
                  (k, h.get("source"), h.get("ref"), h.get("url"), h.get("link"), h.get("title"), h.get("artist"), now))
        return dict(self.db.one("SELECT * FROM previews WHERE k=?", (k,))) if hit else None

    def fresh_url(self, p):
        """Deezer preview URLs carry an expiry (hdnea=exp=<unix>); get a new one when it's (nearly) up."""
        if p["source"] != "deezer":
            return p["url"]
        m = re.search(r"exp=(\d+)", p["url"] or "")
        if m and int(m.group(1)) > time.time() + 60:
            return p["url"]
        r = self.http.get(f"https://api.deezer.com/track/{p['ref']}")
        r.raise_for_status()
        url = r.json().get("preview") or ""
        if url:
            self.db.x("UPDATE previews SET url=? WHERE k=?", (url, p["k"]))
        return url

    # ---------- audio ----------
    def audio(self, artist, track):
        """(bytes, content_type, match) or None. Only ever fetches URLs that came from Deezer/Apple's own APIs."""
        p = self.find(artist, track)
        if not p:
            return None
        url = self.fresh_url(p)
        host = urllib.parse.urlsplit(url).hostname or ""
        if not url.startswith("https://") or not host.endswith(AUDIO_HOSTS):
            log.warning("preview url on unexpected host %s", host)
            return None
        r = self.http.get(url)
        if r.status_code in (403, 404, 410) and p["source"] == "deezer":  # signature expired early: one retry
            self.db.x("UPDATE previews SET url='' WHERE k=?", (p["k"],))
            p["url"] = ""
            r = self.http.get(self.fresh_url(p))
        r.raise_for_status()
        if len(r.content) > MAX_BYTES:
            return None
        ctype = "audio/mpeg" if p["source"] == "deezer" else "audio/mp4"  # Apple labels AAC previews audio/x-m4p
        return r.content, ctype, p
