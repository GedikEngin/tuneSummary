"""SQLite storage: one file, WAL mode, shared by web requests and the background workers."""
import json
import sqlite3
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,            -- lower-case
    created_at REAL NOT NULL,
    last_login REAL,
    plan TEXT NOT NULL DEFAULT 'free',     -- 'free' | 'supporter' (no billing yet)
    google_sub TEXT UNIQUE,
    reminders INTEGER NOT NULL DEFAULT 0,  -- opted in to "your export should be ready" emails
    remind_at REAL,                        -- next reminder due (unix s), NULL = none
    remind_stage INTEGER NOT NULL DEFAULT 0,
    unsub_token TEXT UNIQUE,
    last_upload REAL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_tokens (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    used_at REAL,
    remind_days INTEGER                    -- reminder choice made before signing in, applied on verify
);
CREATE TABLE IF NOT EXISTS rate_events (k TEXT NOT NULL, at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS rate_k ON rate_events(k, at);
CREATE TABLE IF NOT EXISTS email_log (at REAL NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL);
-- One row per play. ts = end of the play (ms since epoch, UTC), like Spotify's export.
CREATE TABLE IF NOT EXISTS plays (
    user_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    ms INTEGER NOT NULL,
    track TEXT, artist TEXT, album TEXT, track_id TEXT,
    episode TEXT, show TEXT,
    skipped INTEGER, shuffle INTEGER,      -- NULL when the export doesn't say (basic history)
    platform TEXT, country TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS plays_dedupe ON plays(user_id, ts, COALESCE(track, ''), COALESCE(episode, ''));
CREATE TABLE IF NOT EXISTS uploads (user_id INTEGER NOT NULL, at REAL NOT NULL, rows INTEGER, added INTEGER);
-- Genre cache, shared by all users (artist names are public facts, not personal data).
CREATE TABLE IF NOT EXISTS artists (
    name_key TEXT PRIMARY KEY,
    name TEXT,
    genres TEXT,                           -- JSON [[genre, weight], ...]
    image TEXT,                            -- hook for artwork (phase 2)
    checked_at REAL
);
-- Rewarded-ad views for the recap ("ad" gate): one row per started view, done_at set when it finished.
CREATE TABLE IF NOT EXISTS recap_unlocks (
    nonce_hash TEXT PRIMARY KEY,
    session_hash TEXT NOT NULL,            -- unlock lasts for this sign-in session
    user_id INTEGER NOT NULL,
    started_at REAL NOT NULL,
    done_at REAL
);
CREATE INDEX IF NOT EXISTS recap_unlocks_session ON recap_unlocks(session_hash);
-- Last.fm track lengths (shared cache, like artists): k = lower(artist) + U+0001 + lower(track), ms 0 = unknown.
CREATE TABLE IF NOT EXISTS track_lengths (k TEXT PRIMARY KEY, ms INTEGER NOT NULL, checked_at REAL);
-- Rewarded-ad views for "update my latest stats" (TS_LIVE_GATE=ad): one row per started view.
CREATE TABLE IF NOT EXISTS live_refreshes (
    nonce_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    started_at REAL NOT NULL,
    done_at REAL
);
CREATE INDEX IF NOT EXISTS live_refreshes_user ON live_refreshes(user_id, done_at);
CREATE TABLE IF NOT EXISTS counters (day TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, name));
"""


class DB:
    def __init__(self, path):
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self.migrate()

    # Columns added after launch (ALTER TABLE is a no-op if they exist).
    ADD = {"plays": [("source", "TEXT")],   # NULL = Spotify export, 'lastfm' = scrobble
           "users": [("lastfm_user", "TEXT"), ("lastfm_verified", "INTEGER NOT NULL DEFAULT 0"),
                     ("lastfm_linked_at", "REAL"), ("lastfm_cursor", "INTEGER"),  # newest imported scrobble (unix s)
                     ("lastfm_state", "TEXT"), ("lastfm_error", "TEXT"),          # queued | syncing | ok | error
                     ("lastfm_synced_at", "REAL"), ("lastfm_tried_at", "REAL"), ("lastfm_added", "INTEGER"),
                     # Connection health (see lastfm_care.py): Spotify's link to Last.fm expires after ~180 days.
                     ("lastfm_newest", "INTEGER"),                                 # newest scrobble seen on Last.fm (unix s)
                     ("lastfm_stale_at", "REAL"), ("lastfm_stale_why", "TEXT"),   # NULL = healthy; why: quiet | never
                     ("lastfm_stale_dismissed", "REAL"),                          # = stale_at when the banner was closed
                     ("lastfm_stale_mails", "INTEGER NOT NULL DEFAULT 0"), ("lastfm_stale_mailed_at", "REAL"),
                     ("lastfm_headsup_due", "REAL"), ("lastfm_headsup_sent_at", "REAL"),  # "expires soon" email
                     ("lastfm_reconnected_at", "REAL"),
                     ("lastfm_reminders", "INTEGER NOT NULL DEFAULT 1")]}         # Last.fm emails opt-out

    def migrate(self):
        for table, cols in self.ADD.items():
            have = {r["name"] for r in self.conn.execute(f"PRAGMA table_info({table})")}
            for name, decl in cols:
                if name not in have:
                    self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")

    def q(self, sql, args=()):
        with self.lock:
            return self.conn.execute(sql, args).fetchall()

    def one(self, sql, args=()):
        with self.lock:
            return self.conn.execute(sql, args).fetchone()

    def x(self, sql, args=()):
        with self.lock:
            return self.conn.execute(sql, args)

    def tx(self, fn):
        """Run fn(conn) in one transaction."""
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                out = fn(self.conn)
                self.conn.execute("COMMIT")
                return out
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def count(self, name, n=1):
        day = time.strftime("%Y-%m-%d", time.gmtime())
        self.x("INSERT INTO counters(day, name, n) VALUES(?,?,?) ON CONFLICT(day, name) DO UPDATE SET n=n+excluded.n",
               (day, name, n))

    def artist_genres(self, keys):
        out = {}
        keys = list(keys)
        for i in range(0, len(keys), 500):
            chunk = keys[i:i + 500]
            for r in self.q("SELECT name_key, genres FROM artists WHERE name_key IN (%s)" % ",".join("?" * len(chunk)), chunk):
                g = json.loads(r["genres"] or "[]")
                if g:
                    out[r["name_key"]] = g
        return out
