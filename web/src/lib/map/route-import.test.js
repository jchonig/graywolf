import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser as XmlDOMParser } from '@xmldom/xmldom';
import { parseRouteFile as parse, simplifyRoute } from './route-import.js';

// The browser hands parseRouteFile the native DOMParser; under node:test
// we inject @xmldom/xmldom's. The onError no-op keeps expected parse
// failures from writing diagnostics to the test log.
class TestDOMParser extends XmlDOMParser {
  constructor() {
    super({ onError: () => {} });
  }
}
const parseRouteFile = (name, text) => parse(name, text, TestDOMParser);

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="Ride with GPS">
  <metadata><name>RFL 2026 Course</name></metadata>
  <trk>
    <name>RFL 2026 Course</name>
    <trkseg>
      <trkpt lat="42.4613514" lon="-76.5032365"><ele>250</ele></trkpt>
      <trkpt lat="42.4700000" lon="-76.5100000"></trkpt>
      <trkpt lat="42.4800000" lon="-76.5200000"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Course KML</name>
    <Placemark>
      <name>RFL KML Route</name>
      <LineString>
        <coordinates>
          -76.5032365,42.4613514,0 -76.5100000,42.4700000,0 -76.5200000,42.4800000,0
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;

const GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  properties: { name: 'GeoJSON Course' },
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[-76.5, 42.46], [-76.51, 42.47], [-76.52, 42.48]] },
    },
    {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [-76.5, 42.46] },
    },
  ],
});

test('parseRouteFile reads a GPX track', () => {
  const { name, geojson } = parseRouteFile('course.gpx', GPX);
  assert.equal(name, 'RFL 2026 Course');
  assert.equal(geojson.type, 'FeatureCollection');
  assert.equal(geojson.features.length, 1);
  assert.equal(geojson.features[0].geometry.type, 'LineString');
  assert.deepEqual(geojson.features[0].geometry.coordinates[0], [-76.5032365, 42.4613514]);
  assert.equal(geojson.features[0].geometry.coordinates.length, 3);
});

test('parseRouteFile reads a KML LineString', () => {
  const { name, geojson } = parseRouteFile('course.kml', KML);
  assert.equal(name, 'RFL KML Route');
  assert.equal(geojson.features[0].geometry.coordinates.length, 3);
  assert.deepEqual(geojson.features[0].geometry.coordinates[2], [-76.52, 42.48]);
});

test('parseRouteFile reads GeoJSON and keeps only line geometry', () => {
  const { name, geojson } = parseRouteFile('course.geojson', GEOJSON);
  assert.equal(name, 'GeoJSON Course');
  assert.equal(geojson.features.length, 1);
  assert.equal(geojson.features[0].geometry.type, 'LineString');
});

test('parseRouteFile falls back to the filename stem when unnamed', () => {
  const gpx = GPX.replace(/<name>[^<]*<\/name>/g, '');
  const { name } = parseRouteFile('My Ride.gpx', gpx);
  assert.equal(name, 'My Ride');
});

test('parseRouteFile sniffs format when the extension is missing', () => {
  assert.equal(parseRouteFile('blob', GEOJSON).geojson.features[0].geometry.type, 'LineString');
  assert.equal(parseRouteFile('blob', KML).geojson.features[0].geometry.coordinates.length, 3);
});

test('parseRouteFile throws a friendly error on garbage', () => {
  assert.throws(() => parseRouteFile('x.gpx', 'not xml at all'), /parse the GPX file/);
  assert.throws(() => parseRouteFile('x.gpx', '<gpx><trk><trkseg><trkpt lat="1"'), /parse the GPX file/);
  assert.throws(() => parseRouteFile('x.geojson', '{bad json'), /Invalid GeoJSON/);
  assert.throws(
    () => parseRouteFile('x.gpx', '<gpx><metadata><name>Empty</name></metadata></gpx>'),
    /No route line/,
  );
});

test('simplifyRoute keeps sparse routes unchanged', () => {
  const { geojson } = parseRouteFile('course.gpx', GPX);
  assert.equal(simplifyRoute(geojson), geojson);
});

test('simplifyRoute thins a dense collinear route', () => {
  const coords = [];
  for (let i = 0; i < 5000; i++) coords.push([-76 + i * 0.0001, 42 + i * 0.0001]);
  // add a real corner so at least 3 points must survive
  coords.push([-76 + 5000 * 0.0001, 42]);
  const dense = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }],
  };
  const out = simplifyRoute(dense, 0.0005);
  const n = out.features[0].geometry.coordinates.length;
  assert.ok(n >= 3 && n < 50, `expected heavy reduction, got ${n}`);
  // endpoints preserved
  assert.deepEqual(out.features[0].geometry.coordinates[0], coords[0]);
  assert.deepEqual(out.features[0].geometry.coordinates.at(-1), coords.at(-1));
});

test('simplifyRoute keeps a low-height long-base point that pure distance would drop', () => {
  // B sits only 0.00001deg off the A-C chord (well under the 0.001 tolerance
  // a distance-based simplifier would use), but A-B-C spans a long enough
  // base that the triangle's area is significant -- Visvalingam-Whyatt
  // weighs both, not perpendicular distance alone.
  const coords = [
    [-76, 42],
    [-75, 42.00001],
    [-74, 42],
  ];
  for (let i = 1; i <= 5000; i++) coords.push([-74 + i * 0.0001, 42]);
  coords.push([coords.at(-1)[0], 42.01]); // real corner so the tail survives

  const dense = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }],
  };
  const kept = simplifyRoute(dense, 0.001).features[0].geometry.coordinates;
  assert.ok(
    kept.some((p) => p[0] === -75 && p[1] === 42.00001),
    'expected the long-base point to survive on area, not just perpendicular distance',
  );
});
