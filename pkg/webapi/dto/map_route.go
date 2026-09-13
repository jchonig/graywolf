package dto

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"

	"github.com/chrissnell/graywolf/pkg/configstore"
)

// DefaultRouteColor is applied when a MapRouteRequest omits color. It
// mirrors the configstore column default. Chosen to avoid the Americana
// basemap's road colors and the APRS trail palette's hues (see
// MapsSettings.svelte's ROUTE_PALETTE).
const DefaultRouteColor = "#7ca824"

// Route upload sanity caps. MaxRouteGeoJSONBytes bounds the serialized
// GeoJSON document; MaxRouteVertices bounds the total number of line
// vertices across every LineString/MultiLineString in it. Both guard
// the SQLite row and the browser that has to render it -- a dense
// RWGPS track is ~5-15k points, so these leave generous headroom while
// rejecting a pathological upload.
const (
	MaxRouteGeoJSONBytes = 6 << 20 // 6 MiB
	MaxRouteVertices     = 200_000
)

var routeColorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// MapRouteRequest is the body accepted by POST /api/map-routes and
// PUT /api/map-routes/{id}. The client parses GPX/KML/GeoJSON into a
// GeoJSON document and uploads that; the server stores it verbatim and
// never transmits it.
type MapRouteRequest struct {
	Name    string          `json:"name"`
	Color   string          `json:"color"`
	GeoJSON json.RawMessage `json:"geojson" swaggertype:"object"`
}

// Validate enforces a non-empty name, a hex color (or empty for the
// default), and a GeoJSON document that carries at least one line
// geometry with on-globe coordinates, within the size and vertex caps.
func (r MapRouteRequest) Validate() error {
	if strings.TrimSpace(r.Name) == "" {
		return fmt.Errorf("name is required")
	}
	if r.Color != "" && !routeColorRe.MatchString(r.Color) {
		return fmt.Errorf("color must be a #rrggbb hex string")
	}
	if len(r.GeoJSON) == 0 {
		return fmt.Errorf("geojson is required")
	}
	if len(r.GeoJSON) > MaxRouteGeoJSONBytes {
		return fmt.Errorf("geojson too large (limit %d bytes)", MaxRouteGeoJSONBytes)
	}
	n, err := countRouteVertices(r.GeoJSON)
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("geojson has no line geometry")
	}
	if n > MaxRouteVertices {
		return fmt.Errorf("route has too many points (%d, limit %d)", n, MaxRouteVertices)
	}
	return nil
}

// ToModel maps a validated request to a storage model, compacting the
// GeoJSON and defaulting the color.
func (r MapRouteRequest) ToModel() configstore.MapRoute {
	color := r.Color
	if color == "" {
		color = DefaultRouteColor
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, r.GeoJSON); err != nil {
		// Validate() already parsed this; fall back to the raw bytes.
		buf.Reset()
		buf.Write(r.GeoJSON)
	}
	n, _ := countRouteVertices(r.GeoJSON)
	return configstore.MapRoute{
		Name:       strings.TrimSpace(r.Name),
		Color:      color,
		GeoJSON:    buf.String(),
		PointCount: uint32(n),
	}
}

// ToUpdate maps an update request to a storage model, preserving id.
func (r MapRouteRequest) ToUpdate(id uint32) configstore.MapRoute {
	m := r.ToModel()
	m.ID = id
	return m
}

// MapRouteResponse is the body returned by GET/POST/PUT for a route.
type MapRouteResponse struct {
	ID         uint32          `json:"id"`
	Name       string          `json:"name"`
	Color      string          `json:"color"`
	GeoJSON    json.RawMessage `json:"geojson" swaggertype:"object"`
	PointCount uint32          `json:"point_count"`
}

// MapRouteFromModel converts a storage model into a response DTO.
func MapRouteFromModel(m configstore.MapRoute) MapRouteResponse {
	gj := json.RawMessage(m.GeoJSON)
	if len(gj) == 0 {
		gj = json.RawMessage("null")
	}
	return MapRouteResponse{
		ID:         m.ID,
		Name:       m.Name,
		Color:      m.Color,
		GeoJSON:    gj,
		PointCount: m.PointCount,
	}
}

// ---------------------------------------------------------------------------
// GeoJSON inspection
// ---------------------------------------------------------------------------

// countRouteVertices parses a GeoJSON document (FeatureCollection,
// Feature, or bare geometry) and returns the total number of vertices
// across every LineString and MultiLineString it contains. It returns
// an error if the JSON is malformed or a coordinate is off-globe or
// non-finite. Non-line geometries (Point, Polygon, ...) are ignored.
func countRouteVertices(raw []byte) (int, error) {
	var node geoNode
	if err := json.Unmarshal(raw, &node); err != nil {
		return 0, fmt.Errorf("geojson: %w", err)
	}
	return node.lineVertices()
}

type geoNode struct {
	Type        string          `json:"type"`
	Features    []geoNode       `json:"features"`
	Geometry    *geoNode        `json:"geometry"`
	Geometries  []geoNode       `json:"geometries"`
	Coordinates json.RawMessage `json:"coordinates"`
}

func (n geoNode) lineVertices() (int, error) {
	switch n.Type {
	case "FeatureCollection":
		total := 0
		for i := range n.Features {
			c, err := n.Features[i].lineVertices()
			if err != nil {
				return 0, err
			}
			total += c
		}
		return total, nil
	case "Feature":
		if n.Geometry == nil {
			return 0, nil
		}
		return n.Geometry.lineVertices()
	case "GeometryCollection":
		total := 0
		for i := range n.Geometries {
			c, err := n.Geometries[i].lineVertices()
			if err != nil {
				return 0, err
			}
			total += c
		}
		return total, nil
	case "LineString":
		var coords [][]float64
		if err := json.Unmarshal(n.Coordinates, &coords); err != nil {
			return 0, fmt.Errorf("geojson LineString coordinates: %w", err)
		}
		return countPositions(coords)
	case "MultiLineString":
		var lines [][][]float64
		if err := json.Unmarshal(n.Coordinates, &lines); err != nil {
			return 0, fmt.Errorf("geojson MultiLineString coordinates: %w", err)
		}
		total := 0
		for _, line := range lines {
			c, err := countPositions(line)
			if err != nil {
				return 0, err
			}
			total += c
		}
		return total, nil
	default:
		// Point, MultiPoint, Polygon, MultiPolygon, unknown -> not a route line.
		return 0, nil
	}
}

func countPositions(coords [][]float64) (int, error) {
	for _, pos := range coords {
		if len(pos) < 2 {
			return 0, fmt.Errorf("geojson coordinate needs [lon, lat]")
		}
		lon, lat := pos[0], pos[1]
		if math.IsNaN(lon) || math.IsInf(lon, 0) || math.IsNaN(lat) || math.IsInf(lat, 0) {
			return 0, fmt.Errorf("geojson coordinate is not finite")
		}
		if lon < -180 || lon > 180 {
			return 0, fmt.Errorf("geojson longitude out of range")
		}
		if lat < -90 || lat > 90 {
			return 0, fmt.Errorf("geojson latitude out of range")
		}
	}
	return len(coords), nil
}
