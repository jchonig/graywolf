// Uploaded map routes: operator-provided route lines (e.g. a Ride With
// GPS course exported as GPX) drawn on the live map. Persisted
// SERVER-SIDE (GET/POST/PUT/DELETE /api/map-routes) so they are shared
// across every device/browser pointed at this server -- same model as
// fixed-points-store.svelte.js. Uses .svelte.js so the $state rune
// drives the map layer's reactive refresh.
//
// load() is called when the map mounts and when the Maps settings page
// mounts, so both surfaces show the current server set.

import { api } from '../api.js';
import { routeFromApi, routeToApi } from './map-routes-api.js';

export const mapRoutesStore = (() => {
  let routes = $state([]);
  let loaded = $state(false);

  return {
    get routes() {
      return routes;
    },
    get loaded() {
      return loaded;
    },

    // Fetch the server set and replace the in-memory list. Malformed
    // rows are dropped, not fatal. On failure the previous list is kept
    // and the error is rethrown so the caller can surface it.
    async load() {
      const rows = (await api.get('/map-routes')) || [];
      routes = rows.map(routeFromApi).filter(Boolean);
      loaded = true;
      return routes;
    },

    // Create a route on the server, then append the persisted record
    // (with its server-assigned id + point count). Returns the route.
    async add({ name, color, geojson }) {
      const created = await api.post('/map-routes', routeToApi({ name, color, geojson }));
      const route = routeFromApi(created);
      if (route) routes = [...routes, route];
      return route;
    },

    // Update a route's name/color (geojson too, if given). PUT replaces
    // the whole record server-side, so we send the merged object.
    async update(id, patch) {
      const current = routes.find((r) => r.id === id);
      if (!current) return null;
      const merged = {
        name: patch.name ?? current.name,
        color: patch.color ?? current.color,
        geojson: patch.geojson ?? current.geojson,
      };
      const saved = await api.put(`/map-routes/${id}`, routeToApi(merged));
      const route =
        routeFromApi({ id, point_count: current.pointCount, ...saved }) || { ...current, ...merged };
      routes = routes.map((r) => (r.id === id ? route : r));
      return route;
    },

    // Delete a route on the server, then drop it locally.
    async remove(id) {
      await api.delete(`/map-routes/${id}`);
      routes = routes.filter((r) => r.id !== id);
    },
  };
})();
