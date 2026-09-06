// Pure mappers between the server's map-route JSON and the shape the map
// layer + settings UI consume. Kept free of DOM and network so they are
// unit-tested directly. See map-routes-store.svelte.js for the stateful
// store that uses them.

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_ROUTE_COLOR = '#e11d48';

function isLineGeoJSON(gj) {
  return (
    gj &&
    typeof gj === 'object' &&
    (gj.type === 'FeatureCollection' ||
      gj.type === 'Feature' ||
      gj.type === 'GeometryCollection' ||
      gj.type === 'LineString' ||
      gj.type === 'MultiLineString')
  );
}

// routeFromApi converts one server record into the client shape, or
// returns null for a malformed record so a single bad row can't crash
// the layer.
export function routeFromApi(r) {
  if (!r || typeof r.name !== 'string' || !isLineGeoJSON(r.geojson)) {
    return null;
  }
  return {
    id: r.id,
    name: r.name,
    color: HEX_COLOR.test(r.color || '') ? r.color : DEFAULT_ROUTE_COLOR,
    pointCount: Number.isFinite(r.point_count) ? r.point_count : 0,
    geojson: r.geojson,
  };
}

// routeToApi converts a client route (import result or an edit) into the
// POST/PUT body the server expects. An empty/invalid color is sent as ""
// so the server applies its default.
export function routeToApi({ name, color, geojson }) {
  return {
    name: (name || '').trim(),
    color: HEX_COLOR.test(color || '') ? color : '',
    geojson,
  };
}
