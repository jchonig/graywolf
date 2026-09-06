import test from 'node:test';
import assert from 'node:assert/strict';
import { routeFromApi, routeToApi, DEFAULT_ROUTE_COLOR } from './map-routes-api.js';

const fc = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-76.5, 42.4], [-76.6, 42.5]] } },
  ],
};

test('routeFromApi maps a server record to the client shape', () => {
  const r = routeFromApi({ id: 3, name: 'RFL', color: '#00ff00', point_count: 2, geojson: fc });
  assert.deepEqual(r, { id: 3, name: 'RFL', color: '#00ff00', pointCount: 2, geojson: fc });
});

test('routeFromApi falls back to the default color for a bad color', () => {
  const r = routeFromApi({ id: 1, name: 'x', color: 'red', geojson: fc });
  assert.equal(r.color, DEFAULT_ROUTE_COLOR);
  assert.equal(r.pointCount, 0);
});

test('routeFromApi drops malformed records (null)', () => {
  assert.equal(routeFromApi(null), null);
  assert.equal(routeFromApi({ id: 1, name: 'x', geojson: { type: 'Point', coordinates: [0, 0] } }), null);
  assert.equal(routeFromApi({ id: 1, name: 5, geojson: fc }), null);
});

test('routeToApi normalizes the request body', () => {
  assert.deepEqual(routeToApi({ name: '  RFL  ', color: '#abcdef', geojson: fc }), {
    name: 'RFL',
    color: '#abcdef',
    geojson: fc,
  });
  assert.equal(routeToApi({ name: 'x', color: 'nope', geojson: fc }).color, '');
});
