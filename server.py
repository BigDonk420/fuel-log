#!/usr/bin/env python3
"""
server.py — the FuelLog app server. One process does three jobs:
  1. serves the static app (index.html, js, css)
  2. proxies intervals.icu (browsers can't call it directly — CORS + Cloudflare)
  3. exposes a small REST API over SQLite for profiles (shared across devices)

Runs anywhere Python 3 does; in production it lives in a Docker container on the
always-on Mac Mini, fronted by Tailscale Serve for HTTPS.

    python3 server.py            # http://localhost:8137
"""
import base64
import json
import os
import sqlite3
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("PORT", "8137"))
HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(HERE, "data", "fuellog.db"))
os.chdir(HERE)


# ---------- database ----------
def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute(
        "CREATE TABLE IF NOT EXISTS profiles ("
        "  id TEXT PRIMARY KEY,"
        "  data TEXT NOT NULL,"
        "  created_at INTEGER"
        ")"
    )
    db.commit()
    db.close()


def db_conn():
    return sqlite3.connect(DB_PATH)


class Handler(SimpleHTTPRequestHandler):
    # ----- helpers -----
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
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

    # ----- routing -----
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/profiles":
            return self._list_profiles()
        if path in ("/intervals/activities", "/intervals/wellness"):
            return self._proxy(urlparse(self.path))
        return super().do_GET()

    def do_PUT(self):
        path = urlparse(self.path).path
        if path.startswith("/api/profiles/"):
            return self._save_profile(path.rsplit("/", 1)[-1])
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        return self.do_PUT()

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/profiles/"):
            return self._delete_profile(path.rsplit("/", 1)[-1])
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
        pass  # quiet, and never log the intervals key


if __name__ == "__main__":
    init_db()
    print(f"FuelLog running at http://localhost:{PORT}  (db: {DB_PATH})")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
