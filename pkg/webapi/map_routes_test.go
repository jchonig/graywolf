package webapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/chrissnell/graywolf/pkg/webapi/dto"
)

const sampleRouteGeoJSON = `{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"LineString","coordinates":[[-76.50,42.46],[-76.51,42.47],[-76.52,42.48]]}}]}`

func mapRoutesMux(t *testing.T) *http.ServeMux {
	t.Helper()
	srv, _ := newTestServer(t)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)
	return mux
}

func postRoute(t *testing.T, mux *http.ServeMux, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/map-routes", strings.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestMapRouteCreateListGetDelete(t *testing.T) {
	mux := mapRoutesMux(t)

	rec := postRoute(t, mux, `{"name":"RFL Course","color":"","geojson":`+sampleRouteGeoJSON+`}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var created dto.MapRouteResponse
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.ID == 0 || created.Name != "RFL Course" {
		t.Fatalf("create round-trip mismatch: %+v", created)
	}
	if created.Color != dto.DefaultRouteColor {
		t.Fatalf("expected default color %q, got %q", dto.DefaultRouteColor, created.Color)
	}
	if created.PointCount != 3 {
		t.Fatalf("expected point_count 3, got %d", created.PointCount)
	}

	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/map-routes/%d", created.ID), nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: expected 200, got %d", rec.Code)
	}
	var got dto.MapRouteResponse
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	var fc map[string]any
	if err := json.Unmarshal(got.GeoJSON, &fc); err != nil {
		t.Fatalf("stored geojson is not valid JSON: %v", err)
	}
	if fc["type"] != "FeatureCollection" {
		t.Fatalf("geojson round-trip mismatch: %v", fc["type"])
	}

	req = httptest.NewRequest(http.MethodGet, "/api/map-routes", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var list []dto.MapRouteResponse
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != created.ID {
		t.Fatalf("list mismatch: %+v", list)
	}

	req = httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/map-routes/%d", created.ID), nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: expected 204, got %d", rec.Code)
	}
}

func TestMapRouteUpdate(t *testing.T) {
	mux := mapRoutesMux(t)

	rec := postRoute(t, mux, `{"name":"A","geojson":`+sampleRouteGeoJSON+`}`)
	var created dto.MapRouteResponse
	_ = json.NewDecoder(rec.Body).Decode(&created)

	body := `{"name":"Renamed","color":"#00ff00","geojson":` + sampleRouteGeoJSON + `}`
	req := httptest.NewRequest(http.MethodPut, fmt.Sprintf("/api/map-routes/%d", created.ID), strings.NewReader(body))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update: expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var updated dto.MapRouteResponse
	_ = json.NewDecoder(rec.Body).Decode(&updated)
	if updated.ID != created.ID || updated.Name != "Renamed" || updated.Color != "#00ff00" {
		t.Fatalf("update round-trip mismatch: %+v", updated)
	}
}

func TestMapRouteValidationRejections(t *testing.T) {
	mux := mapRoutesMux(t)

	cases := []struct {
		name string
		body string
	}{
		{"empty name", `{"name":"","geojson":` + sampleRouteGeoJSON + `}`},
		{"bad color", `{"name":"X","color":"red","geojson":` + sampleRouteGeoJSON + `}`},
		{"missing geojson", `{"name":"X"}`},
		{"no line geometry", `{"name":"X","geojson":{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[-76.5,42.4]}}]}}`},
		{"lon out of range", `{"name":"X","geojson":{"type":"LineString","coordinates":[[-200,10],[-201,11]]}}`},
		{"malformed json", `{"name":"X","geojson":{"type":"LineString","coordinates":[[`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := postRoute(t, mux, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestMapRouteBodyTooLarge(t *testing.T) {
	mux := mapRoutesMux(t)

	var sb strings.Builder
	sb.WriteString(`{"name":"Huge","geojson":{"type":"LineString","coordinates":[`)
	// ~10 MiB of coordinate pairs, over maxRouteRequestBytes (8 MiB), so
	// the MaxBytesReader trips during decode before validation runs.
	for i := 0; i < 850_000; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString("[-76.5,42.4]")
	}
	sb.WriteString(`]}}`)

	rec := postRoute(t, mux, sb.String())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "too large") {
		t.Fatalf("expected 'too large' message, got %s", rec.Body.String())
	}
}
