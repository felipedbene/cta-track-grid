// Build a compact Metra lines.geojson from Metra static GTFS.
// Metra's CSV has spaces after commas, so every field is trimmed.
// Same greedy branch-coverage + simplify approach as build_lines.mjs.
import fs from 'node:fs';
import readline from 'node:readline';

const DIR = '/tmp/metra_gtfs';
const OUT = '/Users/felipe/workspace/cta/public/metra.geojson';

const split = (line) => line.split(',').map((s) => s.trim());

// 1) routes.txt -> rail routes (route_type 2) + official color
const routeColor = new Map();
{
  const lines = fs.readFileSync(`${DIR}/routes.txt`, 'utf8').split('\n');
  const head = split(lines[0]);
  const iId = head.indexOf('route_id'), iType = head.indexOf('route_type'), iColor = head.indexOf('route_color');
  for (let i = 1; i < lines.length; i++) {
    const c = split(lines[i]);
    if (c.length <= iType) continue;
    if (c[iType] === '2') routeColor.set(c[iId], '#' + (c[iColor] || '888888'));
  }
}
console.log('metra routes:', routeColor.size);

// 2) trips.txt -> shape_id => route_id
const shapeRoute = new Map();
{
  const lines = fs.readFileSync(`${DIR}/trips.txt`, 'utf8').split('\n');
  const head = split(lines[0]);
  const iRoute = head.indexOf('route_id'), iShape = head.indexOf('shape_id');
  for (let i = 1; i < lines.length; i++) {
    const c = split(lines[i]);
    if (c.length <= iShape) continue;
    if (routeColor.has(c[iRoute]) && c[iShape]) shapeRoute.set(c[iShape], c[iRoute]);
  }
}
console.log('metra shape_ids:', shapeRoute.size);

// 3) shapes.txt -> ordered points
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
for (const arr of shapes.values()) arr.sort((a, b) => a.seq - b.seq);

// 4) greedy coverage by ~400m cells (Metra spans far; coarser grid)
const CELL = 0.004;
const cellKey = (p) => `${Math.round(p.lat / CELL)},${Math.round(p.lon / CELL)}`;
const byRoute = new Map();
for (const [id, route] of shapeRoute) {
  if (!shapes.has(id)) continue;
  if (!byRoute.has(route)) byRoute.set(route, []);
  const pts = shapes.get(id);
  byRoute.get(route).push({ id, pts, cells: new Set(pts.map(cellKey)) });
}

function simplify(pts) {
  const out = [];
  let last = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0 || i === pts.length - 1) { out.push([+p.lon.toFixed(5), +p.lat.toFixed(5)]); last = p; continue; }
    if (Math.hypot(p.lat - last.lat, p.lon - last.lon) > 0.0006) { out.push([+p.lon.toFixed(5), +p.lat.toFixed(5)]); last = p; }
  }
  return out;
}

const features = [];
const stats = [];
for (const [route, cands] of byRoute) {
  const covered = new Set();
  let picks = 0;
  while (picks < 8) {
    let best = null, gainBest = 0;
    for (const s of cands) {
      if (s.used) continue;
      let g = 0; for (const c of s.cells) if (!covered.has(c)) g++;
      if (g > gainBest) { gainBest = g; best = s; }
    }
    if (!best || gainBest < 5) break;
    best.used = true;
    for (const c of best.cells) covered.add(c);
    features.push({
      type: 'Feature',
      properties: { route, color: routeColor.get(route) },
      geometry: { type: 'LineString', coordinates: simplify(best.pts) },
    });
    picks++;
  }
  stats.push(`${route}: ${picks} shapes, ${covered.size} cells`);
}

fs.writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
console.log(stats.join('\n'));
console.log(`features: ${features.length}, file: ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB -> ${OUT}`);
