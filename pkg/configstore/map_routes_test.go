package configstore

import (
	"context"
	"testing"
)

func TestMapRouteCRUDRoundTrip(t *testing.T) {
	ctx := context.Background()
	s, err := OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	mr := &MapRoute{
		Name:       "RFL Course",
		Color:      "#e11d48",
		GeoJSON:    `{"type":"FeatureCollection","features":[]}`,
		PointCount: 1234,
	}
	if err := s.CreateMapRoute(ctx, mr); err != nil {
		t.Fatalf("create: %v", err)
	}
	if mr.ID == 0 {
		t.Fatalf("expected assigned id, got 0")
	}

	got, err := s.GetMapRoute(ctx, mr.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Name != "RFL Course" || got.PointCount != 1234 || got.GeoJSON != mr.GeoJSON {
		t.Fatalf("round-trip mismatch: %+v", got)
	}

	got.Name = "RFL Course 2026"
	got.Color = "#00aa88"
	if err := s.UpdateMapRoute(ctx, got); err != nil {
		t.Fatalf("update: %v", err)
	}

	all, err := s.ListMapRoutes(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 1 || all[0].Name != "RFL Course 2026" || all[0].Color != "#00aa88" {
		t.Fatalf("list mismatch: %+v", all)
	}

	if err := s.DeleteMapRoute(ctx, mr.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	all, err = s.ListMapRoutes(ctx)
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if len(all) != 0 {
		t.Fatalf("expected empty after delete, got %+v", all)
	}
}
