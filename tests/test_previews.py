"""Song previews for the recap: matching, caching, Deezer URL refresh, iTunes fallback and the /api/preview endpoint."""
import os
import tempfile
import time

import httpx
import pytest

os.environ.setdefault("TS_DATA_DIR", tempfile.mkdtemp())
os.environ.setdefault("TS_WORKERS", "0")
os.environ.setdefault("TS_MAIL_BACKEND", "log")

from fastapi.testclient import TestClient  # noqa: E402

from tunesummary import app as A  # noqa: E402
from tunesummary import previews  # noqa: E402

MP3 = b"ID3fake-mp3-bytes"


def dz_url(exp):
    return f"https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/x.mp3?hdnea=exp={exp}~acl=x~hmac=y"


class Fake:
    """Stands in for Deezer + iTunes + their CDNs."""
    def __init__(self, deezer=None, itunes=None, dz_down=False):
        self.deezer, self.itunes, self.dz_down, self.calls = deezer or [], itunes or [], dz_down, []
        self.exp = int(time.time()) + 900

    def handler(self, req):
        u = str(req.url)
        self.calls.append(u)
        if req.url.host == "api.deezer.com":
            if self.dz_down:
                return httpx.Response(503)
            if req.url.path == "/search":
                return httpx.Response(200, json={"data": [dict(x, preview=dz_url(self.exp)) for x in self.deezer]})
            return httpx.Response(200, json={"id": 1, "preview": dz_url(self.exp)})
        if req.url.host == "itunes.apple.com":
            return httpx.Response(200, json={"results": self.itunes})
        if req.url.host.endswith("dzcdn.net"):
            return httpx.Response(200, content=MP3, headers={"content-type": "audio/mpeg"})
        if req.url.host.endswith("itunes.apple.com"):
            return httpx.Response(200, content=b"m4a", headers={"content-type": "audio/x-m4a"})
        return httpx.Response(404)


def make(fake):
    A.db.x("DELETE FROM previews")
    A.db.x("DELETE FROM rate_events")
    return previews.Previews(A.db, httpx.Client(transport=httpx.MockTransport(fake.handler)))


def dz(id_, artist, title, readable=True):
    return {"id": id_, "title": title, "artist": {"name": artist}, "link": f"https://www.deezer.com/track/{id_}", "readable": readable}


def test_norm_and_match():
    assert previews.norm("Şımarık") == previews.norm("Simarik")
    assert previews.same_title("Dreams - 2004 Remaster", "Dreams")
    assert previews.same_title("Money Trees (feat. Jay Rock)", "Money Trees")
    assert previews.same_artist("Beyoncé", "Beyonce")
    assert not previews.same_artist("Radiohead", "Radio")
    assert not previews.same_title("Dreams", "Sweet Dreams (Are Made of This)")
    cands = [("Radiohead", "Reckoner - Live", 1), ("Radiohead", "Reckoner", 2), ("Cover Band", "Reckoner", 3)]
    assert previews.pick(cands, "Radiohead", "Reckoner")[2] == 2


def test_deezer_match_cached_and_audio():
    f = Fake(deezer=[dz(9, "A Cover Band", "Reckoner"), dz(7, "Radiohead", "Reckoner (Live)"), dz(5, "Radiohead", "Reckoner")])
    p = make(f)
    body, ctype, m = p.audio("Radiohead", "Reckoner")
    assert body == MP3 and ctype == "audio/mpeg" and m["source"] == "deezer" and m["ref"] == "5"
    n = len(f.calls)
    p.audio("radiohead", "reckoner")  # cached match, still-valid URL: only the CDN is hit
    assert len(f.calls) == n + 1 and "dzcdn.net" in f.calls[-1]


def test_expired_deezer_url_is_refreshed():
    f = Fake(deezer=[dz(5, "Radiohead", "Reckoner")])
    p = make(f)
    p.find("Radiohead", "Reckoner")
    A.db.x("UPDATE previews SET url=?", (dz_url(int(time.time()) - 5),))
    p.audio("Radiohead", "Reckoner")
    assert any(c.startswith("https://api.deezer.com/track/5") for c in f.calls)
    assert str(f.exp) in A.db.one("SELECT url FROM previews")["url"]


def test_itunes_fallback_and_miss_cache():
    f = Fake(deezer=[dz(1, "Someone Else", "Gidiyorum")],
             itunes=[{"trackId": 44, "artistName": "Sezen Aksu", "trackName": "Gidiyorum",
                      "previewUrl": "https://audio-ssl.itunes.apple.com/x/p.m4a", "trackViewUrl": "https://music.apple.com/x"}])
    p = make(f)
    body, ctype, m = p.audio("Sezen Aksu", "Gidiyorum")
    assert m["source"] == "itunes" and body == b"m4a"
    assert p.find("Nobody", "Nothing") is None
    n = len(f.calls)
    assert p.find("Nobody", "Nothing") is None and len(f.calls) == n  # miss is cached


def test_network_error_does_not_cache_a_miss():
    f = Fake(dz_down=True)
    p = make(f)
    assert p.find("Radiohead", "Reckoner") is None
    assert A.db.one("SELECT COUNT(*) n FROM previews")["n"] == 0


def test_refuses_unexpected_audio_host():
    f = Fake(itunes=[{"trackId": 1, "artistName": "Radiohead", "trackName": "Reckoner", "previewUrl": "https://evil.example/x.mp3"}])
    p = make(f)
    assert p.audio("Radiohead", "Reckoner") is None


def test_endpoint(monkeypatch):
    f = Fake(deezer=[dz(5, "Radiohead", "Reckoner")])
    monkeypatch.setattr(A, "prev", make(f))
    c = TestClient(A.app)
    base = A.BASE + "/api/preview"
    r = c.get(base, params={"a": "Radiohead", "t": "Reckoner"})
    assert r.status_code == 200 and r.content == MP3 and r.headers["content-type"] == "audio/mpeg"
    assert r.headers["x-preview-source"] == "deezer" and "max-age" in r.headers["cache-control"]
    assert c.get(base, params={"a": "Nobody", "t": "Nothing"}).status_code == 404
    assert c.get(base, params={"a": "", "t": "x"}).status_code == 400
    monkeypatch.setattr(A, "PREVIEWS_ON", False)
    assert c.get(base, params={"a": "Radiohead", "t": "Reckoner"}).status_code == 404
    monkeypatch.setattr(A, "PREVIEWS_ON", True)
    # other API responses keep no-store
    assert c.get(A.BASE + "/api/config").headers["cache-control"] == "no-store"


def test_endpoint_rate_limits_new_lookups(monkeypatch):
    f = Fake()
    monkeypatch.setattr(A, "prev", make(f))
    c = TestClient(A.app)
    codes = [c.get(A.BASE + "/api/preview", params={"a": "X", "t": f"Song {i}"}).status_code for i in range(62)]
    assert codes[:60] == [404] * 60 and codes[60] == 429
