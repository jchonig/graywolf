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
//
// Dense tracks are thinned with Visvalingam-Whyatt (see simplifyRoute
// below), not Ramer-Douglas-Peucker -- suggested by @pflarue on the
// original PR as a better match for how a simplified track "should" look,
// since it drops points by the area they contribute rather than pure
// perpendicular distance.

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

// simplifyRoute runs Visvalingam-Whyatt over every LineString in the
// FeatureCollection when the total vertex count is large, to keep the
// stored/rendered payload reasonable. Sparse routes are returned as-is.
// `toleranceDeg` keeps the same linear-distance units the caller picks
// (e.g. the settings-card slider); it's squared internally to compare
// against triangle *area*, per the usual VW convention.
export function simplifyRoute(geojson, toleranceDeg = 0.00005) {
  if (!geojson || !Array.isArray(geojson.features)) return geojson;
  if (countVerticesIn(geojson.features) <= SIMPLIFY_ABOVE) return geojson;
  const areaThreshold = toleranceDeg * toleranceDeg;
  return {
    type: 'FeatureCollection',
    features: geojson.features.map((f) => ({
      type: 'Feature',
      properties: f.properties || {},
      geometry: {
        type: 'LineString',
        coordinates: visvalingamWhyatt(f.geometry.coordinates, areaThreshold),
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

// Visvalingam-Whyatt with planar (lon/lat) triangle area -- tends to match
// human expectations of a simplified track better than Ramer-Douglas-Peucker
// (which can leave visually-insignificant zigzags because it only looks at
// perpendicular distance, not the area a point actually contributes). The
// small distortion away from the equator is irrelevant at simplification
// tolerances.
//
// Classic effective-area elimination: repeatedly drop the point whose
// triangle (with its current neighbors) has the smallest area, carrying
// forward the max area removed so far as each point's "effective area" (a
// point removed early because it was locally flat can still be less
// significant than one removed later, so effective area must be
// non-decreasing). A point survives iff its effective area is >= the
// threshold. Neighbor bookkeeping is a doubly linked list over indices; the
// heap is lazy (stale entries are dropped on pop) so no decrease-key is
// needed. O(n log n).
function visvalingamWhyatt(points, areaThreshold) {
  const n = Array.isArray(points) ? points.length : 0;
  if (n < 3) return (points || []).slice();

  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const area = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1;
  }
  next[n - 1] = -1;

  const removed = new Uint8Array(n);
  const heap = new MinHeap();
  for (let i = 1; i < n - 1; i++) {
    area[i] = triangleArea(points[i - 1], points[i], points[i + 1]);
    heap.push(area[i], i);
  }

  let maxAreaSoFar = 0;
  while (heap.size() > 0) {
    const [a, i] = heap.pop();
    // Skip stale entries -- superseded by a later push for the same index,
    // or the index was already processed. A value check alone (a !==
    // area[i]) isn't enough: runs of exactly-collinear points share area 0,
    // so a stale zero-area entry can coincidentally match the current
    // area[i] and slip through, reprocessing an already-removed node and
    // growing the heap without bound.
    if (removed[i] || a !== area[i]) continue;
    removed[i] = 1;

    const effective = a < maxAreaSoFar ? maxAreaSoFar : a;
    maxAreaSoFar = effective;
    area[i] = effective;

    const p = prev[i];
    const nx = next[i];
    next[p] = nx;
    prev[nx] = p;

    if (p !== 0) {
      area[p] = triangleArea(points[prev[p]], points[p], points[nx]);
      heap.push(area[p], p);
    }
    if (nx !== n - 1) {
      area[nx] = triangleArea(points[p], points[nx], points[next[nx]]);
      heap.push(area[nx], nx);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (area[i] >= areaThreshold) out.push(points[i]);
  return out;
}

function triangleArea(a, b, c) {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

// Lazy binary min-heap of (area, index) pairs. "Lazy" because updating a
// point's area just pushes a new entry instead of hunting for and
// decreasing the old one; visvalingamWhyatt discards a popped entry whose
// area no longer matches the authoritative `area[i]`.
class MinHeap {
  constructor() {
    this.areas = [];
    this.indices = [];
  }

  size() {
    return this.areas.length;
  }

  push(a, i) {
    const areas = this.areas;
    const indices = this.indices;
    let pos = areas.length;
    areas.push(a);
    indices.push(i);
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (areas[parent] <= areas[pos]) break;
      [areas[parent], areas[pos]] = [areas[pos], areas[parent]];
      [indices[parent], indices[pos]] = [indices[pos], indices[parent]];
      pos = parent;
    }
  }

  pop() {
    const areas = this.areas;
    const indices = this.indices;
    const topArea = areas[0];
    const topIndex = indices[0];
    const lastArea = areas.pop();
    const lastIndex = indices.pop();
    if (areas.length > 0) {
      areas[0] = lastArea;
      indices[0] = lastIndex;
      let pos = 0;
      const len = areas.length;
      for (;;) {
        const left = 2 * pos + 1;
        const right = left + 1;
        let smallest = pos;
        if (left < len && areas[left] < areas[smallest]) smallest = left;
        if (right < len && areas[right] < areas[smallest]) smallest = right;
        if (smallest === pos) break;
        [areas[smallest], areas[pos]] = [areas[pos], areas[smallest]];
        [indices[smallest], indices[pos]] = [indices[pos], indices[smallest]];
        pos = smallest;
      }
    }
    return [topArea, topIndex];
  }
}
