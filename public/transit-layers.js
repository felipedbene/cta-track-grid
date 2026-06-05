// Shared transit-map layers for the live monitor (index.html) and the replay
// scrubber (replay.html). The CTA 'L' / Metra / South Shore line geometry,
// station dots, landmark callouts, and the line-colour table live here ONCE so
// the two pages can't drift apart again. Load AFTER Leaflet (L) and ctaData.js
// (window.ctaStops). Exposes window.TransitLayers.
(function () {
  // CTA line colours / names / badge icons (keyed by Train Tracker route code).
  const LINES = {
    red:  { code: 'red',  name: 'Red',    color: '#ff2a2a', icon: 'images/RED.svg'  },
    blue: { code: 'blue', name: 'Blue',   color: '#3399ff', icon: 'images/BLUE.svg' },
    brn:  { code: 'brn',  name: 'Brown',  color: '#c0692f', icon: 'images/BRN.svg'  },
    g:    { code: 'g',    name: 'Green',  color: '#00cc44', icon: 'images/G.svg'    },
    org:  { code: 'org',  name: 'Orange', color: '#ff8800', icon: 'images/O.svg'    },
    p:    { code: 'p',    name: 'Purple', color: '#a64dff', icon: 'images/P.svg'    },
    pink: { code: 'pink', name: 'Pink',   color: '#ff55aa', icon: 'images/Pnk.svg'  },
    y:    { code: 'y',    name: 'Yellow', color: '#ffcc00', icon: 'images/Y.svg'    },
  };

  // NORAD landmark callouts (city core, neighborhoods/venues, Metra suburbs,
  // and the Indiana South Shore reach).
  const LANDMARKS = [
    { name: 'The Loop', lat: 41.8786, lon: -87.6298 },
    { name: "O'Hare · ORD", lat: 41.9786, lon: -87.9047 },
    { name: 'Midway · MDW', lat: 41.7868, lon: -87.7522 },
    { name: 'Navy Pier', lat: 41.8917, lon: -87.6086 },
    { name: 'Lake Michigan', lat: 41.93, lon: -87.58, water: true },
    { name: 'Wrigley Field', lat: 41.9484, lon: -87.6553 },
    { name: 'United Center', lat: 41.8807, lon: -87.6742 },
    { name: 'Soldier Field', lat: 41.8623, lon: -87.6167 },
    { name: 'McCormick Pl', lat: 41.8510, lon: -87.6160 },
    { name: 'Chinatown', lat: 41.8520, lon: -87.6320 },
    { name: 'Logan Sq', lat: 41.9265, lon: -87.7085 },
    { name: 'Hyde Park · UC', lat: 41.7943, lon: -87.5907 },
    { name: 'Bronzeville', lat: 41.8210, lon: -87.6190 },
    { name: 'Rogers Park', lat: 42.0100, lon: -87.6700 },
    { name: 'Garfield Pk', lat: 41.8860, lon: -87.7170 },
    { name: 'Indiana Dunes NP', lat: 41.6533, lon: -87.0524 },
    { name: 'Evanston', lat: 42.045, lon: -87.690, burb: true },
    { name: 'Oak Park', lat: 41.888, lon: -87.788, burb: true },
    { name: 'Skokie', lat: 42.036, lon: -87.740, burb: true },
    { name: 'Naperville', lat: 41.748, lon: -88.165, burb: true },
    { name: 'Aurora', lat: 41.761, lon: -88.315, burb: true },
    { name: 'Joliet', lat: 41.525, lon: -88.082, burb: true },
    { name: 'Elgin', lat: 42.037, lon: -88.281, burb: true },
    { name: 'Waukegan', lat: 42.363, lon: -87.845, burb: true },
    { name: 'Arlington Hts', lat: 42.088, lon: -87.981, burb: true },
    { name: 'Schaumburg', lat: 42.034, lon: -88.083, burb: true },
    { name: 'Geneva', lat: 41.888, lon: -88.305, burb: true },
    { name: 'Blue Island', lat: 41.657, lon: -87.680, burb: true },
    { name: 'Univ Park', lat: 41.445, lon: -87.717, burb: true },
    { name: 'Tinley Park', lat: 41.573, lon: -87.784, burb: true },
    { name: 'Lake Forest', lat: 42.259, lon: -87.840, burb: true },
    { name: 'Fox Lake', lat: 42.396, lon: -88.183, burb: true },
    { name: 'Kenosha, WI', lat: 42.585, lon: -87.821, burb: true },
    { name: 'Glenview', lat: 42.069, lon: -87.788, burb: true },
    { name: 'Des Plaines', lat: 42.033, lon: -87.883, burb: true },
    { name: 'Park Ridge', lat: 42.011, lon: -87.840, burb: true },
    { name: 'Palatine', lat: 42.118, lon: -88.034, burb: true },
    { name: 'Crystal Lake', lat: 42.241, lon: -88.316, burb: true },
    { name: 'Hinsdale', lat: 41.801, lon: -87.937, burb: true },
    { name: 'Downers Grv', lat: 41.808, lon: -88.011, burb: true },
    { name: 'La Grange', lat: 41.805, lon: -87.869, burb: true },
    { name: 'Lombard', lat: 41.880, lon: -88.008, burb: true },
    { name: 'Wheaton', lat: 41.866, lon: -88.107, burb: true },
    { name: 'Homewood', lat: 41.557, lon: -87.665, burb: true },
    { name: 'Hammond, IN', lat: 41.583, lon: -87.500, burb: true },
    { name: 'Gary, IN', lat: 41.604, lon: -87.336, burb: true },
    { name: 'Michigan City, IN', lat: 41.708, lon: -86.895, burb: true },
    { name: 'South Bend, IN', lat: 41.709, lon: -86.317, burb: true },
  ];

  // CTA 'L' + Metra + South Shore line geometry. Creates the 'lines' and 'metra'
  // panes and loads the three geojson files. opts.onMetraColors(route->color) is
  // invoked once metra.geojson resolves (used to tint Metra train markers).
  function addLineLayers(map, opts) {
    opts = opts || {};

    map.createPane('lines');
    const linePane = map.getPane('lines');
    linePane.style.zIndex = 250;                                  // above tiles(200), below overlay/markers
    linePane.style.filter = 'drop-shadow(0 0 3px rgba(0,255,170,0.5))';
    fetch('lines.geojson').then((r) => r.json()).then((geo) => {
      L.geoJSON(geo, {
        pane: 'lines',
        style: (f) => ({ color: f.properties.color, weight: 3, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }),
      }).addTo(map);
    }).catch(() => {});

    // Metra regional rail (static GTFS): dim + dashed, beneath the CTA 'L'.
    map.createPane('metra');
    const metraPane = map.getPane('metra');
    metraPane.style.zIndex = 240;
    metraPane.style.filter = 'drop-shadow(0 0 2px rgba(150,180,255,0.35))';
    fetch('metra.geojson').then((r) => r.json()).then((geo) => {
      const colors = {};
      for (const f of geo.features) colors[f.properties.route] = f.properties.color;
      L.geoJSON(geo, {
        pane: 'metra',
        style: (f) => ({ color: f.properties.color, weight: 1.6, opacity: 0.5, dashArray: '3 5', lineCap: 'round' }),
      }).addTo(map);
      if (opts.onMetraColors) opts.onMetraColors(colors);
    }).catch(() => {});

    // South Shore Line (NICTD): dashed regional geometry, same pane as Metra.
    fetch('southshore.geojson').then((r) => r.json()).then((geo) => {
      L.geoJSON(geo, {
        pane: 'metra',
        style: (f) => ({ color: f.properties.color, weight: 1.6, opacity: 0.55, dashArray: '3 5', lineCap: 'round' }),
      }).addTo(map);
    }).catch(() => {});
  }

  // Station dots from ctaData.js (dedupe by MAP_ID). Returns a
  // [{mapid, name, lat, lon}] index (used for nearest-station alerts).
  function plotStations(map, layer) {
    const stations = [], seen = new Set();
    for (const s of (window.ctaStops || [])) {
      if (seen.has(s.MAP_ID)) continue;
      seen.add(s.MAP_ID);
      const m = s.Location.match(/\(([-\d.]+),\s*([-\d.]+)\)/);
      if (!m) continue;
      stations.push({ mapid: s.MAP_ID, name: s.STATION_NAME || s.STATION_DESCRIPTIVE_NAME, lat: +m[1], lon: +m[2] });
      L.circleMarker([+m[1], +m[2]], {
        radius: 2.2, color: '#00ffaa', weight: 1, opacity: 0.85, fillColor: '#00ffaa', fillOpacity: 0.3,
      }).bindTooltip(s.STATION_DESCRIPTIVE_NAME, { direction: 'top', opacity: 0.9 }).addTo(layer || map);
    }
    return stations;
  }

  function plotLandmarks(map) {
    for (const lm of LANDMARKS) {
      L.marker([lm.lat, lm.lon], {
        interactive: false, zIndexOffset: 500,
        icon: L.divIcon({
          className: 'landmark' + (lm.water ? ' water' : lm.burb ? ' burb' : ''), iconSize: [8, 8], iconAnchor: [4, 4],
          html: (lm.water ? '' : '<div class="lm-ring"></div>') + `<div class="lm-label">${lm.name}</div>`,
        }),
      }).addTo(map);
    }
  }

  window.TransitLayers = { LINES, LANDMARKS, addLineLayers, plotStations, plotLandmarks };
})();
