package transport

import (
	"context"
	"net/http"
	"time"
)

type ReadinessCheck func(context.Context) error

const readinessTimeout = 2 * time.Second

func NewHealthHandler(checks ...ReadinessCheck) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeHealthResponse(w, http.StatusOK, "live")
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), readinessTimeout)
		defer cancel()
		if len(checks) == 0 {
			writeHealthResponse(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		for _, check := range checks {
			if check == nil || check(ctx) != nil {
				writeHealthResponse(w, http.StatusServiceUnavailable, "unavailable")
				return
			}
		}
		writeHealthResponse(w, http.StatusOK, "ready")
	})
	return mux
}

func NewHandler(checks []ReadinessCheck, public http.Handler) http.Handler {
	health := NewHealthHandler(checks...)
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/health/live" || request.URL.Path == "/health/ready" {
			health.ServeHTTP(writer, request)
			return
		}
		if public == nil {
			writeHealthResponse(writer, http.StatusServiceUnavailable, "unavailable")
			return
		}
		public.ServeHTTP(writer, request)
	})
}

func writeHealthResponse(w http.ResponseWriter, statusCode int, status string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_, _ = w.Write([]byte("{\"status\":\"" + status + "\"}\n"))
}
