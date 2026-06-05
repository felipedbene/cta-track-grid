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

// DeepSeek — distills active service alerts into a terse NORAD-style SITREP.
const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';
const SITREP_PROMPT =
  'You are the watch officer at a Chicago transit command center styled after a NORAD console. ' +
  'Condense the active service alerts below into a single terse situational report. ' +
  'Clipped, factual ops phrasing — no preamble, no pleasantries, no markdown, no bullet symbols. ' +
  'Do NOT begin with a label or the word "SITREP"; output only the report sentences. ' +
  'Lead with the most service-impacting items (suspensions, reroutes, major delays) before minor ones. ' +
  'Keep line and route names exactly as given. Never invent or speculate beyond the alerts provided. ' +
  'If several alerts share a cause, merge them into one clause. ' +
  'Hard limit 55 words; if over, drop the least service-impacting items rather than truncating mid-sentence.';

const EVENTS_PROMPT =
  'You are the watch officer at a Chicago transit command center (NORAD console). ' +
  'Below are major events in Chicago today, each with its venue and the transit it loads. ' +
  'Write a brief crowd advisory: which CTA/Metra lines and stations will be busy and roughly when — ' +
  'pre-event inbound surge before start time, post-event exodus after. ' +
  'Clipped ops phrasing, no preamble, no label, no markdown, no bullet symbols. ' +
  'Use the transit hint given for each event; never invent lines. Group events that load the same line. ' +
  'Hard limit 60 words.';

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

// SHA-256 hex of a string — keys the summary cache on alert content so the model
// is re-invoked only when the underlying alert set actually changes.
async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// CTA Customer Alerts for a route → [{headline, desc}], tolerating the API's
// single-object-vs-array quirk and dropping headerless rows.
async function ctaAlerts(env, route) {
  const data = await fetchCta(ALERTS_API, 'alerts.aspx', { routeid: route }, env, { needsKey: false, ttl: 60 });
  const raw = data?.CTAAlerts?.Alert;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((a) => ({ headline: a.Headline || '', desc: a.ShortDescription || '' })).filter((a) => a.headline);
}

// Shared DeepSeek + cache core for the SITREP and event-advisory digests. The
// model is keyed by SHA-256 of `corpus` in the given D1 `table`, so it is called
// at most once per distinct input — globally and durably. On a DeepSeek outage,
// serves the most recent stored summary instead of erroring. `table`/`countCol`
// are fixed internal constants (never user input), so interpolating them is safe.
async function deepseekCached(env, ctx, table, countCol, prompt, corpus, count) {
  const hash = await sha256hex(corpus);

  try {
    const row = await env.DB.prepare(`SELECT summary, model FROM ${table} WHERE hash = ?`).bind(hash).first();
    if (row) return { summary: row.summary, model: row.model, count, cached: true };
  } catch (_) { /* table absent (pre-migration) — fall through and generate */ }

  if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured');

  let summary, model;
  try {
    const res = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat', stream: false, temperature: 0.2, max_tokens: 220,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: corpus }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
    const out = await res.json();
    summary = out?.choices?.[0]?.message?.content?.trim();
    model = out.model || 'deepseek-chat';
    if (!summary) throw new Error('DeepSeek returned no content');
  } catch (err) {
    // Outage — serve the most recent good summary rather than failing loudly.
    const last = await env.DB
      .prepare(`SELECT summary, model FROM ${table} ORDER BY created_at DESC LIMIT 1`)
      .first().catch(() => null);
    if (last) return { summary: last.summary, model: last.model, count, cached: true, stale: true };
    throw err;
  }

  const write = env.DB
    .prepare(`INSERT OR REPLACE INTO ${table} (hash, summary, model, ${countCol}, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(hash, summary, model, count, Date.now()).run();
  if (ctx?.waitUntil) ctx.waitUntil(write); else await write;

  return { summary, model, count, cached: false };
}

// AI SITREP of active CTA Green Line + Metra alerts. Returns a nominal line (no
// LLM call) when nothing is active.
async function alertsSummary(env, ctx) {
  const [cta, metra] = await Promise.all([
    ctaAlerts(env, 'G').catch(() => []),
    metraAlerts(env).then((m) => m.alerts).catch(() => []),
  ]);

  const lines = [];
  for (const a of cta) lines.push(`CTA Green Line: ${a.headline}${a.desc ? ' — ' + a.desc : ''}`);
  for (const a of metra) {
    const rt = a.routes?.length ? ` [${a.routes.join(', ')}]` : '';
    lines.push(`Metra${rt}: ${a.header}${a.description ? ' — ' + a.description : ''}`);
  }
  if (!lines.length) {
    return { summary: 'ALL SYSTEMS NOMINAL — no active CTA Green Line or Metra service alerts.', count: 0, cached: false, model: null };
  }
  return deepseekCached(env, ctx, 'alert_summaries', 'alert_count', SITREP_PROMPT, lines.join('\n'), lines.length);
}

// --- Major Chicago events → crowd/transit advisory ---------------------------
// Sports come keyless from ESPN; concerts/festivals from Ticketmaster Discovery
// when TICKETMASTER_API_KEY is set (silently skipped otherwise). Each venue is
// mapped to the CTA/Metra line + station it loads, which DeepSeek turns into a
// timed crowd advisory. Same one-call-per-distinct-set caching as the SITREP.

// Venue → the transit it crushes. Substring-matched against the event venue name.
const VENUE_TRANSIT = [
  [/wrigley/i,                                          'Red Line · Addison'],
  [/(guaranteed rate|rate field|comiskey|sox park)/i,  'Red Line · Sox-35th'],
  [/united center/i,                                   'no direct L — shuttle/bus; nearest Green/Pink · Ashland'],
  [/soldier field/i,                                   'Metra Electric · Museum Campus; Red/Orange/Green · Roosevelt'],
  [/wintrust/i,                                         'Green Line · Cermak-McCormick Place'],
  [/(grant park|butler field|hutchinson|jackson park|northerly island|huntington bank)/i, 'Loop "L" + Metra Electric · Museum Campus'],
  [/(allstate arena|rosemont)/i,                       'Blue Line · Rosemont'],
  [/(aragon|riviera|metro chicago|the vic|uptown)/i,   'Red Line · Lawrence/Sheridan'],
  [/salt shed/i,                                       'Blue Line · Division (~0.6mi) or bus'],
  [/(credit union 1|tinley)/i,                         'Metra Rock Island'],
];
function venueTransit(name) {
  for (const [re, hint] of VENUE_TRANSIT) if (re.test(name || '')) return hint;
  return null;
}

// Today's date in Chicago as YYYYMMDD (ESPN scoreboard ?dates=) and a Chicago
// clock-time formatter for event start times.
function chicagoYmd(now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((o, x) => ((o[x.type] = x.value), o), {});
  return `${p.year}${p.month}${p.day}`;
}
function chicagoTime(iso) {
  if (!iso) return 'TBD';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

const ESPN_LEAGUES = ['baseball/mlb', 'basketball/nba', 'hockey/nhl', 'football/nfl', 'soccer/usa.1', 'basketball/wnba'];

// Chicago home games today across the major leagues (keyless ESPN, edge-cached).
async function chicagoSportsToday(ymd) {
  const events = [];
  await Promise.all(ESPN_LEAGUES.map(async (lg) => {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${lg}/scoreboard?dates=${ymd}`,
        { cf: { cacheTtl: 1800, cacheEverything: true }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const data = await res.json();
      for (const e of data.events || []) {
        const c = e.competitions?.[0];
        if (!c || !/chicago/i.test(c.venue?.address?.city || '')) continue;   // physically in Chicago
        const home = (c.competitors || []).find((t) => t.homeAway === 'home');
        const away = (c.competitors || []).find((t) => t.homeAway === 'away');
        const venue = c.venue?.fullName || 'venue TBD';
        events.push({
          name: `${away?.team?.displayName || 'TBD'} @ ${home?.team?.displayName || 'TBD'}`,
          venue, time: chicagoTime(e.date), transit: venueTransit(venue),
        });
      }
    } catch (_) { /* skip league on error */ }
  }));
  return events;
}

// Today's Chicago concerts/arts from Ticketmaster Discovery (only when keyed).
async function chicagoShowsToday(env, now) {
  if (!env.TICKETMASTER_API_KEY) return [];
  const floor = Math.floor(now.getTime() / 3600000) * 3600000;       // hour-floored → stable cache
  const start = new Date(floor).toISOString().slice(0, 19) + 'Z';
  const end = new Date(floor + 24 * 3600000).toISOString().slice(0, 19) + 'Z';
  const url = new URL('https://app.ticketmaster.com/discovery/v2/events.json');
  url.search = new URLSearchParams({
    apikey: env.TICKETMASTER_API_KEY, city: 'Chicago', stateCode: 'IL',
    classificationName: 'music', startDateTime: start, endDateTime: end, size: '40', sort: 'date,asc',
  }).toString();
  try {
    const res = await fetch(url, { cf: { cacheTtl: 1800, cacheEverything: true }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data._embedded?.events || [])
      .map((e) => {
        const venue = e._embedded?.venues?.[0]?.name || 'venue TBD';
        const time = e.dates?.start?.localTime ? e.dates.start.localTime.slice(0, 5) : 'TBD';
        return { name: e.name, venue, time, transit: venueTransit(venue) };
      })
      // Only major, transit-loading venues — drops the club-show noise (Empty
      // Bottle, Kingston Mines, …) so the advisory stays about real crowds.
      .filter((e) => e.transit);
  } catch (_) { return []; }
}

async function eventsAdvisory(env, ctx) {
  const now = new Date();
  const ymd = chicagoYmd(now);
  const [sports, shows] = await Promise.all([chicagoSportsToday(ymd), chicagoShowsToday(env, now)]);
  const all = [...sports, ...shows].slice(0, 25);   // bound the corpus
  if (!all.length) {
    return { summary: 'No major Chicago events flagged for today — normal transit load expected.', count: 0, cached: false, model: null, day: ymd };
  }
  const lines = all.map((e) => `${e.time} — ${e.name} @ ${e.venue}${e.transit ? ` (transit: ${e.transit})` : ''}`);
  const result = await deepseekCached(env, ctx, 'event_advisories', 'event_count', EVENTS_PROMPT, lines.join('\n'), all.length);
  return { ...result, day: ymd };
}

export default {
  async fetch(request, env, ctx) {
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
    // AI SITREP — DeepSeek digest of active alerts, cached one-call-per-alert-set.
    if (pathname === '/api/alerts/summary') {
      try {
        return json(await alertsSummary(env, ctx), 200, 120);
      } catch (err) {
        return json({ error: String(err?.message || err) }, 502);
      }
    }
    // Event advisory — DeepSeek crowd forecast for today's major Chicago events.
    if (pathname === '/api/events/advisory') {
      try {
        return json(await eventsAdvisory(env, ctx), 200, 600);
      } catch (err) {
        return json({ error: String(err?.message || err) }, 502);
      }
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
