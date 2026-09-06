// route-import.js -- parse an uploaded route file (GPX, KML, or GeoJSON)
// into a GeoJSON FeatureCollection of LineStrings plus a display name.
//
// GPX/KML parsing is delegated to @tmcw/togeojson, which needs a DOM
// Document. In the browser that comes from the native DOMParser; the
// unit tests inject @xmldom/xmldom's DOMParser via the third argument.
// togeojson output is then normalized to LineString-only features so
// the layer, simplifier, and server validation only deal with one
// geometry type. Waypoints, elevation, timestamps, and styling are
// dropped -- the map overlay only needs the line.

import { gpx, kml } from '@tmcw/togeojson';

const SIMPLIFY_ABOVE = 2000; // only simplify routes denser than this

// parseRouteFile detects the format from the extension (falling back to
// a content sniff) and returns { name, geojson }. Throws a friendly
// Error if no route line can be found. `DomParser` defaults to the
// browser's global; tests pass one explicitly.
export function parseRouteFile(filename, text, DomParser = globalThis.DOMParser) {
  const base = String(filename).split(/[\\/]/).pop() || '';
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  const sniff = String(text).trimStart();

  let fc;
  if (ext === 'geojson' || ext === 'json' || (!ext && sniff.startsWith('{'))) {
    fc = parseGeoJSONText(text);
  } else {
    if (typeof DomParser !== 'function') {
      throw new Error('XML parsing is unavailable in this environment');
    }
    const label = ext ? ext.toUpperCase() : 'XML';
    let doc;
    try {
      doc = new DomParser().parseFromString(text, 'application/xml');
    } catch {
      // @xmldom/xmldom throws on malformed input.
      throw new Error(`Could not parse the ${label} file`);
    }
    // The browser's DOMParser reports errors as a <parsererror> node
    // rather than throwing.
    const perr = doc && doc.getElementsByTagName && doc.getElementsByTagName('parsererror')[0];
    if (perr || !doc || !doc.documentElement) {
      throw new Error(`Could not parse the ${label} file`);
    }
    fc = ext === 'kml' || (!ext && /<kml[\s>]/i.test(sniff)) ? kml(doc) : gpx(doc);
  }

  const features = toLineFeatures(fc);
  if (countVerticesIn(features) < 2) {
    throw new Error('No route line found in file');
  }
  const name = (pickName(fc) || stripExt(filename) || 'Route').trim() || 'Route';
  return { name, geojson: { type: 'FeatureCollection', features } };
}

// simplifyRoute runs Ramer-Douglas-Peucker over every LineString in the
// FeatureCollection when the total vertex count is large, to keep the
// stored/rendered payload reasonable. Sparse routes are returned as-is.
export function simplifyRoute(geojson, toleranceDeg = 0.00005) {
  if (!geojson || !Array.isArray(geojson.features)) return geojson;
  if (countVerticesIn(geojson.features) <= SIMPLIFY_ABOVE) return geojson;
  return {
    type: 'FeatureCollection',
    features: geojson.features.map((f) => ({
      type: 'Feature',
      properties: f.properties || {},
      geometry: {
        type: 'LineString',
        coordinates: rdp(f.geometry.coordinates, toleranceDeg),
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

// toLineFeatures walks any GeoJSON node and returns a flat list of
// LineString Features -- one per LineString, one per MultiLineString
// segment. Non-line geometry is ignored. Coordinates are sanitized to
// finite [lon, lat] pairs.
function toLineFeatures(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  switch (node.type) {
    case 'FeatureCollection':
      (node.features || []).forEach((f) => toLineFeatures(f, out));
      break;
    case 'Feature':
      toLineFeatures(node.geometry, out);
      break;
    case 'GeometryCollection':
      (node.geometries || []).forEach((g) => toLineFeatures(g, out));
      break;
    case 'LineString':
      pushLine(out, node.coordinates);
      break;
    case 'MultiLineString':
      (node.coordinates || []).forEach((line) => pushLine(out, line));
      break;
    default:
      break;
  }
  return out;
}

function pushLine(out, coords) {
  const clean = sanitizePositions(coords);
  if (clean.length >= 2) {
    out.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: clean } });
  }
}

function sanitizePositions(coords) {
  const out = [];
  if (!Array.isArray(coords)) return out;
  for (const p of coords) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
  }
  return out;
}

function parseGeoJSONText(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid GeoJSON: ${err.message}`);
  }
}

// pickName pulls a display name from the parsed document: a track/route
// name (togeojson puts it on the feature), else a top-level name.
function pickName(fc) {
  if (!fc || typeof fc !== 'object') return '';
  if (fc.properties && typeof fc.properties.name === 'string') return fc.properties.name;
  if (typeof fc.name === 'string') return fc.name;
  const named = (fc.features || []).find((f) => f && f.properties && typeof f.properties.name === 'string');
  return named ? named.properties.name : '';
}

function countVerticesIn(features) {
  return (features || []).reduce(
    (n, f) => n + (f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates.length : 0),
    0,
  );
}

function stripExt(filename) {
  const base = String(filename).split(/[\\/]/).pop() || '';
  return base.replace(/\.[^.]+$/, '');
}

// Ramer-Douglas-Peucker with planar (lon/lat) perpendicular distance --
// good enough to thin a route line; the small distortion away from the
// equator is irrelevant at simplification tolerances.
function rdp(points, epsilon) {
  if (!Array.isArray(points) || points.length < 3) return (points || []).slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = 0;
    let idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDistance(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (maxDist > epsilon && idx !== -1) {
      keep[idx] = 1;
      stack.push([start, idx], [idx, end]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function perpDistance(p, a, b) {
  const x = p[0];
  const y = p[1];
  const x1 = a[0];
  const y1 = a[1];
  const x2 = b[0];
  const y2 = b[1];
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(x - cx, y - cy);
}
