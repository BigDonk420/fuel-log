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
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("PORT", "8137"))
PIN = os.environ.get("APP_PIN", "666")
# USDA FoodData Central — far better US branded coverage than Open Food Facts.
# DEMO_KEY works but is heavily rate-limited; get a free key at
# https://fdc.nal.usda.gov/api-key-signup.html and set USDA_API_KEY.
USDA_API_KEY = os.environ.get("USDA_API_KEY", "DEMO_KEY")
UA = "Mozilla/5.0 (compatible; FuelLog/1.0)"
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
    db.execute(
        "CREATE TABLE IF NOT EXISTS food_logs ("
        "  id TEXT PRIMARY KEY, profile_id TEXT, log_date TEXT, data TEXT)"
    )
    # Local food database: user corrections + custom foods. Checked FIRST on
    # every lookup, so fixing a bad entry once fixes it forever.
    db.execute(
        "CREATE TABLE IF NOT EXISTS foods ("
        "  barcode TEXT PRIMARY KEY, data TEXT, updated_at INTEGER)"
    )
    db.commit()
    db.close()


def db_conn():
    return sqlite3.connect(DB_PATH)


# ---------- barcodes ----------
def _digits(s):
    return "".join(c for c in str(s or "") if c.isdigit())


def upc_check_digit(d11):
    odd = sum(int(d11[i]) for i in range(0, 11, 2))
    even = sum(int(d11[i]) for i in range(1, 11, 2))
    return (10 - (odd * 3 + even) % 10) % 10


def expand_upce(code):
    """UPC-E (compressed, used on cans/small packages) -> UPC-A (12 digits).
    Food databases are keyed on UPC-A/EAN-13, so this expansion is required or
    every canned-drink scan misses."""
    d = _digits(code)
    if len(d) == 6:
        n, x = "0", d
    elif len(d) == 7:
        n, x = d[0], d[1:7]
    elif len(d) == 8:
        n, x = d[0], d[1:7]
    else:
        return None
    if n not in ("0", "1"):
        return None
    last = x[5]
    if last in "012":
        body = n + x[0] + x[1] + last + "0000" + x[2] + x[3] + x[4]
    elif last == "3":
        body = n + x[0] + x[1] + x[2] + "00000" + x[3] + x[4]
    elif last == "4":
        body = n + x[0] + x[1] + x[2] + x[3] + "00000" + x[4]
    else:
        body = n + x[0] + x[1] + x[2] + x[3] + x[4] + "0000" + last
    return body + str(upc_check_digit(body))


def code_candidates(code):
    """Every plausible form of a scanned code, in priority order.

    Order matters: a 6-8 digit code is UPC-E, and its EXPANSION is the real
    GTIN — so try that first. Querying the raw short code instead tends to
    fuzzy-match junk community entries (a 6-digit query once returned "Mtn dee"
    instead of the real Diet Mtn Dew at 012000001666)."""
    d = _digits(code)
    if not d:
        return []
    e = expand_upce(d)
    ordered = []
    if len(d) < 12 and e:
        ordered.append(e)
    ordered.append(d)
    if e:
        ordered.append(e)
    for c in list(ordered):
        if len(c) == 12:
            ordered.append("0" + c)          # UPC-A -> EAN-13
        elif len(c) == 13 and c.startswith("0"):
            ordered.append(c[1:])            # EAN-13 -> UPC-A
    seen, uniq = set(), []
    for c in ordered:
        if c and c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


# ---------- external food sources ----------
def _http_json(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def _servings(grams, label):
    out = []
    if grams and label:
        out.append({"label": label, "grams": round(grams)})
    out.append({"label": "100 g", "grams": 100})
    return out


def normalize_usda(f):
    nut = {}
    for n in f.get("foodNutrients", []) or []:
        nut[str(n.get("nutrientNumber") or "")] = n.get("value") or 0
    size = f.get("servingSize") or 0
    unit = (f.get("servingSizeUnit") or "").lower()
    label = f.get("householdServingFullText") or (f"{size:g} {unit}" if size else "")
    grams = size if unit in ("g", "ml", "grm") else 0
    return {
        "barcode": _digits(f.get("gtinUpc")),
        "name": (f.get("description") or "").title(),
        "brand": f.get("brandOwner") or f.get("brandName") or "",
        "per100": {
            "kcal": round(nut.get("208", 0)),
            "protein": round(nut.get("203", 0)),
            "carbs": round(nut.get("205", 0)),
            "fat": round(nut.get("204", 0)),
        },
        "servings": _servings(grams, label),
        "source": "usda",
    }


def normalize_off(p):
    n = p.get("nutriments") or {}
    kcal = n.get("energy-kcal_100g")
    if kcal is None and n.get("energy_100g") is not None:
        kcal = n["energy_100g"] / 4.184
    import re as _re
    m = _re.search(r"([\d.]+)\s*(g|ml)", p.get("serving_size") or "", _re.I)
    grams = float(m.group(1)) if m else 0
    return {
        "barcode": _digits(p.get("code")),
        "name": p.get("product_name") or "",
        "brand": p.get("brands") or "",
        "per100": {
            "kcal": round(kcal or 0),
            "protein": round(n.get("proteins_100g") or 0),
            "carbs": round(n.get("carbohydrates_100g") or 0),
            "fat": round(n.get("fat_100g") or 0),
        },
        "servings": _servings(grams, p.get("serving_size") or ""),
        "source": "off",
    }


def usda_by_barcode(code):
    try:
        j = _http_json(
            f"https://api.nal.usda.gov/fdc/v1/foods/search?query={code}"
            f"&dataType=Branded&pageSize=5&api_key={USDA_API_KEY}"
        )
    except Exception:
        return None
    for f in j.get("foods", []) or []:
        if _digits(f.get("gtinUpc")).lstrip("0") == code.lstrip("0"):
            return normalize_usda(f)
    return None


def off_by_barcode(code):
    try:
        j = _http_json(
            f"https://world.openfoodfacts.org/api/v2/product/{code}.json"
            "?fields=code,product_name,brands,nutriments,serving_size"
        )
    except Exception:
        return None
    if j.get("status") == 1 and (j.get("product") or {}).get("product_name"):
        return normalize_off(j["product"])
    return None


def lookup_chain(code, local_get):
    """local override -> USDA -> Open Food Facts, across every code form."""
    for c in code_candidates(code):
        hit = local_get(c)
        if hit:
            hit["source"] = "local"
            return hit
    for c in code_candidates(code):
        hit = usda_by_barcode(c)
        if hit:
            return hit
    for c in code_candidates(code):
        hit = off_by_barcode(c)
        if hit:
            return hit
    return None


def search_sources(q):
    out = []
    try:
        j = _http_json(
            f"https://api.nal.usda.gov/fdc/v1/foods/search?query={urllib.parse.quote(q)}"
            f"&dataType=Branded,Foundation&pageSize=10&api_key={USDA_API_KEY}"
        )
        out += [normalize_usda(f) for f in (j.get("foods") or [])]
    except Exception:
        pass
    try:
        j = _http_json(
            f"https://world.openfoodfacts.org/cgi/search.pl?search_terms={urllib.parse.quote(q)}"
            "&json=1&page_size=10&fields=code,product_name,brands,nutriments,serving_size"
        )
        out += [normalize_off(p) for p in (j.get("products") or []) if p.get("product_name")]
    except Exception:
        pass
    return [f for f in out if f["name"] and f["per100"]["kcal"]]


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

    def end_headers(self):
        # Never let browsers cache the app shell / JS. Without this, a redeploy
        # leaves users silently running stale client code against a new server.
        p = self.path.split("?")[0]
        if not p.startswith("/api") and not p.startswith("/intervals"):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

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
        if path == "/api/food":
            return self._guard() and self._list_food(urlparse(self.path))
        if path == "/api/foods":
            return self._guard() and self._list_food_defs()
        if path == "/api/lookup":
            return self._guard() and self._lookup(urlparse(self.path))
        if path == "/api/search":
            return self._guard() and self._search(urlparse(self.path))
        if path in ("/intervals/activities", "/intervals/wellness"):
            return self._guard() and self._proxy(urlparse(self.path))
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/unlock":
            return self._unlock()
        if path.startswith("/api/profiles/"):
            return self._guard() and self._save_profile(path.rsplit("/", 1)[-1])
        if path.startswith("/api/foods/"):
            return self._guard() and self._save_food_def(path.rsplit("/", 1)[-1])
        if path.startswith("/api/food/"):
            return self._guard() and self._save_food(path.rsplit("/", 1)[-1])
        return self._json({"error": "not found"}, 404)

    def do_PUT(self):
        path = urlparse(self.path).path
        if path.startswith("/api/profiles/"):
            return self._guard() and self._save_profile(path.rsplit("/", 1)[-1])
        if path.startswith("/api/foods/"):
            return self._guard() and self._save_food_def(path.rsplit("/", 1)[-1])
        if path.startswith("/api/food/"):
            return self._guard() and self._save_food(path.rsplit("/", 1)[-1])
        return self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path.startswith("/api/profiles/"):
            return self._guard() and self._delete_profile(path.rsplit("/", 1)[-1])
        if path.startswith("/api/foods/"):
            return self._guard() and self._delete_food_def(path.rsplit("/", 1)[-1])
        if path.startswith("/api/food/"):
            return self._guard() and self._delete_food(path.rsplit("/", 1)[-1])
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

    # ----- food logs API -----
    def _list_food(self, parsed):
        qs = parse_qs(parsed.query)
        profile = qs.get("profile", [""])[0]
        date = qs.get("date", [""])[0]
        db = db_conn()
        rows = db.execute(
            "SELECT data FROM food_logs WHERE profile_id = ? AND log_date = ?",
            (profile, date),
        ).fetchall()
        db.close()
        self._json([json.loads(r[0]) for r in rows])

    def _save_food(self, fid):
        try:
            entry = self._body()
        except Exception:
            return self._json({"error": "bad JSON"}, 400)
        entry["id"] = fid
        db = db_conn()
        db.execute(
            "INSERT INTO food_logs (id, profile_id, log_date, data) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            (fid, entry.get("profileId", ""), entry.get("date", ""), json.dumps(entry)),
        )
        db.commit()
        db.close()
        self._json(entry)

    def _delete_food(self, fid):
        db = db_conn()
        db.execute("DELETE FROM food_logs WHERE id = ?", (fid,))
        db.commit()
        db.close()
        self._json({"ok": True})

    # ----- food database (corrections + custom foods) -----
    def _local_food(self, barcode):
        db = db_conn()
        row = db.execute("SELECT data FROM foods WHERE barcode = ?", (barcode,)).fetchone()
        db.close()
        return json.loads(row[0]) if row else None

    def _list_food_defs(self):
        db = db_conn()
        rows = db.execute("SELECT data FROM foods ORDER BY updated_at DESC").fetchall()
        db.close()
        self._json([json.loads(r[0]) for r in rows])

    def _save_food_def(self, barcode):
        try:
            food = self._body()
        except Exception:
            return self._json({"error": "bad JSON"}, 400)
        food["barcode"] = barcode
        food["source"] = "local"
        db = db_conn()
        db.execute(
            "INSERT INTO foods (barcode, data, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(barcode) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (barcode, json.dumps(food), int(time.time())),
        )
        db.commit()
        db.close()
        self._json(food)

    def _delete_food_def(self, barcode):
        db = db_conn()
        db.execute("DELETE FROM foods WHERE barcode = ?", (barcode,))
        db.commit()
        db.close()
        self._json({"ok": True})

    def _lookup(self, parsed):
        code = parse_qs(parsed.query).get("code", [""])[0]
        if not code:
            return self._json({"error": "missing code"}, 400)
        food = lookup_chain(code, self._local_food)
        if not food:
            return self._json({"error": "not found", "tried": code_candidates(code)}, 404)
        self._json(food)

    def _search(self, parsed):
        q = parse_qs(parsed.query).get("q", [""])[0]
        if not q:
            return self._json([])
        self._json(search_sources(q))

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
