package webapi

import (
	"errors"
	"net/http"

	"github.com/chrissnell/graywolf/pkg/configstore"
	"github.com/chrissnell/graywolf/pkg/webapi/dto"
)

// maxRouteRequestBytes caps the POST/PUT body for a map route. It sits
// above dto.MaxRouteGeoJSONBytes to leave room for the name/color
// envelope and JSON whitespace; the DTO then enforces the tighter
// GeoJSON-only limit.
const maxRouteRequestBytes = 8 << 20 // 8 MiB

// registerMapRoutes installs the /api/map-routes route tree. Map routes
// are operator-uploaded route lines (e.g. a Ride With GPS course)
// drawn on the live map, shared across every device pointed at this
// server. See fixed_points.go for the reference CRUD shape; create and
// update are hand-rolled here so the upload body can be size-capped.
func (s *Server) registerMapRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/map-routes", s.listMapRoutes)
	mux.HandleFunc("POST /api/map-routes", s.createMapRoute)
	mux.HandleFunc("GET /api/map-routes/{id}", s.getMapRoute)
	mux.HandleFunc("PUT /api/map-routes/{id}", s.updateMapRoute)
	mux.HandleFunc("DELETE /api/map-routes/{id}", s.deleteMapRoute)
}

// listMapRoutes returns every uploaded route.
//
// @Summary  List map routes
// @Tags     map-routes
// @ID       listMapRoutes
// @Produce  json
// @Success  200 {array}  dto.MapRouteResponse
// @Failure  500 {object} webtypes.ErrorResponse
// @Security CookieAuth
// @Router   /map-routes [get]
func (s *Server) listMapRoutes(w http.ResponseWriter, r *http.Request) {
	handleList[configstore.MapRoute](s, w, r, "list map routes",
		s.store.ListMapRoutes, dto.MapRouteFromModel)
}

// createMapRoute stores a new route from an uploaded GeoJSON document.
//
// @Summary  Create map route
// @Tags     map-routes
// @ID       createMapRoute
// @Accept   json
// @Produce  json
// @Param    body body     dto.MapRouteRequest true "Route definition"
// @Success  201  {object} dto.MapRouteResponse
// @Failure  400  {object} webtypes.ErrorResponse
// @Failure  500  {object} webtypes.ErrorResponse
// @Security CookieAuth
// @Router   /map-routes [post]
func (s *Server) createMapRoute(w http.ResponseWriter, r *http.Request) {
	req, ok := s.decodeMapRoute(w, r)
	if !ok {
		return
	}
	m := req.ToModel()
	if err := s.store.CreateMapRoute(r.Context(), &m); err != nil {
		s.internalError(w, r, "create map route", err)
		return
	}
	writeJSON(w, http.StatusCreated, dto.MapRouteFromModel(m))
}

// getMapRoute returns the route with the given id.
//
// @Summary  Get map route
// @Tags     map-routes
// @ID       getMapRoute
// @Produce  json
// @Param    id  path     int true "Route id"
// @Success  200 {object} dto.MapRouteResponse
// @Failure  400 {object} webtypes.ErrorResponse
// @Failure  404 {object} webtypes.ErrorResponse
// @Security CookieAuth
// @Router   /map-routes/{id} [get]
func (s *Server) getMapRoute(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		badRequest(w, "invalid id")
		return
	}
	handleGet[*configstore.MapRoute](s, w, r, "get map route", id,
		s.store.GetMapRoute,
		func(mr *configstore.MapRoute) dto.MapRouteResponse {
			return dto.MapRouteFromModel(*mr)
		})
}

// updateMapRoute replaces the route with the given id.
//
// @Summary  Update map route
// @Tags     map-routes
// @ID       updateMapRoute
// @Accept   json
// @Produce  json
// @Param    id   path     int                 true "Route id"
// @Param    body body     dto.MapRouteRequest true "Route definition"
// @Success  200  {object} dto.MapRouteResponse
// @Failure  400  {object} webtypes.ErrorResponse
// @Failure  500  {object} webtypes.ErrorResponse
// @Security CookieAuth
// @Router   /map-routes/{id} [put]
func (s *Server) updateMapRoute(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		badRequest(w, "invalid id")
		return
	}
	req, ok := s.decodeMapRoute(w, r)
	if !ok {
		return
	}
	m := req.ToUpdate(id)
	if err := s.store.UpdateMapRoute(r.Context(), &m); err != nil {
		s.internalError(w, r, "update map route", err)
		return
	}
	writeJSON(w, http.StatusOK, dto.MapRouteFromModel(m))
}

// deleteMapRoute removes the route with the given id.
//
// @Summary  Delete map route
// @Tags     map-routes
// @ID       deleteMapRoute
// @Param    id  path int true "Route id"
// @Success  204 "No Content"
// @Failure  400 {object} webtypes.ErrorResponse
// @Failure  500 {object} webtypes.ErrorResponse
// @Security CookieAuth
// @Router   /map-routes/{id} [delete]
func (s *Server) deleteMapRoute(w http.ResponseWriter, r *http.Request) {
	id, err := parseID(r.PathValue("id"))
	if err != nil {
		badRequest(w, "invalid id")
		return
	}
	handleDelete(s, w, r, "delete map route", id, s.store.DeleteMapRoute)
}

// decodeMapRoute size-caps the body, decodes it, and validates it,
// writing the appropriate 400 and returning ok=false on any failure.
func (s *Server) decodeMapRoute(w http.ResponseWriter, r *http.Request) (dto.MapRouteRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRouteRequestBytes)
	req, err := decodeJSON[dto.MapRouteRequest](r)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			badRequest(w, "route file too large")
			return dto.MapRouteRequest{}, false
		}
		badRequest(w, err.Error())
		return dto.MapRouteRequest{}, false
	}
	if err := req.Validate(); err != nil {
		badRequest(w, err.Error())
		return dto.MapRouteRequest{}, false
	}
	return req, true
}
