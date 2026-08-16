package transport

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthLive(t *testing.T) {
	handler := NewHealthHandler(
		func(context.Context) error { return nil },
		func(context.Context) error { return nil },
	)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/live", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	if got := response.Body.String(); got != "{\"status\":\"live\"}\n" {
		t.Fatalf("body = %q", got)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
}

func TestHealthReadyProvidesShortDependencyDeadline(t *testing.T) {
	var remaining time.Duration
	handler := NewHealthHandler(
		func(ctx context.Context) error {
			deadline, ok := ctx.Deadline()
			if !ok {
				return errors.New("missing deadline")
			}
			remaining = time.Until(deadline)
			return nil
		},
		func(context.Context) error { return nil },
	)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	if remaining <= 0 || remaining > 3*time.Second {
		t.Fatalf("dependency deadline remaining = %s, want within 3s", remaining)
	}
}

func TestHealthReady(t *testing.T) {
	tests := []struct {
		name        string
		databaseErr error
		signerErr   error
		wantStatus  int
		wantBody    string
	}{
		{
			name:       "dependencies available",
			wantStatus: http.StatusOK,
			wantBody:   "{\"status\":\"ready\"}\n",
		},
		{
			name:        "database unavailable",
			databaseErr: errors.New("dial tcp postgres.internal:5432: connection refused"),
			wantStatus:  http.StatusServiceUnavailable,
			wantBody:    "{\"status\":\"unavailable\"}\n",
		},
		{
			name:       "signer unavailable",
			signerErr:  errors.New("secret signing key material could not be loaded"),
			wantStatus: http.StatusServiceUnavailable,
			wantBody:   "{\"status\":\"unavailable\"}\n",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler := NewHealthHandler(
				func(context.Context) error { return test.databaseErr },
				func(context.Context) error { return test.signerErr },
			)

			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))

			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, test.wantStatus)
			}
			if got := response.Body.String(); got != test.wantBody {
				t.Fatalf("body = %q, want %q", got, test.wantBody)
			}
			for _, dependencyError := range []error{test.databaseErr, test.signerErr} {
				if dependencyError != nil && strings.Contains(response.Body.String(), dependencyError.Error()) {
					t.Fatalf("body leaks dependency error: %q", response.Body.String())
				}
			}
		})
	}
}

func TestHealthReadyFailsClosedWithMissingCheck(t *testing.T) {
	handler := NewHealthHandler(nil, func(context.Context) error { return nil })
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}

func TestReadinessRequiresEveryConfiguredDependency(t *testing.T) {
	calls := 0
	checks := []ReadinessCheck{
		func(context.Context) error { calls++; return nil },
		func(context.Context) error { calls++; return nil },
		func(context.Context) error { calls++; return nil },
		func(context.Context) error { calls++; return nil },
	}
	response := httptest.NewRecorder()
	NewHealthHandler(checks...).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if response.Code != http.StatusOK || calls != 4 {
		t.Fatalf("status=%d calls=%d", response.Code, calls)
	}
	checks[2] = func(context.Context) error { return errors.New("status signer unavailable") }
	response = httptest.NewRecorder()
	NewHealthHandler(checks...).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d", response.Code)
	}
}
