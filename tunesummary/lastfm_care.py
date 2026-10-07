"""Last.fm connection health: notice when scrobbles stop, tell the user how to fix it, and warn before it happens.

Spotify's "Spotify Scrobbling" connection on Last.fm expires after ~180 days, and then scrobbles silently stop.
We can't see that connection, only the scrobbles, so:
  * stale  = linked, had scrobbles, none newer than STALE_DAYS ("quiet"); or linked NEVER_DAYS ago and none at all ("never").
             Shown as a dashboard banner; cleared as soon as a newer scrobble shows up (= a reconnect, restarts the clock).
  * emails = one when a user turns stale, one more RENAG_DAYS later if still stale; a heads-up HEADSUP_FIRST_DAYS after
             linking (HEADSUP_NEXT_DAYS after a detected reconnect or the previous heads-up) that the connection expires soon.
All timestamps are stored on the user row so nothing repeats; users opt out with users.lastfm_reminders = 0.
"""
import logging
import time

from . import emails
from .mailer import CapReached

log = logging.getLogger("tunesummary.lastfm")
DAY = 86400
STALE_DAYS = 7
NEVER_DAYS = 3
RENAG_DAYS = 14
HEADSUP_FIRST_DAYS = 170
HEADSUP_NEXT_DAYS = 175
SETTINGS_URL = "https://www.last.fm/settings/applications"
RETRY_SECONDS = 3600
_retry = {}  # user id -> don't retry a failed send before this time (in-memory; a restart just retries sooner)


def stale_reason(u, now):
    """'quiet' | 'never' | None for one user row."""
    if not u["lastfm_user"]:
        return None
    if u["lastfm_newest"]:
        return "quiet" if now - u["lastfm_newest"] > STALE_DAYS * DAY else None
    if u["lastfm_synced_at"] is None:  # not synced yet: we don't know
        return None
    return "never" if u["lastfm_linked_at"] and now - u["lastfm_linked_at"] > NEVER_DAYS * DAY else None


def on_link(db, uid, now, same_profile):
    """Linking (again) starts a fresh connection clock and clears any stale state."""
    db.x(f"""UPDATE users SET lastfm_stale_at=NULL, lastfm_stale_why=NULL, lastfm_stale_dismissed=NULL, lastfm_stale_mails=0,
             lastfm_stale_mailed_at=NULL, lastfm_headsup_due=?, lastfm_reconnected_at=NULL
             {'' if same_profile else ', lastfm_newest=NULL'} WHERE id=?""", (now + HEADSUP_FIRST_DAYS * DAY, uid))


def update_health(db, now=None):
    """Re-evaluate every linked user. Returns (newly stale ids, recovered ids)."""
    now = now or time.time()
    went, back = [], []
    for u in db.q("""SELECT id, lastfm_user, lastfm_newest, lastfm_linked_at, lastfm_synced_at, lastfm_stale_at, lastfm_stale_why
                     FROM users WHERE lastfm_user IS NOT NULL"""):
        why = stale_reason(u, now)
        if why and not u["lastfm_stale_at"]:
            db.x("""UPDATE users SET lastfm_stale_at=?, lastfm_stale_why=?, lastfm_stale_dismissed=NULL, lastfm_stale_mails=0,
                    lastfm_stale_mailed_at=NULL WHERE id=?""", (now, why, u["id"]))
            went.append(u["id"])
        elif why and why != u["lastfm_stale_why"]:
            db.x("UPDATE users SET lastfm_stale_why=? WHERE id=?", (why, u["id"]))
        elif not why and u["lastfm_stale_at"]:
            # New scrobbles after a quiet spell: most likely a (re)connect, so the ~180-day clock restarts now.
            db.x("""UPDATE users SET lastfm_stale_at=NULL, lastfm_stale_why=NULL, lastfm_stale_dismissed=NULL, lastfm_stale_mails=0,
                    lastfm_stale_mailed_at=NULL, lastfm_reconnected_at=?, lastfm_headsup_due=? WHERE id=?""",
                 (now, now + HEADSUP_NEXT_DAYS * DAY, u["id"]))
            back.append(u["id"])
    return went, back


def due_emails(db, now):
    """[(kind, user row)] where kind is 'stale' | 'stale2' | 'headsup'."""
    out = []
    for u in db.q("""SELECT * FROM users WHERE lastfm_user IS NOT NULL AND lastfm_reminders=1
                     AND (lastfm_stale_at IS NOT NULL OR lastfm_headsup_due<=?)""", (now,)):
        if _retry.get(u["id"], 0) > now:
            continue
        if u["lastfm_stale_at"]:
            if u["lastfm_stale_mails"] == 0:
                out.append(("stale", u))
            elif u["lastfm_stale_mails"] == 1 and now - (u["lastfm_stale_mailed_at"] or now) >= RENAG_DAYS * DAY:
                out.append(("stale2", u))
        elif u["lastfm_newest"]:  # heads-up only for a connection that has worked (else "never" covers it)
            out.append(("headsup", u))
    return out


def send_emails(db, mailer, public_url, now=None):
    """Send what's due. Returns the number sent; stops at the daily cap (the rest go next run)."""
    now = now or time.time()
    sent = 0
    for kind, u in due_emails(db, now):
        unsub = f"{public_url}/unsubscribe?u={u['unsub_token']}&k=lastfm"
        app_url = f"{public_url}/app"
        if kind == "headsup":
            subj, text, htm = emails.lastfm_headsup(SETTINGS_URL, app_url, unsub, u["lastfm_user"])
        else:
            ref = u["lastfm_newest"] if u["lastfm_stale_why"] == "quiet" else u["lastfm_linked_at"]
            days = max(1, int((now - (ref or now)) // DAY))
            subj, text, htm = emails.lastfm_stale(SETTINGS_URL, app_url, unsub, u["lastfm_user"], days,
                                                  never=u["lastfm_stale_why"] == "never", second=kind == "stale2")
        try:
            mailer.send(u["email"], subj, text, htm, kind="lastfm_" + kind, headers={
                "List-Unsubscribe": f"<{unsub}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"})
        except CapReached:
            break
        except Exception:
            log.exception("lastfm %s email failed; retrying in an hour", kind)
            _retry[u["id"]] = now + RETRY_SECONDS
            continue
        if kind == "headsup":
            db.x("UPDATE users SET lastfm_headsup_sent_at=?, lastfm_headsup_due=? WHERE id=?",
                 (now, now + HEADSUP_NEXT_DAYS * DAY, u["id"]))
        else:
            db.x("UPDATE users SET lastfm_stale_mails=lastfm_stale_mails+1, lastfm_stale_mailed_at=? WHERE id=?", (now, u["id"]))
        sent += 1
    return sent


def run(db, mailer, public_url, now=None):
    now = now or time.time()
    update_health(db, now)
    return send_emails(db, mailer, public_url, now)


def status(u, now=None):
    """The stale part of /api/lastfm (None when healthy)."""
    if not u["lastfm_stale_at"]:
        return None
    now = now or time.time()
    ref = u["lastfm_newest"] if u["lastfm_stale_why"] == "quiet" else u["lastfm_linked_at"]
    return {"since": u["lastfm_stale_at"] * 1000, "why": u["lastfm_stale_why"],
            "newest": u["lastfm_newest"] and u["lastfm_newest"] * 1000,
            "days": int((now - (ref or now)) // DAY), "dismissed": u["lastfm_stale_dismissed"] == u["lastfm_stale_at"],
            "settings": SETTINGS_URL}
