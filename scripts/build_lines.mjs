// Build a compact rail-only lines.geojson from CTA GTFS.
// Strategy: per route, greedily select the set of shapes that covers the most
// new ground (branches included) with minimal overlap, then simplify points.
import fs from 'node:fs';
import readline from 'node:readline';

const DIR = '/tmp/cta_gtfs';
const OUT = '/Users/felipe/workspace/cta/public/lines.geojson';

// GTFS route_id -> [our key, vivid color]
const MAP = {
  Red: ['red', '#ff2a2a'], Blue: ['blue', '#3399ff'], Brn: ['brn', '#c0692f'],
  G: ['g', '#00cc44'], Org: ['org', '#ff8800'], P: ['p', '#a64dff'],
  Pink: ['pink', '#ff55aa'], Y: ['y', '#ffcc00'],
};
const RAIL = new Set(Object.keys(MAP));

// 1) trips.txt -> shape_id => route_id (rail only)
const shapeRoute = new Map();
for (const line of fs.readFileSync(`${DIR}/trips.txt`, 'utf8').split('\n')) {
  const c = line.split(',');
  if (c.length < 6) continue;
  const route = c[0], shape = c[5];
  if (RAIL.has(route) && shape) shapeRoute.set(shape, route);
}
console.log('rail shape_ids:', shapeRoute.size);

// 2) shapes.txt (52MB) -> ordered points for rail shapes only
const shapes = new Map(); // shape_id -> [{seq,lat,lon}]
await new Promise((resolve) => {
  const rl = readline.createInterface({ input: fs.createReadStream(`${DIR}/shapes.txt`) });
  let first = true;
  rl.on('line', (line) => {
    if (first) { first = false; return; }
    const c = line.split(',');
    const id = c[0];
    if (!shapeRoute.has(id)) return;
    if (!shapes.has(id)) shapes.set(id, []);
    shapes.get(id).push({ seq: +c[3], lat: +c[1], lon: +c[2] });
  });
  rl.on('close', resolve);
});
for (const arr of shapes.values()) arr.sort((a, b) => a.seq - b.seq);

// 3) per route, greedy coverage by ~250m grid cells
const CELL = 0.0025;
const cellKey = (p) => `${Math.round(p.lat / CELL)},${Math.round(p.lon / CELL)}`;
const byRoute = new Map();
for (const [id, route] of shapeRoute) {
  if (!shapes.has(id)) continue;
  if (!byRoute.has(route)) byRoute.set(route, []);
  const pts = shapes.get(id);
  byRoute.get(route).push({ id, pts, cells: new Set(pts.map(cellKey)) });
}

// 4) simplify: keep endpoints + points spaced > ~40m
function simplify(pts) {
  const out = [];
  let last = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0 || i === pts.length - 1) { out.push([+p.lon.toFixed(5), +p.lat.toFixed(5)]); last = p; continue; }
    const d = Math.hypot(p.lat - last.lat, p.lon - last.lon);
    if (d > 0.0004) { out.push([+p.lon.toFixed(5), +p.lat.toFixed(5)]); last = p; }
  }
  return out;
}

const features = [];
const stats = [];
for (const [route, cands] of byRoute) {
  const [key, color] = MAP[route];
  const covered = new Set();
  let picks = 0;
  while (picks < 10) {
    let best = null, bestGain = 0;
    for (const s of cands) {
      if (s.used) continue;
      let gain = 0;
      for (const c of s.cells) if (!covered.has(c)) gain++;
      if (gain > bestGain) { bestGain = gain; best = s; }
    }
    if (!best || bestGain < 6) break;
    best.used = true;
    for (const c of best.cells) covered.add(c);
    features.push({
      type: 'Feature',
      properties: { route: key, color },
      geometry: { type: 'LineString', coordinates: simplify(best.pts) },
    });
    picks++;
  }
  stats.push(`${route}: ${picks} shapes, ${covered.size} cells`);
}

fs.writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
const bytes = fs.statSync(OUT).size;
console.log(stats.join('\n'));
console.log(`features: ${features.length}, file: ${(bytes / 1024).toFixed(1)} KB -> ${OUT}`);
