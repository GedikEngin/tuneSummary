"""Outgoing email. One small interface so the SMTP backend can be swapped for an API provider (e.g. Resend) later.

TS_MAIL_BACKEND=smtp   Gmail or any SMTP server (TS_SMTP_HOST/PORT/USER/PASS, STARTTLS on 587, TLS on 465)
TS_MAIL_BACKEND=log    don't send; append messages to <data>/outbox.log (development)
"""
import logging
import os
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path

log = logging.getLogger("tunesummary.mail")


class CapReached(Exception):
    pass


class Mailer:
    def __init__(self, db, data_dir):
        self.db = db
        self.backend = os.environ.get("TS_MAIL_BACKEND", "smtp" if os.environ.get("TS_SMTP_HOST") else "log")
        self.from_name = os.environ.get("TS_MAIL_FROM_NAME", "TuneSummary")
        self.from_addr = os.environ.get("TS_MAIL_FROM", os.environ.get("TS_SMTP_USER", "noreply@localhost"))
        self.daily_cap = int(os.environ.get("TS_MAIL_DAILY_CAP", "400"))
        self.outbox = Path(data_dir) / "outbox.log"

    def sent_today(self):
        return self.db.one("SELECT COUNT(*) n FROM email_log WHERE at > ? AND ok=1", (time.time() - 86400,))["n"]

    def send(self, to, subject, text, html=None, kind="other", headers=None):
        if self.sent_today() >= self.daily_cap:
            log.warning("daily email cap (%d) reached, not sending %s", self.daily_cap, kind)
            raise CapReached()
        msg = EmailMessage()
        msg["From"] = formataddr((self.from_name, self.from_addr))
        msg["To"] = to
        msg["Subject"] = subject
        msg["Message-ID"] = make_msgid(domain=self.from_addr.split("@")[-1])
        for k, v in (headers or {}).items():
            msg[k] = v
        msg.set_content(text)
        if html:
            msg.add_alternative(html, subtype="html")
        ok = 0
        try:
            getattr(self, "_send_" + self.backend)(msg)
            ok = 1
        finally:
            # No address is logged: only when and what kind, for the daily cap and server stats.
            self.db.x("INSERT INTO email_log(at, kind, ok) VALUES(?,?,?)", (time.time(), kind, ok))
        log.info("sent %s email via %s", kind, self.backend)

    def _send_smtp(self, msg):
        host, port = os.environ["TS_SMTP_HOST"], int(os.environ.get("TS_SMTP_PORT", "587"))
        user, pw = os.environ["TS_SMTP_USER"], "".join(os.environ["TS_SMTP_PASS"].split())
        ctx = ssl.create_default_context()
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) as s:
                s.login(user, pw)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=30) as s:
                s.starttls(context=ctx)
                s.login(user, pw)
                s.send_message(msg)

    def _send_log(self, msg):
        head = "".join(f"{k}: {v}\n" for k, v in msg.items())
        text = msg.get_body(("plain",)).get_content()
        with open(self.outbox, "a") as f:
            f.write(head + "\n" + text + "\n" + "=" * 70 + "\n")
