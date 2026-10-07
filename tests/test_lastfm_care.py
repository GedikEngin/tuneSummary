"""Last.fm connection health: stale detection, dashboard status, reconnect + "expires soon" emails. Time and mail are faked."""
import time

import pytest

import test_app as T  # sets the env + temp data dir before the app is imported
from test_lastfm import fake, user_id  # noqa: F401  (pytest fixture)
from fastapi.testclient import TestClient

from tunesummary import app as A
from tunesummary import lastfm_care as C
from tunesummary.mailer import CapReached

DAY = 86400
URL = "http://testserver/tunesummary"


class FakeMailer:
    def __init__(self, cap=99, fail=False):
        self.sent, self.cap, self.fail = [], cap, fail

    def send(self, to, subject, text, html=None, kind="other", headers=None):
        if len(self.sent) >= self.cap:
            raise CapReached()
        if self.fail:
            raise OSError("smtp down")
        self.sent.append({"to": to, "subject": subject, "text": text, "html": html, "kind": kind, "headers": headers})


@pytest.fixture(autouse=True)
def clean():
    C._retry.clear()
    A.db.x("UPDATE users SET lastfm_user=NULL")  # other tests' linked users stay out of the way
    yield


def linked(email, linked_at, newest=None, synced=True):
    c = TestClient(A.app)
    T.sign_in(c, email)
    uid = user_id(email)
    A.db.x("""UPDATE users SET lastfm_user='alice', lastfm_linked_at=?, lastfm_newest=?, lastfm_synced_at=?, lastfm_state='ok',
              lastfm_stale_at=NULL, lastfm_stale_why=NULL, lastfm_stale_mails=0, lastfm_stale_mailed_at=NULL,
              lastfm_headsup_due=?, lastfm_headsup_sent_at=NULL, lastfm_reminders=1 WHERE id=?""",
           (linked_at, newest, linked_at + 60 if synced else None, linked_at + C.HEADSUP_FIRST_DAYS * DAY, uid))
    return c, uid


def row(uid):
    return A.db.one("SELECT * FROM users WHERE id=?", (uid,))


# ---------------- stale detection ----------------
def test_stale_reason_rules():
    now = 1_800_000_000
    base = {"lastfm_user": "alice", "lastfm_newest": None, "lastfm_linked_at": now - DAY, "lastfm_synced_at": now - DAY}
    assert C.stale_reason({**base, "lastfm_user": None}, now) is None
    assert C.stale_reason({**base, "lastfm_newest": now - 6 * DAY}, now) is None
    assert C.stale_reason({**base, "lastfm_newest": now - 8 * DAY}, now) == "quiet"
    assert C.stale_reason(base, now) is None                                   # linked a day ago, nothing yet: wait
    assert C.stale_reason({**base, "lastfm_linked_at": now - 4 * DAY}, now) == "never"
    assert C.stale_reason({**base, "lastfm_linked_at": now - 4 * DAY, "lastfm_synced_at": None}, now) is None  # never synced


def test_goes_stale_banner_dismiss_and_recovers():
    now = time.time()
    c, uid = linked("care1@example.com", now - 30 * DAY, newest=now - 3 * DAY)
    assert C.update_health(A.db, now) == ([], [])
    went, _ = C.update_health(A.db, now + 5 * DAY)                            # newest is now 8 days old
    assert went == [uid]
    u = row(uid)
    assert u["lastfm_stale_why"] == "quiet" and u["lastfm_stale_at"] == pytest.approx(now + 5 * DAY)
    assert C.update_health(A.db, now + 6 * DAY) == ([], [])                   # stays stale, stale_at unchanged
    assert row(uid)["lastfm_stale_at"] == u["lastfm_stale_at"]
    st = C.status(row(uid), now + 5 * DAY)
    assert st["why"] == "quiet" and st["days"] == 8 and not st["dismissed"] and "last.fm/settings/applications" in st["settings"]
    # dismiss via the API (needs Last.fm on)
    A.lfm, old = object(), A.lfm
    try:
        r = c.post("/tunesummary/api/lastfm/stale/dismiss")
        assert r.status_code == 200 and r.json()["stale"]["dismissed"] is True
    finally:
        A.lfm = old
    # a new scrobble arrives → recovered, clock restarts
    A.db.x("UPDATE users SET lastfm_newest=? WHERE id=?", (now + 9 * DAY, uid))
    _, back = C.update_health(A.db, now + 9 * DAY + 60)
    assert back == [uid]
    u = row(uid)
    assert u["lastfm_stale_at"] is None and u["lastfm_reconnected_at"] == pytest.approx(now + 9 * DAY + 60)
    assert u["lastfm_headsup_due"] == pytest.approx(now + 9 * DAY + 60 + C.HEADSUP_NEXT_DAYS * DAY)
    assert C.status(u) is None


def test_never_scrobbled():
    now = time.time()
    _, uid = linked("care2@example.com", now)
    assert C.update_health(A.db, now + 2 * DAY)[0] == []
    assert C.update_health(A.db, now + 3 * DAY + 1)[0] == [uid]
    assert row(uid)["lastfm_stale_why"] == "never"


def test_sync_records_newest_and_finds_older_scrobbles(fake):  # noqa: F811
    c = TestClient(A.app)
    T.sign_in(c, "care3@example.com")
    uid = user_id("care3@example.com")
    now = int(time.time())
    fake.scrobbles = [(now - 400 * DAY, "Old", "Song", "LP")]               # older than the first-sync window
    r = c.post("/tunesummary/api/lastfm/link", json={"username": "alice"})
    assert r.status_code == 200
    A.live.step()
    u = row(uid)
    assert u["lastfm_newest"] == now - 400 * DAY and u["lastfm_headsup_due"] > now + 169 * DAY
    assert row(uid)["lastfm_stale_why"] == "quiet"                            # flagged right after the sync
    st = c.get("/tunesummary/api/lastfm").json()
    assert st["stale"]["why"] == "quiet" and st["reminders"] is True
    # Spotify reconnected: a fresh scrobble, the next sync clears the banner by itself
    fake.scrobbles.append((now - 60, "New", "Song", "LP"))
    A.queue_sync(uid)
    A.live.step()
    assert row(uid)["lastfm_stale_at"] is None and c.get("/tunesummary/api/lastfm").json()["stale"] is None


# ---------------- emails ----------------
def test_stale_emails_once_then_once_more_after_14_days():
    now = time.time()
    _, uid = linked("care4@example.com", now - 40 * DAY, newest=now - 10 * DAY)
    m = FakeMailer()
    assert C.run(A.db, m, URL, now) == 1
    e = m.sent[0]
    assert e["kind"] == "lastfm_stale" and e["to"] == "care4@example.com" and "10 days" in e["text"]
    assert "https://www.last.fm/settings/applications" in e["text"] and "Spotify Scrobbling" in e["html"]
    tok = row(uid)["unsub_token"]
    assert f"unsubscribe?u={tok}&k=lastfm" in e["text"] and e["headers"]["List-Unsubscribe"] == f"<{URL}/unsubscribe?u={tok}&k=lastfm>"
    for d in (0.1, 1, 13.9):                                                  # nothing repeats inside 14 days
        assert C.run(A.db, m, URL, now + d * DAY) == 0
    assert C.run(A.db, m, URL, now + 14 * DAY + 1) == 1 and m.sent[1]["kind"] == "lastfm_stale2"
    for d in (15, 40, 200):                                                   # and never a third
        assert C.run(A.db, m, URL, now + d * DAY) == 0
    assert row(uid)["lastfm_stale_mails"] == 2


def test_headsup_after_170_days_then_every_175():
    t0 = time.time()
    _, uid = linked("care5@example.com", t0)
    m = FakeMailer()
    for d in (1, 50, 169.9):
        A.db.x("UPDATE users SET lastfm_newest=? WHERE id=?", (t0 + d * DAY - 60, uid))  # scrobbling fine all along
        assert C.run(A.db, m, URL, t0 + d * DAY) == 0
    A.db.x("UPDATE users SET lastfm_newest=? WHERE id=?", (t0 + 170 * DAY, uid))
    assert C.run(A.db, m, URL, t0 + 170 * DAY + 60) == 1 and m.sent[0]["kind"] == "lastfm_headsup"
    assert "expires soon" in m.sent[0]["subject"] and "&k=lastfm" in m.sent[0]["text"]
    A.db.x("UPDATE users SET lastfm_newest=? WHERE id=?", (t0 + 300 * DAY, uid))
    assert C.run(A.db, m, URL, t0 + 300 * DAY) == 0                          # no repeat
    A.db.x("UPDATE users SET lastfm_newest=? WHERE id=?", (t0 + 345 * DAY, uid))
    assert C.run(A.db, m, URL, t0 + 345 * DAY + 120) == 1                     # 175 days after the first heads-up
    assert len(m.sent) == 2


def test_no_headsup_while_stale_or_never_worked():
    t0 = time.time()
    _, uid = linked("care6@example.com", t0)                                 # never scrobbled
    m = FakeMailer()
    assert C.run(A.db, m, URL, t0 + 171 * DAY) == 1 and m.sent[0]["kind"] == "lastfm_stale"
    assert "no plays have reached it" in m.sent[0]["text"]
    assert C.run(A.db, m, URL, t0 + 172 * DAY) == 0


def test_opt_out_cap_and_failures():
    now = time.time()
    c, uid = linked("care7@example.com", now - 40 * DAY, newest=now - 10 * DAY)
    assert c.post("/tunesummary/api/lastfm/reminders", json={"on": False}).json() == {"ok": True, "reminders": False}
    m = FakeMailer()
    assert C.run(A.db, m, URL, now) == 0 and m.sent == []
    c.post("/tunesummary/api/lastfm/reminders", json={"on": True})
    assert C.run(A.db, FakeMailer(cap=0), URL, now) == 0                      # daily cap: nothing marked as sent
    assert row(uid)["lastfm_stale_mails"] == 0
    assert C.run(A.db, FakeMailer(fail=True), URL, now) == 0                  # send error: retry later, not every minute
    assert C.due_emails(A.db, now + 60) == []
    assert C.run(A.db, m, URL, now + C.RETRY_SECONDS + 1) == 1
    # one-click unsubscribe from a Last.fm email stops only Last.fm emails
    A.db.x("UPDATE users SET reminders=1, remind_at=? WHERE id=?", (now + DAY, uid))
    tok = row(uid)["unsub_token"]
    TestClient(A.app).post("/tunesummary/unsubscribe", params={"u": tok, "k": "lastfm"}, headers={"Origin": "null"})
    u = row(uid)
    assert u["lastfm_reminders"] == 0 and u["reminders"] == 1 and u["remind_at"]
    page = TestClient(A.app).get("/tunesummary/unsubscribe", params={"u": tok, "k": "lastfm"}).text
    assert 'name="k" value="lastfm"' in page


def test_relink_resets_and_unlink_clears():
    now = time.time()
    _, uid = linked("care8@example.com", now - 40 * DAY, newest=now - 10 * DAY)
    C.run(A.db, FakeMailer(), URL, now)
    assert row(uid)["lastfm_stale_mails"] == 1
    C.on_link(A.db, uid, now, same_profile=False)
    u = row(uid)
    assert u["lastfm_stale_at"] is None and u["lastfm_stale_mails"] == 0 and u["lastfm_newest"] is None
    assert u["lastfm_headsup_due"] == pytest.approx(now + 170 * DAY)
