// Pure load/merge logic for the Live Map layer toggles. No runes, no DOM, no
// localStorage -- so it is unit-testable under `node --test`. LiveMapV2.svelte
// wraps this with $state and the actual localStorage read/write (mirrors the
// radar-frames-core.js / radar-frames.svelte.js split).
//
// The toggles are a per-browser preference persisted as one JSON blob under the
// gw_map_layer_toggles key, so unchecking e.g. Trails or Fixed Points survives
// navigating away and back.

// Default visibility for every Live Map layer toggle. All display layers start
// on; the RF reachability filters start off.
export const LAYER_TOGGLES_DEFAULTS = {
  stations: true,
  trails: true,
  weather: true,
  myPosition: true,
  fixedPoints: true,
  routes: true,
  // Per-route visibility, keyed by server route id. A route id absent
  // from this map is treated as visible, so newly uploaded routes show
  // by default. Persisted alongside the other toggles.
  routeVisibility: {},
  fronts: true,
  directRxOnly: false,
  rfOnly: false,
  directRxHeatmap: false,
  directRxHeatmapOpacity: 0.8,
};

export const LAYER_TOGGLES_KEY = 'gw_map_layer_toggles';

// Parse a persisted toggle blob into a complete toggle set. Saved values are
// merged OVER the defaults so a toggle added in a later version picks up its
// default instead of becoming undefined, and a stale key from an old version is
// harmlessly ignored by consumers. Missing or corrupt input yields a fresh copy
// of the defaults. Always returns a new object (never the shared defaults).
export function parseLayerToggles(raw) {
  const fresh = () => ({ ...LAYER_TOGGLES_DEFAULTS, routeVisibility: {} });
  if (!raw) return fresh();
  try {
    const saved = JSON.parse(raw);
    if (saved == null || typeof saved !== 'object') return fresh();
    const merged = { ...fresh(), ...saved };
    // routeVisibility is a nested object; make sure it is always a plain
    // own object (never the shared defaults reference, never a non-object
    // from a corrupt blob) so in-place reads/writes stay isolated.
    merged.routeVisibility =
      saved.routeVisibility && typeof saved.routeVisibility === 'object' ? { ...saved.routeVisibility } : {};
    return merged;
  } catch {
    return fresh();
  }
}
