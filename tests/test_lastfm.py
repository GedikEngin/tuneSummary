"""Last.fm live updates: response parsing, client retries/signing, sync + dedupe against exports, refresh gates.
Last.fm itself is faked (no network)."""
import hashlib
import time

import pytest

import test_app as T  # sets the env + temp data dir before the app is imported
from fastapi.testclient import TestClient

from tunesummary import app as A
from tunesummary import lastfm

DAY = 86400


class FakeLastfm:
    """Answers the handful of API methods we use, from an in-memory scrobble list (newest first, like Last.fm)."""

    def __init__(self, scrobbles=(), durations=None, users=("alice",)):
        self.scrobbles = list(scrobbles)            # (uts, artist, track, album)
        self.durations = durations or {}            # (artist, track) -> ms
        self.users = {u.lower(): u for u in users}
        self.calls = []
        self.fail = {}                              # method -> list of error codes to return first

    def __call__(self, p):
        self.calls.append(dict(p))
        m = p["method"]
        if self.fail.get(m):
            code = self.fail[m].pop(0)
            return 200, {"error": code, "message": "fake error %d" % code}
        if m == "user.getInfo":
            u = self.users.get(p["user"].lower())
            return (200, {"user": {"name": u}}) if u else (200, {"error": 6, "message": "User not found"})
        if m == "track.getInfo":
            ms = self.durations.get((p["artist"], p["track"]))
            return (200, {"track": {"name": p["track"], "duration": str(ms)}}) if ms is not None else (200, {"error": 6, "message": "Track not found"})
        if m == "auth.getSession":
            return 200, {"session": {"name": "alice", "key": "k", "subscriber": 0}}
        if m == "user.getRecentTracks":
            frm = int(p.get("from") or 0)
            rows = sorted([s for s in self.scrobbles if s[0] >= frm], key=lambda s: -s[0])
            per, page = int(p["limit"]), int(p["page"])
            pages = max(1, -(-len(rows) // per))
            items = [{"artist": {"mbid": "", "#text": a}, "name": t, "album": {"mbid": "", "#text": al}, "url": "x",
                      "date": {"uts": str(uts), "#text": "whatever"}} for uts, a, t, al in rows[(page - 1) * per: page * per]]
            if page == 1:
                items.insert(0, {"artist": {"#text": "Now"}, "name": "Playing", "@attr": {"nowplaying": "true"}})
            return 200, {"recenttracks": {"track": items, "@attr": {"user": p["user"], "page": str(page), "totalPages": str(pages),
                                                                     "perPage": str(per), "total": str(len(rows))}}}
        return 200, {"error": 3, "message": "Invalid method"}


@pytest.fixture
def fake(monkeypatch):
    f = FakeLastfm()
    cl = lastfm.Client("testkey", "", http_get=f, min_interval=0)
    monkeypatch.setattr(lastfm.Client, "backoff", staticmethod(lambda attempt, code: 0))
    monkeypatch.setattr(A, "lfm", cl)
    monkeypatch.setattr(A, "LASTFM_KEY", "testkey")
    monkeypatch.setattr(A.live, "client", cl)
    return f


def user_id(email):
    return A.db.one("SELECT id FROM users WHERE email=?", (email,))["id"]


def upload(c, rows):
    """rows: (ts_ms, ms, track, artist) extended-history plays."""
    recs = [{"t": t, "ms": ms, "tr": tr, "ar": ar, "al": "LP", "u": None, "sk": False, "sh": False, "pf": "ios", "cc": "US"}
            for t, ms, tr, ar in rows]
    for b in T.batches(recs):
        assert c.post("/tunesummary/api/upload", json=b).status_code == 200
    assert c.post("/tunesummary/api/upload/done", json={}).status_code == 200


# ---------------- parsing + client ----------------
def test_parse_recent_shapes():
    items, pages = lastfm.parse_recent({"recenttracks": {"track": [
        {"artist": {"#text": "Björk"}, "name": "Jóga", "album": {"#text": "Homogenic"}, "date": {"uts": "1700000000"}},
        {"artist": {"#text": "X"}, "name": "Now", "@attr": {"nowplaying": "true"}},
        {"artist": {"#text": "Y"}, "name": "No date"},
        {"artist": {"#text": ""}, "name": "No artist", "date": {"uts": "1700000001"}},
        {"artist": {"name": "Ext"}, "name": "Extended form", "date": {"uts": "1700000002"}},
    ], "@attr": {"totalPages": "7"}}})
    assert pages == 7
    assert items == [{"uts": 1700000000, "track": "Jóga", "artist": "Björk", "album": "Homogenic"},
                     {"uts": 1700000002, "track": "Extended form", "artist": "Ext", "album": ""}]
    # exactly one track comes back as an object, not a list
    one, pages = lastfm.parse_recent({"recenttracks": {"track": {"artist": {"#text": "A"}, "name": "B", "date": {"uts": "5"}},
                                                       "@attr": {"totalPages": "1"}}})
    assert one == [{"uts": 5, "track": "B", "artist": "A", "album": ""}] and pages == 1
    assert lastfm.parse_recent({}) == ([], 1)


def test_client_signing_and_retries(monkeypatch):
    f = FakeLastfm()
    cl = lastfm.Client("KEY", "SECRET", http_get=f, min_interval=0)
    monkeypatch.setattr(lastfm.Client, "backoff", staticmethod(lambda attempt, code: 0))
    assert cl.session_user("tok123") == "alice"
    p = f.calls[-1]
    expect = hashlib.md5(("api_keyKEY" + "methodauth.getSession" + "tokentok123" + "SECRET").encode()).hexdigest()
    assert p["api_sig"] == expect and p["format"] == "json"
    f.fail["user.getInfo"] = [29, 29]             # rate limited twice, then fine
    assert cl.user_info("alice")["name"] == "alice"
    f.fail["user.getInfo"] = [29, 29, 29, 29]     # gives up after 4 tries
    with pytest.raises(lastfm.LastfmError) as e:
        cl.user_info("alice")
    assert e.value.code == 29
    with pytest.raises(lastfm.LastfmError) as e:
        cl.user_info("nobody")
    assert e.value.code == 6
    assert "cb=https%3A%2F%2Fx%2Fcb" in cl.auth_url("https://x/cb")


# ---------------- hidden without a key ----------------
def test_hidden_without_key():
    assert A.lfm is None
    c = TestClient(A.app)
    T.sign_in(c, "nokey@example.com")
    assert c.get("/tunesummary/api/config").json()["lastfm"] is False
    assert c.get("/tunesummary/api/me").json()["lastfm"] is None
    assert c.get("/tunesummary/api/lastfm").status_code == 404
    assert c.post("/tunesummary/api/lastfm/link", json={"username": "alice"}).status_code == 404


# ---------------- sync + dedupe ----------------
def test_sync_respects_export_and_estimates_length(fake):
    c = TestClient(A.app)
    T.sign_in(c, "lfm1@example.com")
    uid = user_id("lfm1@example.com")
    now = int(time.time())
    end = (now - 10 * DAY) * 1000                 # the export's last play ends 10 days ago
    upload(c, [(end - 3600000, 241000, "Known", "Artist A"), (end, 100000, "Other", "Artist B")])
    fake.scrobbles = [(now - 20 * DAY, "Artist A", "Known", "LP"),     # inside the export window: ignored
                      (now - 10 * DAY - 30, "Artist B", "Other", "LP"),  # started before the export's end: ignored
                      (now - 9 * DAY, "Artist A", "Known", "LP"),      # length from the export (241 s)
                      (now - 8 * DAY, "Artist C", "Looked up", "LP"),  # length from track.getInfo
                      (now - 7 * DAY, "Artist D", "Unknown", "LP")]    # no length anywhere: 3.5 min
    fake.durations = {("Artist C", "Looked up"): 185000, ("Artist D", "Unknown"): 0}
    r = c.post("/tunesummary/api/lastfm/link", json={"username": "ALICE"})
    assert r.status_code == 200, r.text
    assert r.json()["user"] == "alice" and r.json()["state"] == "queued"
    A.live.step()
    rows = A.db.q("SELECT ts, ms, track FROM plays WHERE user_id=? AND source='lastfm' ORDER BY ts", (uid,))
    assert [(x["track"], x["ms"]) for x in rows] == [("Known", 241000), ("Looked up", 185000), ("Unknown", lastfm.DEFAULT_MS)]
    assert rows[0]["ts"] == (now - 9 * DAY) * 1000 + 241000   # stored as the END of the play, like exports
    st = c.get("/tunesummary/api/lastfm").json()
    assert st["state"] == "ok" and st["plays"] == 3 and st["added"] == 3 and st["synced_at"]
    # the track length cache is shared and remembered
    assert A.db.one("SELECT ms FROM track_lengths WHERE k=?", ("artist c\u0001looked up",))["ms"] == 185000
    # a second sync only asks for newer scrobbles and adds nothing twice
    fake.scrobbles.append((now - DAY, "Artist A", "Known", "LP"))
    A.queue_sync(uid)
    A.live.step()
    assert A.db.one("SELECT COUNT(*) n FROM plays WHERE user_id=? AND source='lastfm'", (uid,))["n"] == 4
    recent = [x for x in fake.calls if x["method"] == "user.getRecentTracks"][-1]
    assert int(recent["from"]) == now - 7 * DAY + 1
    # the dashboard data marks them (flag 8) and has no skip info
    d = c.get("/tunesummary/api/plays").json()
    assert sum(1 for x in d["rows"] if x[6] & 8) == 4 and all(not (x[6] & 4) for x in d["rows"] if x[6] & 8)
    # a newer export wins for its whole window: scrobbles that started inside it go
    upload(c, [((now - 5 * DAY) * 1000, 200000, "Fresh", "Artist E")])
    left = A.db.q("SELECT track FROM plays WHERE user_id=? AND source='lastfm'", (uid,))
    assert [x["track"] for x in left] == ["Known"]                # only the one from yesterday
    # the export download says where a play came from
    ex = c.get("/tunesummary/api/export").json()["plays"]
    assert sum(1 for p in ex if p.get("tunesummary_source") == "lastfm") == 1
    # unlink deletes the scrobbles (default)
    assert c.post("/tunesummary/api/lastfm/unlink", json={}).json()["deleted_plays"] == 1
    assert c.get("/tunesummary/api/lastfm").json() == {"linked": False, "gate": "off"}


def test_first_sync_without_export_is_capped_and_paged(fake, monkeypatch):
    c = TestClient(A.app)
    T.sign_in(c, "lfm2@example.com")
    uid = user_id("lfm2@example.com")
    now = int(time.time())
    fake.scrobbles = [(now - 400 * DAY, "Old", "Too old", "")] + [(now - i * 3600, "A", "T%d" % (i % 9), "") for i in range(1, 451)]
    fake.durations = {("A", "T%d" % i): 200000 for i in range(9)}
    monkeypatch.setattr(lastfm.sync_user, "__defaults__", (None, 2))
    assert c.post("/tunesummary/api/lastfm/link", json={"username": "alice"}).status_code == 200
    A.live.step()                                   # 450 scrobbles = 3 pages (50 + 200 + 200); the oldest 2 pages first
    n1 = A.db.one("SELECT COUNT(*) n FROM plays WHERE user_id=? AND source='lastfm'", (uid,))["n"]
    assert n1 == 250 and c.get("/tunesummary/api/lastfm").json()["state"] == "queued"
    A.live.step()                                   # then the rest
    n2 = A.db.one("SELECT COUNT(*) n, MIN(ts) lo FROM plays WHERE user_id=? AND source='lastfm'", (uid,))
    assert n2["n"] == 450 and n2["lo"] > (now - 366 * DAY) * 1000
    assert c.get("/tunesummary/api/lastfm").json()["state"] == "ok"


def test_private_profile_and_unknown_user(fake):
    c = TestClient(A.app)
    T.sign_in(c, "lfm3@example.com")
    assert c.post("/tunesummary/api/lastfm/link", json={"username": "nobody"}).status_code == 404
    assert c.post("/tunesummary/api/lastfm/link", json={"username": "x y"}).status_code == 400
    assert c.post("/tunesummary/api/lastfm/link", json={"username": "alice"}).status_code == 200
    fake.fail["user.getRecentTracks"] = [17]
    A.live.step()
    st = c.get("/tunesummary/api/lastfm").json()
    assert st["state"] == "error" and "private" in st["error"]
    # errors don't make the user wait for the manual cooldown
    assert c.post("/tunesummary/api/lastfm/refresh").json()["state"] == "queued"


def test_web_auth_callback(fake, monkeypatch):
    monkeypatch.setattr(A, "LASTFM_SECRET", "s3cret")
    fake_client = A.lfm
    fake_client.secret = "s3cret"
    c = TestClient(A.app)
    T.sign_in(c, "lfm4@example.com")
    assert c.post("/tunesummary/api/lastfm/link", json={"username": "alice"}).status_code == 400  # must use web auth
    r = c.get("/tunesummary/auth/lastfm", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"].startswith("https://www.last.fm/api/auth/?api_key=testkey")
    state = c.cookies.get("ts_lstate")
    bad = c.get("/tunesummary/auth/lastfm/callback", params={"s": "wrong", "token": "abcdefgh12"}, follow_redirects=False)
    assert bad.headers["location"].endswith("/app?lastfm=failed")
    ok = c.get("/tunesummary/auth/lastfm/callback", params={"s": state, "token": "abcdefgh12"}, follow_redirects=False)
    assert ok.headers["location"].endswith("/app?lastfm=linked")
    st = c.get("/tunesummary/api/lastfm").json()
    assert st["user"] == "alice" and st["verified"] is True


# ---------------- refresh gates ----------------
def test_gate_off_button_and_cooldown(fake):
    c = TestClient(A.app)
    T.sign_in(c, "g1@example.com")
    c.post("/tunesummary/api/lastfm/link", json={"username": "alice"})
    A.live.step()
    assert c.post("/tunesummary/api/lastfm/refresh").status_code == 429   # just synced (link counts)
    A.db.x("UPDATE users SET lastfm_tried_at=? WHERE id=?", (time.time() - 3600, user_id("g1@example.com")))
    r = c.post("/tunesummary/api/lastfm/refresh")
    assert r.status_code == 200 and r.json()["state"] == "queued"
    assert c.post("/tunesummary/api/lastfm/refresh/ad/start").status_code == 400   # no ads when the gate is off
    # background: everyone linked is due once a day
    A.live.step()
    uid = user_id("g1@example.com")
    assert uid not in A.live_due(time.time())
    assert uid in A.live_due(time.time() + 25 * 3600)


def test_gate_ad(fake, monkeypatch):
    monkeypatch.setattr(A, "LIVE_GATE", "ad")
    monkeypatch.setattr(A, "LIVE_AD_SECONDS", 15)
    c = TestClient(A.app)
    T.sign_in(c, "g2@example.com")
    uid = user_id("g2@example.com")
    c.post("/tunesummary/api/lastfm/link", json={"username": "alice"})   # first sync is free
    A.live.step()
    st = c.get("/tunesummary/api/lastfm").json()
    assert st["mode"] == "ad" and st["next_at"] is None and st["auto_hours"] is None
    assert c.post("/tunesummary/api/lastfm/refresh").status_code == 402
    s = c.post("/tunesummary/api/lastfm/refresh/ad/start").json()
    assert s["seconds"] == 15
    assert c.post("/tunesummary/api/lastfm/refresh/ad/finish", json={"nonce": s["nonce"]}).status_code == 400  # too early
    assert c.post("/tunesummary/api/lastfm/refresh/ad/finish", json={"nonce": "f" * 32}).status_code == 400
    A.db.x("UPDATE live_refreshes SET started_at=started_at-20")
    r = c.post("/tunesummary/api/lastfm/refresh/ad/finish", json={"nonce": s["nonce"]})
    assert r.status_code == 200 and r.json()["state"] == "queued" and r.json()["next_at"]
    assert c.post("/tunesummary/api/lastfm/refresh/ad/start").status_code == 429   # one ad refresh per few hours
    # someone else's nonce doesn't work
    c2 = TestClient(A.app)
    T.sign_in(c2, "g2b@example.com")
    assert c2.post("/tunesummary/api/lastfm/refresh/ad/finish", json={"nonce": s["nonce"]}).status_code == 400
    # free users get no background syncs; supporters do, and skip the ad
    A.live.step()
    assert uid not in A.live_due(time.time() + 99 * 3600)
    A.db.x("UPDATE users SET plan='supporter', lastfm_tried_at=0 WHERE id=?", (uid,))
    assert c.get("/tunesummary/api/lastfm").json()["mode"] == "sync"
    assert c.post("/tunesummary/api/lastfm/refresh").json()["state"] == "queued"
    A.live.step()
    assert uid in A.live_due(time.time() + 5 * 3600) and uid not in A.live_due(time.time() + 3 * 3600)


def test_gate_supporter(fake, monkeypatch):
    monkeypatch.setattr(A, "LIVE_GATE", "supporter")
    c = TestClient(A.app)
    T.sign_in(c, "g3@example.com")
    uid = user_id("g3@example.com")
    c.post("/tunesummary/api/lastfm/link", json={"username": "alice"})
    A.live.step()
    assert c.get("/tunesummary/api/lastfm").json()["mode"] == "supporter"
    assert c.post("/tunesummary/api/lastfm/refresh").status_code == 402
    assert c.post("/tunesummary/api/lastfm/refresh/ad/start").status_code == 400
    assert uid not in A.live_due(time.time() + 99 * 3600)
    A.db.x("UPDATE users SET plan='supporter', lastfm_tried_at=0 WHERE id=?", (uid,))
    assert c.post("/tunesummary/api/lastfm/refresh").status_code == 200
    A.live.step()
    assert uid in A.live_due(time.time() + 5 * 3600)


def test_delete_account_removes_lastfm(fake):
    c = TestClient(A.app)
    T.sign_in(c, "g4@example.com")
    uid = user_id("g4@example.com")
    fake.scrobbles = [(int(time.time()) - 3600, "A", "T", "")]
    c.post("/tunesummary/api/lastfm/link", json={"username": "alice"})
    A.live.step()
    assert A.db.one("SELECT COUNT(*) n FROM plays WHERE user_id=?", (uid,))["n"] == 1
    assert c.post("/tunesummary/api/delete-account", json={"confirm": "g4@example.com"}).status_code == 200
    assert A.db.one("SELECT COUNT(*) n FROM plays WHERE user_id=?", (uid,))["n"] == 0
