# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A realtime Chicago 'L' train monitor styled as a NORAD / *WarGames* command board, running entirely on **Cloudflare Workers**. The Worker is an edge proxy for keyless-CORS transit APIs plus a small AI/history layer; the frontend is static assets served from the edge.

## Commands

```bash
npm install
npm run dev        # wrangler dev → http://localhost:8787 (reads secrets from .dev.vars)
npm run deploy     # wrangler deploy → tracker.debene.dev + *.workers.dev

# Secrets for local dev: cp .dev.vars.example .dev.vars and fill in.
# Production secrets: wrangler secret put CTA_KEY (and METRA_TOKEN, DEEPSEEK_API_KEY, TICKETMASTER_API_KEY)

# D1 migrations are applied MANUALLY (no automated runner). Apply each file in order:
npx wrangler d1 execute cta_history --remote --file migrations/0001_init.sql

# Regenerate glowing route geometry (only when CTA/Metra update GTFS schedules):
node scripts/build_lines.mjs        # → public/lines.geojson
node scripts/build_metra.mjs        # → public/metra.geojson
node scripts/build_southshore.mjs   # → public/southshore.geojson
```

There is no test suite, linter, or build step — `wrangler dev`/`deploy` is the full toolchain.

## Architecture

The entire backend is **one file: `src/index.js`** (a single Worker, ~665 lines). Everything is a `pathname ===` check inside the `fetch` handler; there is no router library. Static assets (`public/`) are served by the `ASSETS` binding *before* the Worker runs — only non-asset paths (`/api/*`) reach `src/index.js` (see the `not_found_handling: single-page-application` + `env.ASSETS.fetch` fallthrough at the end of `fetch`).

**Why a Worker proxy at all:** the upstream transit APIs have no CORS headers, so a browser cannot call them. The Worker relays requests, injects the CTA key (kept as a secret), and edge-caches responses (`cf: { cacheTtl, cacheEverything }`) so many viewers collapse into one upstream call per window.

Data sources, each with its own quirk:
- **CTA Train Tracker** (`LAPI`, needs `CTA_KEY`) — positions/arrivals/follow.
- **CTA Customer Alerts** (`ALERTS_API`, keyless, different host) — `ErrorCode 50` means "no active alerts", not a failure.
- **Metra** (`METRA_API`, GTFS-realtime protobuf, `METRA_TOKEN` Sanctum bearer) — decoded to JSON at the edge via `gtfs-realtime-bindings`. **Metra's WAF 403s Cloudflare-internal egress**, so Metra can only be fetched in *request context*, never from cron/background. Note the host migrated to `gtfspublic.metrarr.com` in 2025-11.
- **South Shore Line** (NICTD, keyless S3 GTFS-realtime) — feed carries no `route_id`, so all trains render as one line.
- **DeepSeek** (`deepseek-chat`) — powers three AI text panels (SITREP, event advisory, dispatcher narration).
- **Workers AI Aura TTS** (`AI` binding) + **Ticketmaster/ESPN** for the events advisory.

### AI panels + caching pattern (important)

Three endpoints (`/api/alerts/summary`, `/api/events/advisory`, `/api/feed/narration`) all go through `deepseekCached()`. The pattern: **SHA-256 the input corpus (or a coarser bucketed `keyStr`) → one D1 row per distinct input → never pay for the same LLM call twice.** This makes dedup global and durable. On DeepSeek outage it serves the last good row (`stale: true`) rather than failing. Spoken audio (`/api/audio`) is Aura → R2 (`AUDIO` bucket), keyed by the same hash and referenced via `audio_key` columns.

### History / replay

`/replay` (`public/replay.html`) scrubs 30 days of positions. Storage design: **one JSON blob per snapshot** (CTA + Metra + South Shore in the *same* row) rather than one row per train — ~1,440 writes/day instead of ~259k, staying in the D1 free tier. `/api/history/snapshot` embeds the stored JSON raw into the response string to skip a re-parse/re-serialize.

### Cron is retired — beware the dead `scheduled()` handler

`wrangler.jsonc` sets `triggers.crons: []`, so **the `scheduled()` handler in `src/index.js` never fires in production.** Position capture moved to an external `cta-snapshot` Kubernetes collector writing to TimescaleDB, and D1 retention is handled there. The `scheduled()` code (per-minute capture, nightly purge, the `metra_latest` stash it reads) is retained but inert. Don't assume history is being written by this Worker. (The README's Architecture section still describes the old cron flow — it is partially stale.)

## Bindings & secrets

| Binding | Type | Purpose |
|---|---|---|
| `ASSETS` | Static Assets (`public/`) | frontend, served before the Worker |
| `DB` | D1 (`cta_history`) | history snapshots + AI caches |
| `AI` | Workers AI | Deepgram Aura TTS (`remote: true` so `wrangler dev` hits the real model) |
| `AUDIO` | R2 (`cta-narration`) | cached narration mp3 |

Secrets: `CTA_KEY` (required), `METRA_TOKEN`, `DEEPSEEK_API_KEY`, `TICKETMASTER_API_KEY` (optional — advisory falls back to keyless ESPN sports-only without it).

## Frontend

`public/` is the canonical app: `index.html` (live monitor), `replay.html`, `ctaData.js` (302 stations, lat/lon + line flags), `transit-layers.js`, `lines.geojson`/`metra.geojson`/`southshore.geojson` (precomputed — no runtime GTFS parsing), `images/` per-line SVG badges. Rendered with Leaflet + CARTO tiles.

**Legacy — do not edit for the live app:** the top-level `server.js`, `monitor.html`, `script.js`, `index.html`, `norad.html`, `chicago_cta_norad_transit_map.html`, and root-level `ctaData.js` are an earlier Node prototype kept for history. The live app is the Worker (`src/`) + `public/`. Note `ctaData.js` exists in both root (legacy) and `public/` (served) — edit the `public/` copy.
