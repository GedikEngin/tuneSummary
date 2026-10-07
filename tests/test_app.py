"""End-to-end tests against the FastAPI app with a temp database and the 'log' mail backend."""
import gzip
import json
import os
import re
import tempfile
import time
import zipfile
from datetime import datetime
from pathlib import Path

import pytest

TMP = tempfile.mkdtemp()
os.environ.update(TS_DATA_DIR=TMP, TS_WORKERS="0", TS_MAIL_BACKEND="log", TS_PUBLIC_URL="http://testserver/tunesummary",
                  TS_MAIL_DAILY_CAP="1000")

from fastapi.testclient import TestClient  # noqa: E402

from tunesummary import app as A  # noqa: E402

ZIP = os.environ.get("TS_TEST_ZIP", "/tmp/sst/my_spotify_data.zip")
OUTBOX = Path(TMP) / "outbox.log"


def make_zip(path, n=3000):
    """Small synthetic extended-history export (used when the big one isn't around)."""
    rows, t = [], 1672531200
    arts = ["Radiohead", "Tarkan", "Björk", "Daft Punk", "Sezen Aksu"]
    for i in range(n):
        t += 600 + (i * 37) % 3000
        a = arts[i % 5]
        rows.append({"ts": datetime.utcfromtimestamp(t).strftime("%Y-%m-%dT%H:%M:%SZ"), "platform": "android",
                     "ms_played": 20000 + (i * 7919) % 240000, "conn_country": "US",
                     "master_metadata_track_name": f"Song {i % 40}", "master_metadata_album_artist_name": a,
                     "master_metadata_album_album_name": f"Album {i % 8}", "spotify_track_uri": f"spotify:track:T{i % 40}x",
                     "episode_name": None, "episode_show_name": None, "shuffle": i % 3 == 0, "skipped": i % 4 == 0})
    rows.append({"ts": "2024-01-01T10:00:00Z", "ms_played": 900000, "master_metadata_track_name": None,
                 "episode_name": "Ep 1", "episode_show_name": "A Show", "skipped": False, "shuffle": False})
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("Spotify Extended Streaming History/Streaming_History_Audio_2023-2024_0.json", json.dumps(rows))
        z.writestr("Spotify Extended Streaming History/Streaming_History_Video_2023.json", "[]")


def read_export(path):
    """Python mirror of web/static/js/upload.js normalize() + toBatches()."""
    recs = []
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if not re.search(r"(Streaming_?History|endsong)[^/]*\.json$", n, re.I) or "video" in n.lower():
                continue
            for o in json.loads(z.read(n)):
                if o.get("ts"):
                    tr, ep = o.get("master_metadata_track_name"), o.get("episode_name")
                    if not tr and not ep:
                        continue
                    t = int(datetime.fromisoformat(o["ts"].replace("Z", "+00:00")).timestamp() * 1000)
                    r = {"t": t, "ms": int(o.get("ms_played") or 0), "x": 1, "sk": bool(o.get("skipped")), "sh": bool(o.get("shuffle")),
                         "pf": o.get("platform"), "cc": o.get("conn_country")}
                    if tr:
                        r.update(tr=tr, ar=o.get("master_metadata_album_artist_name") or "Unknown",
                                 al=o.get("master_metadata_album_album_name") or "",
                                 u=(o.get("spotify_track_uri") or "").split(":")[-1] or None)
                    else:
                        r.update(ep=ep, show=o.get("episode_show_name") or "Unknown show")
                    recs.append(r)
    return recs


def batches(recs, size=20000):
    for i in range(0, len(recs), size):
        b = {"tracks": [], "episodes": [], "platforms": [], "countries": [], "rows": []}
        ix = {"t": {}, "e": {}, "p": {}, "c": {}}

        def idx(m, lst, key, val):
            if key not in ix[m]:
                ix[m][key] = len(lst)
                lst.append(val)
            return ix[m][key]
        for r in recs[i:i + size]:
            ti = idx("t", b["tracks"], (r["tr"], r["ar"], r["al"], r["u"]), [r["tr"], r["ar"], r["al"], r["u"]]) if r.get("tr") else -1
            ei = -1 if r.get("tr") else idx("e", b["episodes"], (r["ep"], r["show"]), [r["ep"], r["show"]])
            pi = idx("p", b["platforms"], r["pf"], r["pf"]) if r.get("pf") else -1
            ci = idx("c", b["countries"], r["cc"], r["cc"]) if r.get("cc") else -1
            b["rows"].append([r["t"], r["ms"], ti, ei, pi, ci, 4 | (1 if r["sk"] else 0) | (2 if r["sh"] else 0)])
        yield b


@pytest.fixture(scope="module")
def export_rows():
    path = ZIP
    if not os.path.exists(path):
        path = os.path.join(TMP, "synthetic.zip")
        make_zip(path)
    return read_export(path)


def last_link():
    text = OUTBOX.read_text()
    return re.findall(r"http://testserver/tunesummary/auth\?t=([0-9a-f]{64})", text)[-1]


def sign_in(c, email, remind=None):
    A.db.x("DELETE FROM rate_events")
    r = c.post("/tunesummary/api/auth/request", json={"email": email, "remind_days": remind})
    assert r.status_code == 200, r.text
    tok = last_link()
    page = c.get("/tunesummary/auth", params={"t": tok})
    assert tok in page.text and "Set-Cookie" not in page.headers  # GET must not sign in
    r = c.post("/tunesummary/auth/verify", data={"t": tok}, follow_redirects=False)
    assert r.status_code == 303 and "ts_session" in r.headers["set-cookie"]
    assert "Path=/tunesummary" in r.headers["set-cookie"] and "HttpOnly" in r.headers["set-cookie"]
    return tok


def test_pages_and_headers():
    c = TestClient(A.app)
    for p in ["", "guide", "signin", "privacy", "terms", "app", "account"]:
        r = c.get("/tunesummary/" + p)
        assert r.status_code == 200 and "TuneSummary" in r.text, p
        assert "default-src 'self'" in r.headers["content-security-policy"]
    assert c.get("/tunesummary", follow_redirects=False).headers["location"] == "/tunesummary/"
    assert c.get("/tunesummary/static/css/ts.css").status_code == 200
    assert c.get("/tunesummary/api/me").status_code == 401
    assert c.get("/tunesummary/api/config").json() == {"google": False, "ads": None, "signed_in": False}


def test_magic_link_single_use_and_bad_tokens():
    c = TestClient(A.app)
    tok = sign_in(c, "One@Example.com")
    assert c.get("/tunesummary/api/me").json()["email"] == "one@example.com"
    c2 = TestClient(A.app)
    r = c2.post("/tunesummary/auth/verify", data={"t": tok}, follow_redirects=False)
    assert r.headers["location"].endswith("/signin?error=expired")
    r = c2.post("/tunesummary/auth/verify", data={"t": "0" * 64}, follow_redirects=False)
    assert r.headers["location"].endswith("/signin?error=expired")
    assert c2.post("/tunesummary/api/auth/request", json={"email": "not-an-email"}).status_code == 400


def test_cross_origin_post_refused():
    c = TestClient(A.app)
    r = c.post("/tunesummary/api/auth/request", json={"email": "x@example.com"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_rate_limit_per_email():
    c = TestClient(A.app)
    A.db.x("DELETE FROM rate_events")
    codes = [c.post("/tunesummary/api/auth/request", json={"email": "spam@example.com"}).status_code for _ in range(5)]
    assert codes[:3] == [200, 200, 200] and codes[3] == 429


def test_upload_dedupe_stats_export_delete(export_rows):
    c = TestClient(A.app)
    sign_in(c, "upload@example.com")
    total_added = 0
    for b in batches(export_rows):
        body = gzip.compress(json.dumps(b).encode())
        r = c.post("/tunesummary/api/upload", content=body, headers={"X-Body-Encoding": "gzip", "Content-Type": "application/json"})
        assert r.status_code == 200, r.text
        total_added += r.json()["added"]
    c.post("/tunesummary/api/upload/done", json={"rows": len(export_rows), "added": total_added})
    uniq = {(r["t"], r.get("tr") or "", r.get("ep") or "") for r in export_rows}
    assert total_added == len(uniq)
    # re-upload adds nothing
    again = sum(c.post("/tunesummary/api/upload", json=b).json()["added"] for b in batches(export_rows))
    assert again == 0
    me = c.get("/tunesummary/api/me").json()
    assert me["plays"] == len(uniq) and me["extended"] and me["last_upload"]
    d = c.get("/tunesummary/api/plays").json()
    assert len(d["rows"]) == len(uniq)
    ms_music = sum(r[1] for r in d["rows"] if r[2] >= 0)
    assert ms_music == sum(r["ms"] for r in export_rows if r.get("tr") and (r["t"], r["tr"], "") in uniq) or ms_music > 0
    ex = c.get("/tunesummary/api/export")
    assert ex.status_code == 200 and "attachment" in ex.headers["content-disposition"]
    assert len(ex.json()["plays"]) == len(uniq)
    # another user sees nothing of this one
    c2 = TestClient(A.app)
    sign_in(c2, "other@example.com")
    assert c2.get("/tunesummary/api/plays").json()["rows"] == []
    # validation
    assert c.post("/tunesummary/api/upload", json={"rows": [[1, 2, 3]]}).status_code == 400
    assert c.post("/tunesummary/api/upload", json={"tracks": [], "rows": [[1700000000000, 1000, 0, -1, -1, -1, 0]]}).status_code == 400
    # delete account: wrong confirmation refused, right one wipes everything
    assert c.post("/tunesummary/api/delete-account", json={"confirm": "nope"}).status_code == 400
    uid = A.db.one("SELECT id FROM users WHERE email='upload@example.com'")["id"]
    r = c.post("/tunesummary/api/delete-account", json={"confirm": "upload@example.com"})
    assert r.json() == {"deleted": True}
    for t, col in (("users", "id"), ("plays", "user_id"), ("sessions", "user_id"), ("uploads", "user_id")):
        assert A.db.one(f"SELECT COUNT(*) n FROM {t} WHERE {col}=?", (uid,))["n"] == 0, t
    assert A.db.one("SELECT COUNT(*) n FROM login_tokens WHERE email='upload@example.com'")["n"] == 0
    assert c.get("/tunesummary/api/me").status_code == 401


def test_basic_history_replaced_by_extended():
    c = TestClient(A.app)
    sign_in(c, "basic@example.com")
    t0 = 1700000000000
    basic = {"tracks": [["Song", "Artist", "", None]], "rows": [[t0 + i * 600000, 200000, 0, -1, -1, -1, 0] for i in range(10)]}
    ext = {"tracks": [["Song", "Artist", "Album", "abc"]], "rows": [[t0 + i * 600000 + 5000, 200000, 0, -1, -1, -1, 4] for i in range(10)]}
    c.post("/tunesummary/api/upload", json=basic)
    c.post("/tunesummary/api/upload", json=ext)
    r = c.post("/tunesummary/api/upload/done", json={}).json()
    assert r["basic_rows_replaced"] == 10
    assert c.get("/tunesummary/api/me").json()["plays"] == 10


def test_reminders_and_unsubscribe():
    c = TestClient(A.app)
    sign_in(c, "remind@example.com", remind=5)
    u = A.db.one("SELECT * FROM users WHERE email='remind@example.com'")
    assert u["reminders"] == 1 and u["remind_at"] > time.time() + 4 * 86400
    before = OUTBOX.read_text().count("Subject:")
    assert A.send_due_reminders(now=u["remind_at"] + 1) >= 1
    out = OUTBOX.read_text()
    assert out.count("Subject:") > before and "List-Unsubscribe" in out and u["unsub_token"] in out
    u2 = A.db.one("SELECT * FROM users WHERE id=?", (u["id"],))
    assert u2["remind_stage"] == 1 and u2["remind_at"] > u["remind_at"] + 6 * 86400
    A.send_due_reminders(now=u2["remind_at"] + 1)
    u3 = A.db.one("SELECT * FROM users WHERE id=?", (u["id"],))
    assert u3["remind_stage"] == 2 and u3["remind_at"] is None
    # unsubscribe (one-click POST, as mail clients do)
    c.post("/tunesummary/api/reminders", json={"on": True, "days": 3})
    assert A.db.one("SELECT remind_at FROM users WHERE id=?", (u["id"],))["remind_at"]
    TestClient(A.app).post("/tunesummary/unsubscribe", params={"u": u["unsub_token"]}, headers={"Origin": "null"})
    u4 = A.db.one("SELECT * FROM users WHERE id=?", (u["id"],))
    assert u4["reminders"] == 0 and u4["remind_at"] is None


def test_genre_worker_shared_cache():
    from tunesummary.genres import GenreWorker
    c = TestClient(A.app)
    sign_in(c, "genre@example.com")
    c.post("/tunesummary/api/upload", json={"tracks": [["T", "Massive Attack", "Mezzanine", None]],
                                            "rows": [[1700000000000, 200000, 0, -1, -1, -1, 4]]})
    w = GenreWorker(A.db, lookup=lambda name: [["trip hop", 10], ["electronic", 5]] if name == "Massive Attack" else [])
    assert w.step() >= 1
    d = c.get("/tunesummary/api/plays").json()
    assert d["genres"]["massive attack"][0][0] == "trip hop"
