// Build public/southshore.geojson from NICTD South Shore Line static GTFS.
//
// The South Shore (NICTD) is a separate Indiana agency from Metra/CTA. Two rail
// "corridors" share a downtown trunk: so_shore (Lakeshore, orange) runs
// Millennium Station -> South Bend Airport; mo_co (Monon, red) is the West Lake
// branch toward Dyer. Each corridor has dozens of near-identical shape variants;
// we keep the longest shape per route as its representative line, then simplify.
//
// Refresh the source first:
//   mkdir -p /tmp/ss_gtfs && cd /tmp/ss_gtfs \
//     && curl -sSL https://s3.amazonaws.com/etatransit.gtfs/southshore.etaspot.net/gtfs.zip -o g.zip \
//     && unzip -o g.zip
//   node scripts/build_southshore.mjs
import fs from 'node:fs';
import readline from 'node:readline';

const DIR = '/tmp/ss_gtfs';
const OUT = '/Users/felipe/workspace/cta/public/southshore.geojson';

// South Shore CSV wraps fields in double quotes (no internal commas), so a plain
// comma split + quote strip is safe across every file here.
const split = (line) => line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));

// 1) routes.txt -> rail routes (route_type 2): id => { color, name }
const routes = new Map();
{
  const lines = fs.readFileSync(`${DIR}/routes.txt`, 'utf8').split('\n');
  const head = split(lines[0]);
  const iId = head.indexOf('route_id'), iType = head.indexOf('route_type');
  const iColor = head.indexOf('route_color'), iName = head.indexOf('route_long_name');
  for (let i = 1; i < lines.length; i++) {
    const c = split(lines[i]);
    if (c.length <= iType || c[iType] !== '2') continue;
    routes.set(c[iId], { color: '#' + (c[iColor] || 'F6931C'), name: c[iName] || c[iId] });
  }
}
console.log('south shore rail routes:', [...routes.keys()].join(', '));

// 2) trips.txt -> which shape_ids belong to each route
const shapeRoute = new Map();
{
  const lines = fs.readFileSync(`${DIR}/trips.txt`, 'utf8').split('\n');
  const head = split(lines[0]);
  const iRoute = head.indexOf('route_id'), iShape = head.indexOf('shape_id');
  for (let i = 1; i < lines.length; i++) {
    const c = split(lines[i]);
    if (c.length <= iShape) continue;
    if (routes.has(c[iRoute]) && c[iShape]) shapeRoute.set(c[iShape], c[iRoute]);
  }
}

// 3) shapes.txt -> ordered points per shape_id (only shapes we care about)
const shapes = new Map();
await new Promise((resolve) => {
  const rl = readline.createInterface({ input: fs.createReadStream(`${DIR}/shapes.txt`) });
  let first = true;
  rl.on('line', (line) => {
    if (first) { first = false; return; }
    const c = split(line);
    const id = c[0];
    if (!shapeRoute.has(id)) return;
    if (!shapes.has(id)) shapes.set(id, []);
    shapes.get(id).push({ seq: +c[3], lat: +c[1], lon: +c[2] });
  });
  rl.on('close', resolve);
});
for (const pts of shapes.values()) pts.sort((a, b) => a.seq - b.seq);

// 4) longest shape per route = its representative full-length geometry
const best = new Map();   // route_id -> points[]
for (const [shapeId, pts] of shapes) {
  const route = shapeRoute.get(shapeId);
  if (!best.has(route) || pts.length > best.get(route).length) best.set(route, pts);
}

// 5) Douglas-Peucker simplify (epsilon ~ 60m in degrees) to shrink the file
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  let dmax = 0, idx = 0;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perp(pts[i], a, b);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > eps) {
    const left = rdp(pts.slice(0, idx + 1), eps);
    const right = rdp(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}
function perp(p, a, b) {
  const x = p.lon, y = p.lat, x1 = a.lon, y1 = a.lat, x2 = b.lon, y2 = b.lat;
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = ((x - x1) * dx + (y - y1) * dy) / len2;
  const px = x1 + t * dx, py = y1 + t * dy;
  return Math.hypot(x - px, y - py);
}

const features = [];
for (const [route, pts] of best) {
  const meta = routes.get(route);
  const simplified = rdp(pts, 0.0006);
  features.push({
    type: 'Feature',
    properties: { route, name: meta.name, color: meta.color },
    geometry: { type: 'LineString', coordinates: simplified.map((p) => [+p.lon.toFixed(5), +p.lat.toFixed(5)]) },
  });
  console.log(`${route} (${meta.name}): ${pts.length} -> ${simplified.length} pts`);
}

fs.writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
