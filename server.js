// Zero-dependency proxy + static server for the CTA realtime monitor.
//
//   node server.js           -> http://localhost:8080/monitor.html
//   CTA_KEY=xxxx node server.js   (override the key via env)
//
// Why a proxy: the CTA Train Tracker API has no CORS headers, so a browser
// cannot call lapi.transitchicago.com directly. This server relays the call
// and keeps the API key out of the client bundle.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 8080;
const CTA_KEY = process.env.CTA_KEY || 'YOUR_CTA_KEY';
const CTA_BASE = 'http://lapi.transitchicago.com/api/1.0';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// Relay a CTA endpoint, injecting the key. Returns parsed JSON or an error shape.
async function proxyCta(endpoint, params) {
  const url = new URL(`${CTA_BASE}/${endpoint}`);
  url.searchParams.set('key', CTA_KEY);
  url.searchParams.set('outputType', 'JSON');
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: 502, body: { error: 'Bad upstream response', raw: text.slice(0, 500) } };
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/monitor.html' : pathname;
  const filePath = path.join(ROOT, path.normalize(rel));
  // Prevent path traversal outside ROOT.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Live train positions for one or more routes.
    // /api/positions?rt=red,blue,brn,g,org,p,pink,y
    if (pathname === '/api/positions') {
      const rt = searchParams.get('rt') || 'red,blue,brn,g,org,p,pink,y';
      const { status, body } = await proxyCta('ttpositions.aspx', { rt });
      return sendJson(res, status, body);
    }

    // Arrivals at a station (mapid) or single stop (stpid).
    // /api/arrivals?mapid=40380   or   /api/arrivals?stpid=30182
    if (pathname === '/api/arrivals') {
      const { status, body } = await proxyCta('ttarrivals.aspx', {
        mapid: searchParams.get('mapid'),
        stpid: searchParams.get('stpid'),
        max: searchParams.get('max'),
        rt: searchParams.get('rt'),
      });
      return sendJson(res, status, body);
    }

    // Follow a single train run end-to-end.
    // /api/follow?runnumber=910
    if (pathname === '/api/follow') {
      const { status, body } = await proxyCta('ttfollow.aspx', {
        runnumber: searchParams.get('runnumber'),
      });
      return sendJson(res, status, body);
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, 502, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`CTA monitor running -> http://localhost:${PORT}/`);
  console.log(`Proxying ${CTA_BASE} with key ${CTA_KEY.slice(0, 6)}…`);
});
