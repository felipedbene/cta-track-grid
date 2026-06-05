// CTA Track Grid — Cloudflare Worker.
//
// Edge proxy for the CTA Train Tracker API (key kept as a secret), Static Assets
// for the monitor frontend in ./public, a per-minute cron that snapshots train
// positions into D1, and history endpoints powering the /replay scrubber.
//
//   Local:  wrangler dev          (reads CTA_KEY from .dev.vars)
//   Deploy: wrangler deploy        (set key once: wrangler secret put CTA_KEY)
//
// The Train Tracker API has no CORS headers, so the browser cannot call it
// directly; the Worker relays the request and injects the key server-side.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

const LAPI = 'http://lapi.transitchicago.com/api/1.0';          // positions/arrivals/follow (needs key)
const ALERTS_API = 'http://www.transitchicago.com/api/1.0';     // customer alerts (keyless)
const ALL_ROUTES = 'red,blue,brn,g,org,p,pink,y';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;                  // keep 30 days of snapshots

// Metra regional rail — GTFS-realtime protobuf feeds (host gtfsapi.metrarail.com
// retired 2025-11; new host below). Auth is a Sanctum bearer token kept as the
// METRA_TOKEN secret. Realtime refreshes every 30s upstream and is rate-limited
// (~200 req/min), so we edge-cache decoded responses for a window.
const METRA_API = 'https://gtfspublic.metrarr.com/gtfs/public';

// South Shore Line (NICTD, Indiana) — keyless GTFS-realtime via ETA SPOT. The
// feed carries no route_id, so all trains render as a single South Shore line.
const SOUTHSHORE_FEED = 'https://s3.amazonaws.com/etatransit.gtfs/southshore.etaspot.net/position_updates.pb';

// Fetch + parse a CTA endpoint. Injects the key when needsKey; optionally caches
// the upstream response at the edge for `ttl` seconds. Throws on network/parse error.
async function fetchCta(base, endpoint, params, env, { needsKey = true, ttl = 0 } = {}) {
  const url = new URL(`${base}/${endpoint}`);
  url.searchParams.set('outputType', 'JSON');
  if (needsKey) {
    if (!env.CTA_KEY) throw new Error('CTA_KEY not configured');
    url.searchParams.set('key', env.CTA_KEY);
  }
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const init = { signal: AbortSignal.timeout(10_000) };
  if (ttl > 0) init.cf = { cacheTtl: ttl, cacheEverything: true };
  const res = await fetch(url, init);
  return JSON.parse(await res.text());
}

function json(obj, status = 200, ttl = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': ttl ? `public, max-age=${ttl}` : 'no-store',
    },
  });
}

// HTTP wrapper: turn a CTA call into a JSON Response, surfacing errors as 502.
async function apiCta(base, endpoint, params, env, opts = {}) {
  try {
    return json(await fetchCta(base, endpoint, params, env, opts), 200, opts.ttl || 0);
  } catch (err) {
    return json({ error: String(err?.message || err) }, 502);
  }
}

// Count trains across routes, normalizing CTA's single-vs-array quirk.
function countTrains(ctatt) {
  const routes = Array.isArray(ctatt.route) ? ctatt.route : ctatt.route ? [ctatt.route] : [];
  let n = 0;
  for (const r of routes) n += Array.isArray(r.train) ? r.train.length : r.train ? 1 : 0;
  return n;
}

// Fetch a Metra GTFS-realtime protobuf feed and return the decoded FeedMessage.
// Edge-caches the upstream bytes for `ttl` seconds. Throws on network/auth error.
async function fetchMetraFeed(env, endpoint, ttl) {
  if (!env.METRA_TOKEN) throw new Error('METRA_TOKEN not configured');
  const res = await fetch(`${METRA_API}/${endpoint}`, {
    headers: { Authorization: `Bearer ${env.METRA_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
    cf: ttl > 0 ? { cacheTtl: ttl, cacheEverything: true } : undefined,
  });
  if (!res.ok) throw new Error(`Metra ${endpoint} ${res.status}`);
  return FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
}

// Vehicle positions → flat, CTA-shaped train list the frontend can render.
async function metraPositions(env) {
  const feed = await fetchMetraFeed(env, 'positions', 25);
  const trains = [];
  for (const e of feed.entity) {
    const v = e.vehicle;
    const p = v?.position;
    if (!p || p.latitude == null || p.longitude == null) continue;
    // Skip route-less GPS blips (yard moves / deadheads / between assignments) —
    // only revenue trains assigned to a line are useful on the board.
    if (!v.trip?.routeId) continue;
    trains.push({
      id: v.vehicle?.id || e.id,
      label: v.vehicle?.label || null,
      route: v.trip.routeId,
      tripId: v.trip.tripId || null,
      lat: p.latitude,
      lon: p.longitude,
      heading: p.bearing ?? null,
      tmst: v.timestamp != null ? Number(v.timestamp) : null,
    });
  }
  return { tmst: feed.header?.timestamp != null ? Number(feed.header.timestamp) : null, trains };
}

// South Shore vehicle positions (keyless ETA SPOT feed). Standard GTFS-rt
// protobuf but route-less; we tag every train as the single South Shore line.
async function southShorePositions() {
  const res = await fetch(SOUTHSHORE_FEED, {
    signal: AbortSignal.timeout(10_000),
    cf: { cacheTtl: 20, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`South Shore feed ${res.status}`);
  const feed = FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
  const trains = [];
  for (const e of feed.entity) {
    const v = e.vehicle;
    const p = v?.position;
    if (!p || p.latitude == null || p.longitude == null) continue;
    trains.push({
      id: v.vehicle?.id || e.id,
      label: v.vehicle?.label || null,
      tripId: v.trip?.tripId || null,
      stopId: v.stopId || null,
      status: ['INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO'][v.currentStatus] || null,
      lat: p.latitude,
      lon: p.longitude,
      heading: p.bearing ?? null,
      tmst: v.timestamp != null ? Number(v.timestamp) : null,
    });
  }
  return { tmst: feed.header?.timestamp != null ? Number(feed.header.timestamp) : null, trains };
}

// First translation string of a GTFS-rt TranslatedString (header/desc/url).
const trText = (t) => t?.translation?.[0]?.text || '';

// Service alerts → headline, description, affected routes. Decoded with enum
// names (effect/cause) for human-readable tags. Drops headerless entries.
async function metraAlerts(env) {
  const feed = await fetchMetraFeed(env, 'alerts', 60);
  const o = FeedMessage.toObject(feed, { enums: String, longs: Number, defaults: false });
  const alerts = [];
  for (const e of o.entity || []) {
    const a = e.alert;
    const header = trText(a?.headerText);
    if (!a || !header) continue;
    const routes = [...new Set((a.informedEntity || []).map((ie) => ie.routeId).filter(Boolean))];
    alerts.push({
      id: e.id,
      header,
      description: trText(a.descriptionText),
      url: trText(a.url) || null,
      effect: a.effect && a.effect !== 'UNKNOWN_EFFECT' ? a.effect : null,
      cause: a.cause && a.cause !== 'UNKNOWN_CAUSE' ? a.cause : null,
      routes,
    });
  }
  return { tmst: o.header?.timestamp != null ? Number(o.header.timestamp) : null, alerts };
}

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);

    // --- Metra realtime (protobuf decoded to JSON at the edge) ---
    if (pathname === '/api/metra/positions') {
      try {
        return json(await metraPositions(env), 200, 25);
      } catch (err) {
        return json({ error: String(err?.message || err) }, 502);
      }
    }
    if (pathname === '/api/metra/alerts') {
      try {
        return json(await metraAlerts(env), 200, 60);
      } catch (err) {
        return json({ error: String(err?.message || err) }, 502);
      }
    }
    if (pathname === '/api/southshore/positions') {
      try {
        return json(await southShorePositions(), 200, 20);
      } catch (err) {
        return json({ error: String(err?.message || err) }, 502);
      }
    }

    // --- Live Train Tracker (needs key) ---
    if (pathname === '/api/positions') {
      const rt = searchParams.get('rt') || ALL_ROUTES;
      return apiCta(LAPI, 'ttpositions.aspx', { rt }, env, { ttl: 20 });
    }
    if (pathname === '/api/arrivals') {
      return apiCta(LAPI, 'ttarrivals.aspx', {
        mapid: searchParams.get('mapid'),
        stpid: searchParams.get('stpid'),
        max: searchParams.get('max'),
        rt: searchParams.get('rt'),
      }, env, { ttl: 15 });
    }
    if (pathname === '/api/follow') {
      return apiCta(LAPI, 'ttfollow.aspx', { runnumber: searchParams.get('runnumber') }, env, { ttl: 15 });
    }

    // --- Customer Alerts (keyless, different host). ErrorCode 50 = no active alerts. ---
    if (pathname === '/api/alerts') {
      return apiCta(ALERTS_API, 'alerts.aspx', {
        routeid: searchParams.get('route') || 'G',
      }, env, { needsKey: false, ttl: 60 });
    }

    // --- History (D1) ---
    // Lightweight frame index for the replay slider.
    if (pathname === '/api/history/index') {
      const from = Number(searchParams.get('from')) || 0;
      const to = Number(searchParams.get('to')) || Date.now();
      const { results } = await env.DB
        .prepare('SELECT id, observed_at, train_count FROM snapshots WHERE observed_at BETWEEN ? AND ? ORDER BY observed_at')
        .bind(from, to).all();
      return json({ frames: results }, 200, 10);
    }
    // A single snapshot — payload is stored JSON, embed it raw to skip a re-parse.
    if (pathname === '/api/history/snapshot') {
      const id = Number(searchParams.get('id'));
      const row = await env.DB
        .prepare('SELECT observed_at, tmst, payload FROM snapshots WHERE id = ?')
        .bind(id).first();
      if (!row) return json({ error: 'not found' }, 404);
      const body = `{"observed_at":${row.observed_at},"tmst":${JSON.stringify(row.tmst ?? null)},"payload":${row.payload}}`;
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    // --- Static assets (index.html, replay.html, ctaData.js, images/…) ---
    return env.ASSETS.fetch(request);
  },

  // Cron: capture positions every minute; purge old snapshots nightly.
  async scheduled(controller, env, ctx) {
    const now = controller.scheduledTime || Date.now();

    if (controller.cron === '0 4 * * *') {
      ctx.waitUntil(
        env.DB.prepare('DELETE FROM snapshots WHERE observed_at < ?')
          .bind(now - RETENTION_MS).run()
      );
      return;
    }

    // Every-minute capture. Swallow transient upstream hiccups so a single bad
    // tick is not reported as a cron failure.
    try {
      const data = await fetchCta(LAPI, 'ttpositions.aspx', { rt: ALL_ROUTES }, env, { ttl: 0 });
      const ctatt = data.ctatt || {};
      if (ctatt.errCd && ctatt.errCd !== '0') return;
      await env.DB
        .prepare('INSERT INTO snapshots (observed_at, tmst, train_count, payload) VALUES (?, ?, ?, ?)')
        .bind(now, ctatt.tmst ?? null, countTrains(ctatt), JSON.stringify(data))
        .run();
    } catch (err) {
      console.error('capture failed:', err?.stack || err);
    }
  },
};
