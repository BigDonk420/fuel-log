#!/usr/bin/env python3
"""
server.py — the FuelLog app server. One process does three jobs:
  1. serves the static app (index.html, js, css)
  2. proxies intervals.icu (browsers can't call it directly — CORS + Cloudflare)
  3. exposes a small REST API over SQLite for profiles (shared across devices)

A shared PIN gate protects the data API (needed once the app is public via
Tailscale Funnel): unlocking with the PIN issues a long random session cookie,
and every /api and /intervals call requires that cookie. Failed PIN attempts
are throttled + locked out so the short PIN can't be brute-forced.

Runs anywhere Python 3 does; in production it lives in a Docker container on the
always-on Mac Mini, fronted by Tailscale Serve/Funnel for HTTPS.

    python3 server.py            # http://localhost:8137
"""
import base64
import http.cookies
import json
import os
import secrets
import sqlite3
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("PORT", "8137"))
PIN = os.environ.get("APP_PIN", "666")
HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(HERE, "data", "fuellog.db"))
os.chdir(HERE)

COOKIE = "fl_session"
COOKIE_MAX_AGE = 60 * 60 * 24 * 180  # 180 days
# Brute-force throttle (global, in-memory): after MAX_FAILS bad PINs, lock the
# unlock endpoint for LOCKOUT seconds. Plus a per-attempt delay.
MAX_FAILS = 10
LOCKOUT = 900
throttle = {"fails": 0, "lock_until": 0.0}


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute(
        "CREATE TABLE IF NOT EXISTS profiles ("
        "  id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER)"
    )
    db.execute(
        "CREATE TABLE IF NOT EXISTS sessions ("
        "  token TEXT PRIMARY KEY, created_at INTEGER)"
    )
    db.commit()
    db.close()


def db_conn():
    return sqlite3.connect(DB_PATH)


class Handler(SimpleHTTPRequestHandler):
    # ----- response helpers -----
    def _json(self, obj, code=200, extra_headers=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or []):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _raw(self, data, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw) if raw else {}

    # ----- auth -----
    def _session_token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            jar = http.cookies.SimpleCookie(raw)
        except http.cookies.CookieError:
            return None
        return jar[COOKIE].value if COOKIE in jar else None

    def _authed(self):
        token = self._session_token()
        if not token:
            return False
        db = db_conn()
        row = db.execute("SELECT 1 FROM sessions WHERE token = ?", (token,)).fetchone()
        db.close()
        return row is not None

    def _guard(self):
        """Return True if authed; otherwise send 401 and return False."""
        if self._authed():
            return True
        self._json({"error": "locked"}, 401)
        return False

    def _unlock(self):
        now = time.time()
        if now < throttle["lock_until"]:
            wait = int(throttle["lock_until"] - now)
            return self._json({"error": "locked out", "retry_after": wait}, 429)
        try:
            pin = str(self._body().get("pin", ""))
        except Exception:
            pin = ""
        if not secrets.compare_digest(pin, PIN):
            throttle["fails"] += 1
            if throttle["fails"] >= MAX_FAILS:
                throttle["lock_until"] = now + LOCKOUT
                throttle["fails"] = 0
            time.sleep(1)  # slow brute force
            return self._json({"error": "wrong PIN"}, 401)
        # success
        throttle["fails"] = 0
        token = secrets.token_urlsafe(32)
        db = db_conn()
        db.execute("INSERT INTO sessions (token, created_at) VALUES (?, ?)", (token, int(now)))
        db.commit()
        db.close()
        cookie = f"{COOKIE}={token}; Path=/; Max-Age={COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax"
        self._json({"ok": True}, 200, extra_headers=[("Set-Cookie", cookie)])

    # ----- routing -----
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/profiles":
            return self._guard() and self._list_profiles()
        if path in ("/intervals/activities", "/intervals/wellness"):
            return self._guard() and self._proxy(urlparse(self.path))
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/unlock":
            return self._unlock()
        if path.startswith("/api/profiles/"):
            return self._guard() and self._save_profile(path.rsplit("/", 1)[-1])
        return self._json({"error": "not found"}, 404)

    def do_PUT(self):
        path = urlparse(self.path).path
        if path.startswith("/api/profiles/"):
            return self._guard() and self._save_profile(path.rsplit("/", 1)[-1])
        return self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/profiles/"):
            return self._guard() and self._delete_profile(path.rsplit("/", 1)[-1])
        return self._json({"error": "not found"}, 404)

    # ----- profiles API -----
    def _list_profiles(self):
        db = db_conn()
        rows = db.execute("SELECT data FROM profiles ORDER BY created_at").fetchall()
        db.close()
        self._json([json.loads(r[0]) for r in rows])

    def _save_profile(self, pid):
        try:
            profile = self._body()
        except Exception:
            return self._json({"error": "bad JSON"}, 400)
        profile["id"] = pid
        db = db_conn()
        db.execute(
            "INSERT INTO profiles (id, data, created_at) VALUES (?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            (pid, json.dumps(profile), profile.get("createdAt", 0)),
        )
        db.commit()
        db.close()
        self._json(profile)

    def _delete_profile(self, pid):
        db = db_conn()
        db.execute("DELETE FROM profiles WHERE id = ?", (pid,))
        db.commit()
        db.close()
        self._json({"ok": True})

    # ----- intervals.icu proxy -----
    def _proxy(self, parsed):
        qs = parse_qs(parsed.query)
        key = self.headers.get("X-Intervals-Key")
        athlete = qs.get("athlete", [""])[0]
        oldest = qs.get("oldest", [""])[0]
        newest = qs.get("newest", [""])[0]
        if not key or not athlete:
            return self._json({"error": "missing API key or athlete ID"}, 400)

        kind = "activities" if parsed.path.endswith("activities") else "wellness"
        url = (
            f"https://intervals.icu/api/v1/athlete/{athlete}/{kind}"
            f"?oldest={oldest}&newest={newest}"
        )
        token = base64.b64encode(f"API_KEY:{key}".encode()).decode()
        # Real User-Agent required — Cloudflare blocks urllib's default (error 1010).
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": "Basic " + token,
                "User-Agent": "Mozilla/5.0 (compatible; FuelLog/1.0; +local)",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                self._raw(r.read(), 200)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")[:200]
            self._json({"error": f"intervals.icu returned HTTP {e.code}", "detail": detail}, e.code)
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 502)

    def log_message(self, *args):
        pass  # quiet, and never log the intervals key or PIN


if __name__ == "__main__":
    init_db()
    print(f"FuelLog running at http://localhost:{PORT}  (db: {DB_PATH})")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
