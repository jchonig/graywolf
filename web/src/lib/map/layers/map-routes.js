// Map-routes layer (MapLibre): one GeoJSON line layer that draws every
// visible uploaded route. Each route contributes one or more LineString
// features carrying its `color` (read by a paint expression) and `id`.
//
// refresh() is the imperative entry point; LiveMapV2 wires it to a
// $effect that tracks the routes store and the per-route visibility
// map. MapLibre canvas layers render below DOM station markers, so the
// route line naturally sits beneath station icons.

const SOURCE_ID = 'gw-map-routes';
const LAYER_ID = 'gw-map-routes-line';

// mountMapRoutesLayer(map, getRoutes, isRouteVisible)
//  - getRoutes()      -> array of { id, color, geojson }
//  - isRouteVisible(id) -> boolean (default true); a route is drawn
//    only when this returns a value other than false.
export function mountMapRoutesLayer(map, getRoutes, isRouteVisible = () => true) {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }
  if (!map.getLayer(LAYER_ID)) {
    map.addLayer({
      id: LAYER_ID,
      type: 'line',
      source: SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 4,
        'line-opacity': 0.85,
      },
    });
  }

  function refresh() {
    const routes = getRoutes();
    if (!routes) return;
    const features = [];
    for (const route of routes) {
      if (isRouteVisible(route.id) === false) continue;
      for (const coords of extractLines(route.geojson)) {
        if (coords.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { id: route.id, color: route.color || '#e11d48' },
        });
      }
    }
    map.getSource(SOURCE_ID)?.setData({ type: 'FeatureCollection', features });
  }

  function setVisible(visible) {
    if (map.getLayer(LAYER_ID)) {
      map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'visible' : 'none');
    }
  }

  function destroy() {
    // Parent route's onDestroy runs after the map shell's, so the map
    // may already be torn down -- guard like the other layers do.
    try {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    } catch {
      /* map already removed */
    }
  }

  return { refresh, setVisible, destroy };
}

function extractLines(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  switch (node.type) {
    case 'FeatureCollection':
      (node.features || []).forEach((f) => extractLines(f, out));
      break;
    case 'Feature':
      extractLines(node.geometry, out);
      break;
    case 'GeometryCollection':
      (node.geometries || []).forEach((g) => extractLines(g, out));
      break;
    case 'LineString':
      if (Array.isArray(node.coordinates)) out.push(node.coordinates);
      break;
    case 'MultiLineString':
      (node.coordinates || []).forEach((line) => out.push(line));
      break;
    default:
      break;
  }
  return out;
}
