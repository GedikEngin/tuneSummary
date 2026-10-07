"""TuneSummary web app: email magic-link accounts, export upload, stats API, reminder emails, pages."""
import gzip
import hashlib
import html
import io
import json
import logging
import os
import re
import secrets
import threading
import time
import urllib.parse
from pathlib import Path

import httpx
import uvicorn
from fastapi import APIRouter, FastAPI, Form, HTTPException, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import emails, ingest
from .db import DB
from .genres import GenreWorker
from .mailer import CapReached, Mailer

log = logging.getLogger("tunesummary")

BASE = "/" + os.environ.get("TS_BASE_PATH", "/tunesummary").strip("/")
PUBLIC_URL = os.environ.get("TS_PUBLIC_URL", "http://127.0.0.1:8797" + BASE).rstrip("/")
DATA_DIR = Path(os.environ.get("TS_DATA_DIR", "./data"))
ORIGINS = {o.strip() for o in os.environ.get(
    "TS_ALLOWED_ORIGINS", "https://gedik.tech,https://tunesummary.gedik.tech,http://127.0.0.1:8797").split(",") if o.strip()}
GOOGLE_ID = os.environ.get("TS_GOOGLE_CLIENT_ID", "")
GOOGLE_SECRET = os.environ.get("TS_GOOGLE_CLIENT_SECRET", "")
ADS_CLIENT = os.environ.get("TS_ADSENSE_CLIENT", "")      # e.g. ca-pub-123…; empty = no ads anywhere
ADS_SLOT = os.environ.get("TS_ADSENSE_SLOT", "")
REMIND_UNIT = float(os.environ.get("TS_REMIND_UNIT_SECONDS", "86400"))  # one "day" (shorter for tests)
LINK_MINUTES = 20
SESSION_DAYS = 90
SECURE = PUBLIC_URL.startswith("https")
COOKIE = "ts_session"
WEB = Path(__file__).resolve().parent.parent / "web"
EMAIL_RE = re.compile(r"^[^@\s<>\"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$")

DATA_DIR.mkdir(parents=True, exist_ok=True)
db = DB(str(DATA_DIR / "tunesummary.db"))
mailer = Mailer(db, DATA_DIR)
genres = GenreWorker(db)

app = FastAPI(title="TuneSummary", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1500)
r = APIRouter(prefix=BASE)


def H(s):
    return hashlib.sha256(s.encode()).hexdigest()


# ---------------- security headers ----------------
def csp():
    script = "'self'"
    frame = "'none'"
    if ADS_CLIENT:  # AdSense needs its own script + frame hosts
        script += " https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://*.gstatic.com https://*.adtrafficquality.google"
        frame = "https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://*.adtrafficquality.google"
    img = "'self' data:" + (" https:" if ADS_CLIENT else "")
    connect = "'self'" + (" https:" if ADS_CLIENT else "")
    return (f"default-src 'self'; script-src {script}; style-src 'self' 'unsafe-inline'; img-src {img}; "
            f"connect-src {connect}; frame-src {frame}; font-src 'self'; form-action 'self' https://accounts.google.com; "
            "base-uri 'self'; frame-ancestors 'none'")


CSP = csp()


@app.middleware("http")
async def headers(request: Request, call_next):
    if request.method == "POST":
        origin = request.headers.get("origin")
        if origin and origin not in ORIGINS and not request.url.path.endswith("/unsubscribe"):
            return JSONResponse({"detail": "cross-site request refused"}, status_code=403)
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["X-Frame-Options"] = "DENY"
    if request.url.path.startswith(BASE + "/api/") or request.url.path.startswith(BASE + "/auth"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def client_ip(req: Request):
    # Netlify's proxy sends the visitor's address; nginx sets X-Real-IP to whoever connected to it.
    return (req.headers.get("x-nf-client-connection-ip") or req.headers.get("x-real-ip")
            or (req.client.host if req.client else "?"))


def limited(key, limit, window):
    """True if `key` already had `limit` events in the last `window` seconds; otherwise records one."""
    now = time.time()
    n = db.one("SELECT COUNT(*) n FROM rate_events WHERE k=? AND at>?", (key, now - window))["n"]
    if n >= limit:
        return True
    db.x("INSERT INTO rate_events(k, at) VALUES(?,?)", (key, now))
    return False


# ---------------- sessions ----------------
def user_of(req: Request):
    tok = req.cookies.get(COOKIE)
    if not tok:
        return None
    row = db.one("""SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                    WHERE s.token_hash=? AND s.expires_at>?""", (H(tok), time.time()))
    return row


def need_user(req: Request):
    u = user_of(req)
    if not u:
        raise HTTPException(401, "not signed in")
    return u


def start_session(resp: Response, uid):
    tok = secrets.token_hex(32)
    now = time.time()
    db.x("INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)",
         (H(tok), uid, now, now + SESSION_DAYS * 86400))
    db.x("UPDATE users SET last_login=? WHERE id=?", (now, uid))
    resp.set_cookie(COOKIE, tok, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", secure=SECURE, path=BASE)
    db.count("login")


def get_or_create_user(email, google_sub=None):
    u = db.one("SELECT * FROM users WHERE email=?", (email,))
    if u:
        if google_sub and not u["google_sub"]:
            db.x("UPDATE users SET google_sub=? WHERE id=?", (google_sub, u["id"]))
        return u["id"], False
    cur = db.x("INSERT INTO users(email, created_at, google_sub, unsub_token) VALUES(?,?,?,?)",
               (email, time.time(), google_sub, secrets.token_hex(16)))
    db.count("signup")
    return cur.lastrowid, True


def set_reminder(uid, days):
    if days:
        db.x("UPDATE users SET reminders=1, remind_stage=0, remind_at=? WHERE id=? AND last_upload IS NULL",
             (time.time() + days * REMIND_UNIT, uid))
    else:
        db.x("UPDATE users SET reminders=0, remind_at=NULL WHERE id=?", (uid,))


# ---------------- auth: email magic link ----------------
@r.post("/api/auth/request")
async def auth_request(req: Request):
    try:
        body = await req.json()
    except ValueError:
        raise HTTPException(400, "bad request")
    email = str(body.get("email", "")).strip().lower()
    remind = body.get("remind_days")
    remind = int(remind) if isinstance(remind, int) and 1 <= remind <= 30 else None
    if not EMAIL_RE.match(email) or len(email) > 254:
        raise HTTPException(400, "That doesn't look like an email address.")
    ip = client_ip(req)
    if (limited("ip15:" + ip, 10, 900) or limited("ipday:" + ip, 40, 86400)
            or limited("em15:" + H(email)[:24], 3, 900) or limited("emday:" + H(email)[:24], 8, 86400)):
        raise HTTPException(429, "Too many sign-in emails requested. Wait a few minutes and try again.")
    tok = secrets.token_hex(32)
    now = time.time()
    db.x("INSERT INTO login_tokens(token_hash, email, created_at, expires_at, remind_days) VALUES(?,?,?,?,?)",
         (H(tok), email, now, now + LINK_MINUTES * 60, remind))
    subj, text, htm = emails.login(f"{PUBLIC_URL}/auth?t={tok}", LINK_MINUTES)
    try:
        mailer.send(email, subj, text, htm, kind="login")
    except CapReached:
        raise HTTPException(503, "We've hit today's email limit. Please try again tomorrow.")
    except Exception:
        log.exception("login email failed")
        raise HTTPException(502, "Couldn't send the email. Please try again in a minute.")
    return {"sent": True}


@r.get("/auth")
def auth_page(t: str = ""):
    # Showing a button (not signing in on GET) keeps email link scanners from using up the one-time link.
    page = render("verify.html", TOKEN=t if re.fullmatch(r"[0-9a-f]{64}", t) else "")
    return HTMLResponse(page, headers={"Cache-Control": "no-store"})


@r.post("/auth/verify")
def auth_verify(t: str = Form("")):
    now = time.time()
    row = db.one("SELECT * FROM login_tokens WHERE token_hash=?", (H(t),)) if t else None
    if not row or row["used_at"] or row["expires_at"] < now:
        return RedirectResponse(BASE + "/signin?error=expired", status_code=303)
    db.x("UPDATE login_tokens SET used_at=? WHERE token_hash=?", (now, H(t)))
    uid, new = get_or_create_user(row["email"])
    if row["remind_days"]:
        set_reminder(uid, row["remind_days"])
    u = db.one("SELECT last_upload FROM users WHERE id=?", (uid,))
    resp = RedirectResponse(BASE + ("/app" if u["last_upload"] else "/app?welcome=1"), status_code=303)
    start_session(resp, uid)
    return resp


# ---------------- auth: Google (only when configured) ----------------
@r.get("/auth/google")
def google_start():
    if not (GOOGLE_ID and GOOGLE_SECRET):
        raise HTTPException(404, "Google sign-in isn't set up.")
    state = secrets.token_hex(16)
    q = urllib.parse.urlencode({"client_id": GOOGLE_ID, "redirect_uri": PUBLIC_URL + "/auth/google/callback",
                                "response_type": "code", "scope": "openid email", "state": state, "prompt": "select_account"})
    resp = RedirectResponse("https://accounts.google.com/o/oauth2/v2/auth?" + q)
    resp.set_cookie("ts_gstate", state, max_age=600, httponly=True, samesite="lax", secure=SECURE, path=BASE)
    return resp


@r.get("/auth/google/callback")
def google_callback(req: Request, code: str = "", state: str = ""):
    if not (GOOGLE_ID and GOOGLE_SECRET) or not code or state != req.cookies.get("ts_gstate"):
        return RedirectResponse(BASE + "/signin?error=google", status_code=303)
    try:
        tok = httpx.post("https://oauth2.googleapis.com/token", timeout=20, data={
            "code": code, "client_id": GOOGLE_ID, "client_secret": GOOGLE_SECRET,
            "redirect_uri": PUBLIC_URL + "/auth/google/callback", "grant_type": "authorization_code"}).json()
        info = httpx.get("https://openidconnect.googleapis.com/v1/userinfo", timeout=20,
                         headers={"Authorization": "Bearer " + tok["access_token"]}).json()
    except Exception:
        log.exception("google sign-in")
        return RedirectResponse(BASE + "/signin?error=google", status_code=303)
    if not info.get("email") or not info.get("email_verified"):
        return RedirectResponse(BASE + "/signin?error=google", status_code=303)
    uid, _ = get_or_create_user(info["email"].lower(), info.get("sub"))
    resp = RedirectResponse(BASE + "/app", status_code=303)
    resp.delete_cookie("ts_gstate", path=BASE)
    start_session(resp, uid)
    return resp


@r.post("/api/logout")
def logout(req: Request):
    tok = req.cookies.get(COOKIE)
    if tok:
        db.x("DELETE FROM sessions WHERE token_hash=?", (H(tok),))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path=BASE)
    return resp


# ---------------- api ----------------
@r.get("/api/config")
def api_config(req: Request):
    u = user_of(req)
    ads = None
    if ADS_CLIENT and not (u and u["plan"] == "supporter"):
        ads = {"client": ADS_CLIENT, "slot": ADS_SLOT}
    return {"google": bool(GOOGLE_ID and GOOGLE_SECRET), "ads": ads, "signed_in": bool(u)}


@r.get("/api/me")
def api_me(req: Request):
    u = need_user(req)
    p = db.one("SELECT COUNT(*) n, MIN(ts) first, MAX(ts) last, SUM(skipped IS NOT NULL) ext FROM plays WHERE user_id=?", (u["id"],))
    g = db.one("""SELECT COUNT(DISTINCT lower(p.artist)) total, COUNT(DISTINCT a.name_key) done FROM plays p
                  LEFT JOIN artists a ON a.name_key=lower(p.artist) WHERE p.user_id=? AND p.artist IS NOT NULL""", (u["id"],))
    return {"email": u["email"], "plan": u["plan"], "created": u["created_at"] * 1000,
            "reminders": bool(u["reminders"]), "remind_at": u["remind_at"] and u["remind_at"] * 1000,
            "plays": p["n"], "first": p["first"], "last": p["last"], "extended": bool(p["ext"]),
            "last_upload": u["last_upload"] and u["last_upload"] * 1000,
            "genres": {"done": g["done"], "total": g["total"]}}


@r.post("/api/reminders")
async def api_reminders(req: Request):
    u = need_user(req)
    body = await req.json()
    days = body.get("days") if body.get("on") else None
    if days is not None and not (isinstance(days, int) and 1 <= days <= 30):
        raise HTTPException(400, "days must be 1–30")
    set_reminder(u["id"], days)
    return {"ok": True}


@r.post("/api/upload")
async def api_upload(req: Request):
    u = need_user(req)
    if limited("up:%d" % u["id"], 400, 3600):
        raise HTTPException(429, "Too many uploads. Try again in an hour.")
    raw = await req.body()
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(413, "Batch too big.")
    try:
        if req.headers.get("x-body-encoding") == "gzip" or raw[:2] == b"\x1f\x8b":
            d = gzip.GzipFile(fileobj=io.BytesIO(raw))
            raw = d.read(80 * 1024 * 1024 + 1)
            if len(raw) > 80 * 1024 * 1024:
                raise HTTPException(413, "Batch too big.")
        rows = ingest.parse_batch(json.loads(raw), u["id"])
    except (ValueError, OSError, EOFError) as e:
        raise HTTPException(400, f"Couldn't read that data: {e}")
    if db.one("SELECT COUNT(*) n FROM plays WHERE user_id=?", (u["id"],))["n"] + len(rows) > 3_000_000:
        raise HTTPException(413, "That's more plays than we can store per account.")
    added = ingest.store(db, rows)
    return {"rows": len(rows), "added": added}


@r.post("/api/upload/done")
async def api_upload_done(req: Request):
    u = need_user(req)
    body = await req.json()
    removed = ingest.finish_upload(db, u["id"])
    db.x("INSERT INTO uploads(user_id, at, rows, added) VALUES(?,?,?,?)",
         (u["id"], time.time(), int(body.get("rows") or 0), int(body.get("added") or 0)))
    db.x("UPDATE users SET last_upload=?, remind_at=NULL WHERE id=?", (time.time(), u["id"]))
    db.count("upload")
    genres.wake.set()
    return {"ok": True, "basic_rows_replaced": removed}


@r.get("/api/plays")
def api_plays(req: Request):
    u = need_user(req)
    d = ingest.compact(db, u["id"])
    keys = {t[1].lower() for t in d["tracks"] if t[1]}
    d["genres"] = db.artist_genres(keys)
    return d


@r.get("/api/export")
def api_export(req: Request):
    u = need_user(req)
    out = {"account": {"email": u["email"], "plan": u["plan"], "created": u["created_at"],
                       "reminders": bool(u["reminders"])},
           "uploads": [dict(x) for x in db.q("SELECT at, rows, added FROM uploads WHERE user_id=?", (u["id"],))],
           "plays": ingest.export(db, u["id"])}
    return Response(json.dumps(out, ensure_ascii=False), media_type="application/json",
                    headers={"Content-Disposition": "attachment; filename=tunesummary-my-data.json"})


@r.post("/api/plays/delete")
def api_plays_delete(req: Request):
    u = need_user(req)
    n = db.x("DELETE FROM plays WHERE user_id=?", (u["id"],)).rowcount
    db.x("DELETE FROM uploads WHERE user_id=?", (u["id"],))
    db.x("UPDATE users SET last_upload=NULL WHERE id=?", (u["id"],))
    return {"deleted_plays": n}


def delete_user(uid, email):
    def run(c):
        for sql, a in (("DELETE FROM plays WHERE user_id=?", uid), ("DELETE FROM uploads WHERE user_id=?", uid),
                       ("DELETE FROM sessions WHERE user_id=?", uid), ("DELETE FROM login_tokens WHERE email=?", email),
                       ("DELETE FROM rate_events WHERE k IN (?,?)", None), ("DELETE FROM users WHERE id=?", uid)):
            if a is None:
                c.execute(sql, ("em15:" + H(email)[:24], "emday:" + H(email)[:24]))
            else:
                c.execute(sql, (a,))
    db.tx(run)
    db.count("delete_account")


@r.post("/api/delete-account")
async def api_delete_account(req: Request):
    u = need_user(req)
    body = await req.json()
    if str(body.get("confirm", "")).strip().lower() != u["email"]:
        raise HTTPException(400, "Type your email address to confirm.")
    delete_user(u["id"], u["email"])
    resp = JSONResponse({"deleted": True})
    resp.delete_cookie(COOKIE, path=BASE)
    return resp


# ---------------- unsubscribe (works without signing in) ----------------
@r.get("/unsubscribe")
def unsub_page(u: str = ""):
    page = render("unsubscribe.html", U=u if re.fullmatch(r"[0-9a-f]{32}", u) else "")
    return HTMLResponse(page, headers={"Cache-Control": "no-store"})


@r.post("/unsubscribe")
async def unsub(req: Request, u: str = ""):
    if not u:
        form = await req.form()
        u = str(form.get("u", ""))
    n = db.x("UPDATE users SET reminders=0, remind_at=NULL WHERE unsub_token=?", (u,)).rowcount if u else 0
    if req.headers.get("accept", "").startswith("text/html") or "form" in req.headers.get("content-type", ""):
        return RedirectResponse(BASE + "/unsubscribe?done=1" + ("" if n else "&missing=1"), status_code=303)
    return {"ok": True}


# ---------------- reminders ----------------
def send_due_reminders(now=None):
    now = now or time.time()
    sent = 0
    for u in db.q("""SELECT * FROM users WHERE reminders=1 AND remind_at IS NOT NULL AND remind_at<=?
                     AND last_upload IS NULL ORDER BY remind_at LIMIT 50""", (now,)):
        second = u["remind_stage"] >= 1
        unsub = f"{PUBLIC_URL}/unsubscribe?u={u['unsub_token']}"
        subj, text, htm = emails.reminder(f"{PUBLIC_URL}/app", f"{PUBLIC_URL}/guide", unsub, second)
        try:
            mailer.send(u["email"], subj, text, htm, kind="reminder", headers={
                "List-Unsubscribe": f"<{unsub}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"})
        except CapReached:
            break
        except Exception:
            log.exception("reminder email failed; retrying in an hour")
            db.x("UPDATE users SET remind_at=? WHERE id=?", (now + 3600, u["id"]))
            continue
        nxt = None if second else now + 7 * REMIND_UNIT
        db.x("UPDATE users SET remind_stage=remind_stage+1, remind_at=? WHERE id=?", (nxt, u["id"]))
        sent += 1
    return sent


def housekeeping():
    now = time.time()
    db.x("DELETE FROM login_tokens WHERE expires_at<?", (now - 86400,))
    db.x("DELETE FROM sessions WHERE expires_at<?", (now,))
    db.x("DELETE FROM rate_events WHERE at<?", (now - 2 * 86400,))
    db.x("DELETE FROM email_log WHERE at<?", (now - 30 * 86400,))


def scheduler():
    while True:
        try:
            send_due_reminders()
            housekeeping()
        except Exception:
            log.exception("scheduler")
        time.sleep(float(os.environ.get("TS_SCHEDULER_SECONDS", "60")))


@app.on_event("startup")
def _start():
    if os.environ.get("TS_WORKERS", "1") == "1":
        threading.Thread(target=scheduler, daemon=True, name="scheduler").start()
        genres.start()


# ---------------- pages ----------------
PAGES = {"": "index.html", "guide": "guide.html", "signin": "signin.html", "app": "app.html", "account": "account.html",
         "privacy": "privacy.html", "terms": "terms.html"}


def render(fn, **subs):
    # <base href> keeps relative links right even when a proxy serves a page without the trailing slash.
    text = (WEB / fn).read_text().replace("{{BASE}}", BASE)
    for k, v in subs.items():
        text = text.replace("{{%s}}" % k, html.escape(v))
    return text


def page(name):
    def view(req: Request):
        db.count("view:" + (name or "home"))
        return HTMLResponse(render(PAGES[name]), headers={"Cache-Control": "no-cache"})
    return view


for _name in PAGES:
    r.add_api_route("/" + _name, page(_name), methods=["GET"], include_in_schema=False)


@r.get("/healthz")
def healthz():
    db.one("SELECT 1")
    return {"ok": True}


app.include_router(r)
app.mount(BASE + "/static", StaticFiles(directory=WEB / "static"), name="static")


@app.get(BASE)
def _slash():
    return RedirectResponse(BASE + "/", status_code=301)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    uvicorn.run(app, host=os.environ.get("TS_HOST", "127.0.0.1"), port=int(os.environ.get("TS_PORT", "8797")),
                proxy_headers=True, forwarded_allow_ips="127.0.0.1", log_level="warning")


if __name__ == "__main__":
    main()
