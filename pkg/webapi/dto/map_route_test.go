package dto

import (
	"encoding/json"
	"strings"
	"testing"
)

func mkGeoJSON(t *testing.T, s string) json.RawMessage {
	t.Helper()
	if !json.Valid([]byte(s)) {
		t.Fatalf("test fixture is not valid JSON: %s", s)
	}
	return json.RawMessage(s)
}

func TestMapRouteRequestValidate(t *testing.T) {
	lineFC := `{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[-76.5,42.4],[-76.6,42.5]]}}]}`
	bareLine := `{"type":"LineString","coordinates":[[0,0],[1,1]]}`
	multiLine := `{"type":"MultiLineString","coordinates":[[[0,0],[1,1]],[[2,2],[3,3]]]}`
	geomColl := `{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[0,0]},{"type":"LineString","coordinates":[[0,0],[1,1]]}]}`
	pointOnly := `{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[0,0]}}]}`

	cases := []struct {
		name    string
		req     MapRouteRequest
		wantErr bool
	}{
		{"ok feature collection", MapRouteRequest{Name: "X", GeoJSON: mkGeoJSON(t, lineFC)}, false},
		{"ok bare LineString", MapRouteRequest{Name: "X", GeoJSON: mkGeoJSON(t, bareLine)}, false},
		{"ok MultiLineString", MapRouteRequest{Name: "X", GeoJSON: mkGeoJSON(t, multiLine)}, false},
		{"ok GeometryCollection with a line", MapRouteRequest{Name: "X", GeoJSON: mkGeoJSON(t, geomColl)}, false},
		{"ok explicit hex color", MapRouteRequest{Name: "X", Color: "#00FF00", GeoJSON: mkGeoJSON(t, bareLine)}, false},
		{"empty name", MapRouteRequest{Name: "  ", GeoJSON: mkGeoJSON(t, bareLine)}, true},
		{"bad color", MapRouteRequest{Name: "X", Color: "green", GeoJSON: mkGeoJSON(t, bareLine)}, true},
		{"missing geojson", MapRouteRequest{Name: "X"}, true},
		{"no line geometry", MapRouteRequest{Name: "X", GeoJSON: mkGeoJSON(t, pointOnly)}, true},
		{"lon out of range", MapRouteRequest{Name: "X", GeoJSON: mkGeoJSON(t, `{"type":"LineString","coordinates":[[-181,0],[0,0]]}`)}, true},
		{"lat out of range", MapRouteRequest{Name: "X", GeoJSON: mkGeoJSON(t, `{"type":"LineString","coordinates":[[0,0],[0,91]]}`)}, true},
		{"coordinate missing a component", MapRouteRequest{Name: "X", GeoJSON: mkGeoJSON(t, `{"type":"LineString","coordinates":[[0],[1,1]]}`)}, true},
		{"malformed json", MapRouteRequest{Name: "X", GeoJSON: json.RawMessage(`{"type":"LineString","coordinates":[[`)}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.req.Validate()
			if (err != nil) != c.wantErr {
				t.Fatalf("Validate() err=%v, wantErr=%v", err, c.wantErr)
			}
		})
	}
}

func TestMapRouteRequestValidateNonFiniteCoord(t *testing.T) {
	// NaN/Inf cannot appear in valid JSON, so json.Unmarshal into
	// [][]float64 rejects them first -- assert we still return an error.
	req := MapRouteRequest{Name: "X", GeoJSON: json.RawMessage(`{"type":"LineString","coordinates":[[0,0],[1e999,1]]}`)}
	if err := req.Validate(); err == nil {
		t.Fatal("expected an error for a non-finite coordinate")
	}
}

func TestMapRouteRequestValidateVertexCap(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"type":"LineString","coordinates":[`)
	for i := 0; i <= MaxRouteVertices; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`[0,0]`)
	}
	b.WriteString(`]}`)
	req := MapRouteRequest{Name: "X", GeoJSON: json.RawMessage(b.String())}
	err := req.Validate()
	if err == nil || !strings.Contains(err.Error(), "too many points") {
		t.Fatalf("expected a vertex-cap error, got %v", err)
	}
}

func TestMapRouteToModelAndBack(t *testing.T) {
	src := `{ "type": "LineString", "coordinates": [ [-76.5, 42.4], [-76.6, 42.5], [-76.7, 42.6] ] }`
	req := MapRouteRequest{Name: "  RFL Course  ", GeoJSON: json.RawMessage(src)}

	m := req.ToModel()
	if m.Name != "RFL Course" {
		t.Fatalf("name not trimmed: %q", m.Name)
	}
	if m.Color != DefaultRouteColor {
		t.Fatalf("color not defaulted: %q", m.Color)
	}
	if m.PointCount != 3 {
		t.Fatalf("point count = %d, want 3", m.PointCount)
	}
	if strings.ContainsAny(m.GeoJSON, " \n\t") {
		t.Fatalf("stored GeoJSON was not compacted: %q", m.GeoJSON)
	}

	m.ID = 9
	resp := MapRouteFromModel(m)
	if resp.ID != 9 || resp.Name != "RFL Course" || resp.PointCount != 3 {
		t.Fatalf("FromModel mismatch: %+v", resp)
	}
	var fc map[string]any
	if err := json.Unmarshal(resp.GeoJSON, &fc); err != nil {
		t.Fatalf("response GeoJSON not valid JSON: %v", err)
	}
	if fc["type"] != "LineString" {
		t.Fatalf("response GeoJSON type = %v", fc["type"])
	}
}

func TestMapRouteToUpdatePreservesID(t *testing.T) {
	req := MapRouteRequest{Name: "X", GeoJSON: json.RawMessage(`{"type":"LineString","coordinates":[[0,0],[1,1]]}`)}
	m := req.ToUpdate(42)
	if m.ID != 42 {
		t.Fatalf("ToUpdate id = %d, want 42", m.ID)
	}
}
