package transport

import (
	"context"
	"net/http"
	"time"
)

type ReadinessCheck func(context.Context) error

const readinessTimeout = 2 * time.Second

func NewHealthHandler(databaseCheck ReadinessCheck, signerCheck ReadinessCheck) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeHealthResponse(w, http.StatusOK, "live")
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), readinessTimeout)
		defer cancel()
		if databaseCheck == nil || signerCheck == nil {
			writeHealthResponse(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		if err := databaseCheck(ctx); err != nil {
			writeHealthResponse(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		if err := signerCheck(ctx); err != nil {
			writeHealthResponse(w, http.StatusServiceUnavailable, "unavailable")
			return
		}
		writeHealthResponse(w, http.StatusOK, "ready")
	})
	return mux
}

func writeHealthResponse(w http.ResponseWriter, statusCode int, status string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_, _ = w.Write([]byte("{\"status\":\"" + status + "\"}\n"))
}
