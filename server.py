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
import datetime
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

def _load_dotenv():
    """Local-dev convenience: read a gitignored .env if present. In Docker,
    compose supplies these as real env vars, so we never override what's set."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())
    except FileNotFoundError:
        pass


_load_dotenv()

PORT = int(os.environ.get("PORT", "8137"))
PIN = os.environ.get("APP_PIN", "666")
# USDA FoodData Central — far better US branded coverage than Open Food Facts.
# DEMO_KEY works but is heavily rate-limited; get a free key at
# https://fdc.nal.usda.gov/api-key-signup.html and set USDA_API_KEY.
USDA_API_KEY = os.environ.get("USDA_API_KEY", "DEMO_KEY")
UA = "Mozilla/5.0 (compatible; FuelLog/1.0)"
# AI meal suggester. Default to the most capable model; override with
# SUGGEST_MODEL (e.g. claude-haiku-4-5) to trade quality for cost. The key lives
# in .env as ANTHROPIC_API_KEY. The SDK is optional at import so the rest of the
# app runs without it — the /api/suggest route degrades gracefully.
SUGGEST_MODEL = os.environ.get("SUGGEST_MODEL", "claude-opus-4-8")
try:
    import anthropic
except ImportError:
    anthropic = None
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


# Household serving text -> a discrete unit. USDA says "3 pieces" with a 40 g
# serving; that means one piece is 13.3 g, which is the unit people actually
# think in ("I ate 3 Snickers minis", not "I ate 48 grams").
import re as _re

_UNIT_WORDS = (
    "pieces|piece|bars|bar|cans|can|bottles|bottle|slices|slice|cookies|cookie|"
    "eggs|egg|packets|packet|packs|pack|scoops|scoop|squares|square|sticks|stick|"
    "minis|mini|servings|serving|links|link|patties|patty|wraps|wrap|balls|ball"
)


def _leading_qty(text):
    """Parse '3', '1.5', '1/2', '1 1/2' from the front of a string."""
    t = text.strip()
    m = _re.match(r"^(\d+)\s+(\d+)\s*/\s*(\d+)", t)          # 1 1/2
    if m:
        return int(m.group(1)) + int(m.group(2)) / int(m.group(3)), t[m.end():]
    m = _re.match(r"^(\d+)\s*/\s*(\d+)", t)                  # 1/2
    if m:
        return int(m.group(1)) / int(m.group(2)), t[m.end():]
    m = _re.match(r"^(\d+(?:\.\d+)?)", t)                    # 3 / 1.5
    if m:
        return float(m.group(1)), t[m.end():]
    return None, t


def parse_household(text, serving_grams):
    """'3 pieces' + 40 g  ->  {label: 'piece', grams: 13.3}"""
    if not text or not serving_grams:
        return None
    qty, rest = _leading_qty(str(text))
    if not qty or qty <= 0:
        qty = 1.0
    m = _re.search(_UNIT_WORDS, rest.lower())
    if not m:
        return None
    unit = m.group(0)
    if unit.endswith("es") and unit[:-2] in ("patti", "wrap"):
        unit = unit[:-2]
    elif unit.endswith("s"):
        unit = unit[:-1]
    grams = serving_grams / qty
    if grams <= 0:
        return None
    return {"label": unit, "grams": round(grams, 1), "discrete": True}


def _servings(grams, label, household=None):
    """Product-specific servings, most-likely first. Generic mass/volume units
    (g, oz, ml, cup...) are added by the client, not here."""
    out = []
    unit = parse_household(household or label, grams)
    if unit:
        out.append(unit)
    if grams:
        out.append({"label": "serving", "grams": round(grams, 1), "discrete": True})
    return out


def _is_liquid(unit, text):
    blob = ("%s %s" % (unit or "", text or "")).lower()
    return bool(_re.search(r"\bml\b|\bmlt\b|\bfl\.? ?oz\b|\bliter|\blitre|\bl\b", blob))


def normalize_usda(f):
    nut = {}
    for n in f.get("foodNutrients", []) or []:
        nut[str(n.get("nutrientNumber") or "")] = n.get("value") or 0
    size = f.get("servingSize") or 0
    unit = (f.get("servingSizeUnit") or "").lower()
    household = f.get("householdServingFullText") or ""
    grams = size if unit in ("g", "ml", "grm", "mlt") else 0
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
        "servings": _servings(grams, household, household),
        "isLiquid": _is_liquid(unit, household),
        "source": "usda",
    }


def normalize_off(p):
    n = p.get("nutriments") or {}
    kcal = n.get("energy-kcal_100g")
    if kcal is None and n.get("energy_100g") is not None:
        kcal = n["energy_100g"] / 4.184
    text = p.get("serving_size") or ""
    m = _re.search(r"([\d.]+)\s*(g|ml)\b", text, _re.I)
    grams = float(m.group(1)) if m else float(p.get("serving_quantity") or 0)
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
        "servings": _servings(grams, text, text),
        "isLiquid": _is_liquid("", text + " " + (p.get("quantity") or "")),
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


def best_match(q):
    """Top real-database hit for a food name — the validation anchor."""
    for f in search_sources(q or ""):
        return f
    return None


# ---------- AI meal suggester ----------
# The app computes the remaining macro envelope; Claude proposes foods + grams;
# the app then validates each food against the real database and computes the
# actual totals. The model NEVER supplies the final nutrition numbers.
SUGGEST_SYSTEM = (
    "You are a sports-nutrition assistant for distance runners. Given the macros "
    "an athlete wants from a SINGLE meal, compose ONE realistic meal that "
    "fills that envelope as closely as possible. This is one meal of several in the "
    "day — do NOT try to cram the athlete's whole daily remainder into it.\n"
    "Priorities, in order: (1) hit the carbohydrate target — carbs fuel a runner's "
    "training and recovery; (2) hit the protein target; (3) let fat fill the remainder. "
    "Use 2-5 common, real, whole or lightly-processed foods that are easy to find in a "
    "food database (chicken breast, white rice, banana, Greek yogurt, oats, eggs, olive "
    "oil, etc.). Approximate portions in grams are fine.\n"
    "You do NOT compute final nutrition — the app validates your foods against a real "
    "database. For each item give a short database-friendly search query and a rough "
    "per-100g estimate (used only if the database has no match)."
)

SUGGEST_SCHEMA = {
    "type": "object",
    "properties": {
        "meal": {"type": "string"},
        "rationale": {"type": "string"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "query": {"type": "string"},
                    "grams": {"type": "number"},
                    "per100": {
                        "type": "object",
                        "properties": {
                            "kcal": {"type": "number"}, "protein": {"type": "number"},
                            "carbs": {"type": "number"}, "fat": {"type": "number"},
                        },
                        "required": ["kcal", "protein", "carbs", "fat"],
                        "additionalProperties": False,
                    },
                },
                "required": ["name", "query", "grams", "per100"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["meal", "rationale", "items"],
    "additionalProperties": False,
}


# Time-of-day steer so a 7am suggestion looks like breakfast, not dinner.
MEAL_STYLE = {
    "breakfast": "It is BREAKFAST — favour breakfast foods: oats, eggs, Greek yogurt, "
                 "fruit, wholegrain toast, granola, milk, nut butter.",
    "lunch": "It is LUNCH — favour a balanced plate: a lean protein, a starch "
             "(rice, potato, wrap, bread), and vegetables or fruit.",
    "snack": "It is a SNACK — keep it light and simple: fruit, yogurt, a bar, nuts, "
             "toast, a smoothie. Usually 1-2 items.",
    "dinner": "It is DINNER — favour a cooked plate: a protein, a cooked starch "
              "(rice, pasta, potato), and vegetables.",
}


def meal_target(remaining, cap):
    """Scale the day's remaining macros down to a single meal's envelope.
    Keeps the carb/protein/fat RATIO of the remaining day, but shrinks the whole
    thing so total calories land near `cap`. No cap (or cap >= remaining) means
    the meal simply targets whatever is left."""
    kcal = float((remaining or {}).get("kcal") or 0)
    try:
        cap = float(cap)
    except (TypeError, ValueError):
        cap = 0
    if kcal <= 0 or cap <= 0 or cap >= kcal:
        return dict(remaining or {})
    f = cap / kcal
    return {k: round((remaining.get(k) or 0) * f) for k in ("kcal", "carbs", "protein", "fat")}


def compose_meal(ctx):
    """Ask Claude for a meal plan (foods + grams). Returns the parsed dict."""
    tgt = ctx.get("mealTarget") or ctx.get("remaining") or {}
    day = ctx.get("remaining") or {}
    session = ctx.get("session") or {}
    sess_txt = (
        f"today's session is a {session.get('type')} of about "
        f"{session.get('durationMin')} min"
        if session and session.get("type") and session.get("type") != "rest"
        else "today is a rest / easy day"
    )
    meal_type = ctx.get("mealType", "a meal")
    prefs = (ctx.get("prefs") or "").strip()
    user = (
        f"Meal to compose: {meal_type}.\n"
        f"Target macros for THIS meal: "
        f"{round(tgt.get('kcal', 0))} kcal, {round(tgt.get('carbs', 0))} g carbs, "
        f"{round(tgt.get('protein', 0))} g protein, {round(tgt.get('fat', 0))} g fat.\n"
    )
    if round(day.get("kcal", 0)) > round(tgt.get("kcal", 0)):
        user += (
            f"(Context: the athlete still needs about {round(day.get('kcal', 0))} kcal "
            f"across the whole rest of the day — this meal is just one slice of that, so "
            f"stick to the per-meal target above.)\n"
        )
    user += f"Athlete: ~{round(ctx.get('weightKg', 70))} kg runner; {sess_txt}."
    style = MEAL_STYLE.get(meal_type)
    if style:
        user += f"\n{style}"
    if prefs:
        user += f"\nDietary notes / preferences: {prefs}"
    exclude = [e for e in (ctx.get("exclude") or []) if str(e).strip()]
    if exclude:
        user += (
            "\nHARD RULE — the athlete will NOT eat these foods; never include them "
            "or anything containing them: " + ", ".join(exclude) + "."
        )

    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY
    resp = client.messages.create(
        model=SUGGEST_MODEL,
        max_tokens=1500,
        system=SUGGEST_SYSTEM,
        messages=[{"role": "user", "content": user}],
        output_config={"format": {"type": "json_schema", "schema": SUGGEST_SCHEMA}},
    )
    text = next((b.text for b in resp.content if b.type == "text"), "{}")
    return json.loads(text)


def validate_meal(raw, remaining, exclude=None):
    """Replace Claude's estimates with real database macros where available,
    then compute the actual totals. This is the 'validate' half of the contract.
    Excluded foods are dropped as a backstop even if the model slips one in."""
    excl = [str(e).strip().lower() for e in (exclude or []) if str(e).strip()]
    items, totals = [], {"kcal": 0, "protein": 0, "carbs": 0, "fat": 0}
    for it in raw.get("items", []):
        grams = float(it.get("grams") or 0)
        if grams <= 0:
            continue
        blob = (str(it.get("name", "")) + " " + str(it.get("query", ""))).lower()
        if any(e in blob for e in excl):
            continue
        match = best_match(it.get("query") or it.get("name"))
        per100 = match["per100"] if match else (it.get("per100") or {})
        source = match["source"] if match else "estimate"
        s = grams / 100.0
        e = {
            "name": it.get("name", "food"),
            "grams": round(grams),
            "per100": {
                "kcal": round(per100.get("kcal", 0)),
                "protein": round(per100.get("protein", 0)),
                "carbs": round(per100.get("carbs", 0)),
                "fat": round(per100.get("fat", 0)),
            },
            "kcal": round(per100.get("kcal", 0) * s),
            "protein": round(per100.get("protein", 0) * s),
            "carbs": round(per100.get("carbs", 0) * s),
            "fat": round(per100.get("fat", 0) * s),
            "source": source,
        }
        for k in totals:
            totals[k] += e[k]
        items.append(e)
    return {
        "meal": raw.get("meal", "Suggested meal"),
        "rationale": raw.get("rationale", ""),
        "target": remaining,
        "items": items,
        "totals": {k: round(v) for k, v in totals.items()},
    }


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
    ASSETS = ["app.js", "food.js", "model.js", "charts.js", "styles.css"]

    def _index(self):
        """Serve index.html with a version stamped onto every asset URL, derived
        from the files' mtimes. A redeploy changes the stamp, so browsers cannot
        serve a stale app.js/food.js — which silently happened twice already."""
        try:
            v = str(int(max(os.path.getmtime(f) for f in self.ASSETS if os.path.exists(f))))
            with open("index.html", "r") as fh:
                html = fh.read()
            for f in self.ASSETS:
                html = html.replace('"%s"' % f, '"%s?v=%s"' % (f, v))
            body = html.encode()
        except Exception:
            return super().do_GET()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self._index()
        if path == "/api/profiles":
            return self._guard() and self._list_profiles()
        if path == "/api/food":
            return self._guard() and self._list_food(urlparse(self.path))
        if path == "/api/foods":
            return self._guard() and self._list_food_defs()
        if path == "/api/frequent":
            return self._guard() and self._frequent(urlparse(self.path))
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
        if path == "/api/suggest":
            return self._guard() and self._suggest()
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

    def _frequent(self, parsed):
        """Foods this profile logs most often, newest wins as the template.
        Derived from the log itself — nothing for the user to curate."""
        qs = parse_qs(parsed.query)
        profile = qs.get("profile", [""])[0]
        days = int(qs.get("days", ["30"])[0])
        limit = int(qs.get("limit", ["8"])[0])
        cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
        db = db_conn()
        rows = db.execute(
            "SELECT data, log_date FROM food_logs WHERE profile_id = ? AND log_date >= ? "
            "ORDER BY log_date",
            (profile, cutoff),
        ).fetchall()
        db.close()

        agg = {}
        for data, when in rows:
            try:
                e = json.loads(data)
            except Exception:
                continue
            key = (e.get("barcode") or (e.get("name") or "").lower()).strip()
            if not key:
                continue
            a = agg.setdefault(key, {"key": key, "count": 0, "last": ""})
            a["count"] += 1
            if when >= a["last"]:          # most recent log becomes the template
                a["last"] = when
                a["name"] = e.get("name")
                a["barcode"] = e.get("barcode") or ""
                a["per100"] = e.get("per100")
                a["unitGrams"] = e.get("unitGrams")
                a["unitLabel"] = e.get("unitLabel")
                a["discrete"] = bool(e.get("discrete"))
                a["qty"] = e.get("qty", 1)
        out = [a for a in agg.values() if a.get("per100")]
        out.sort(key=lambda a: (-a["count"], a.get("name") or ""))
        self._json(out[:limit])

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

    def _suggest(self):
        try:
            body = self._body()
        except Exception:
            return self._json({"error": "bad JSON"}, 400)
        if anthropic is None:
            return self._json({"error": "AI suggestions unavailable: the 'anthropic' package isn't installed on the server."}, 501)
        if not os.environ.get("ANTHROPIC_API_KEY"):
            return self._json({"error": "AI suggestions need an Anthropic API key. Add ANTHROPIC_API_KEY to the server's .env file."}, 400)
        tgt = meal_target(body.get("remaining") or {}, body.get("capKcal"))
        body["mealTarget"] = tgt
        try:
            raw = compose_meal(body)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": "suggestion failed: " + str(e)[:200]}, 502)
        self._json(validate_meal(raw, tgt, body.get("exclude")))

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
