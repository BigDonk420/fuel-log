# FuelLog

A no-nonsense nutrition/fuelling tracker for runners. Pulls training load from
intervals.icu, computes calorie/macro/hydration targets from current (2025-26)
sports-nutrition science, and (soon) logs food via barcode + Open Food Facts.

## Architecture

One small Python server (stdlib only — no dependencies) that:

- serves the static app (`index.html`, `app.js`, `model.js`, `charts.js`, `styles.css`)
- proxies **intervals.icu** (browsers can't call it directly)
- exposes a **SQLite REST API** for profiles (shared across devices)

Runs in Docker on an always-on machine, fronted by **Tailscale Serve** for HTTPS
(required for phone camera / barcode scanning).

## Run on the Mac Mini

```bash
git clone https://github.com/BigDonk420/fuel-log.git
cd fuel-log
docker compose up -d --build
```

The app is now on the mini at `http://localhost:8137`. Data persists in the
`fuellog-data` Docker volume.

### Expose over HTTPS with Tailscale

```bash
tailscale serve --bg 8137
tailscale serve status      # shows your https://<mini>.<tailnet>.ts.net URL
```

Open that HTTPS URL on your phone (with the Tailscale app installed and on the
same tailnet). HTTPS is what unlocks camera access for barcode scanning.

To let friends in: invite them to your tailnet, or expose just this app publicly
with `tailscale funnel 8137` (keep other apps off Funnel).

## Local development

```bash
python3 server.py           # http://localhost:8137
```

## Files

- `server.py` — app server (static + intervals proxy + SQLite API)
- `model.js` — the fuelling engine (macros, energy availability, hydration)
- `charts.js` — dependency-free SVG visualizations
- `app.js` — UI, multi-user store, intervals provider
- `Dockerfile`, `docker-compose.yml` — container setup
