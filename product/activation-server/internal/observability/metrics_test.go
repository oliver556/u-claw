package observability

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInstrumentPublicHandlerRecordsActivationResult(t *testing.T) {
	metrics := NewMetrics()
	next := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write([]byte(`{"code":"IDEMPOTENCY_CONFLICT"}`))
	})
	recorder := httptest.NewRecorder()
	metrics.InstrumentPublicHandler(next).ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/activations", nil))

	metricsRecorder := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(metricsRecorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	assertMetric(t, metricsRecorder.Body.String(), `uclaw_activation_requests_total{outcome="error",code="IDEMPOTENCY_CONFLICT"} 1`)
}

func TestInstrumentPublicHandlerPreservesResponseControllerCapabilities(t *testing.T) {
	metrics := NewMetrics()
	flushed := false
	next := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if err := http.NewResponseController(writer).Flush(); err != nil {
			t.Fatalf("flush through metrics wrapper: %v", err)
		}
		flushed = true
	})
	metrics.InstrumentPublicHandler(next).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/activations", nil))
	if !flushed {
		t.Fatal("wrapped handler did not flush")
	}
}

func TestMetricsExposeActivationSLOAndFailureSignals(t *testing.T) {
	metrics := NewMetrics()
	metrics.RecordActivation("success", "", 120*time.Millisecond)
	metrics.RecordActivation("error", "ACTIVATION_INVALID", 750*time.Millisecond)
	metrics.RecordActivation("error", "secret-db-message", 2*time.Second)
	metrics.RecordDBFailure("begin_binding")
	metrics.RecordBindingLeaseStale()
	metrics.RecordSigningFailure("license")
	metrics.RecordSigningFailure("kms")
	metrics.RecordCommitStale()
	metrics.RecordLifecycle("reissue", "success")
	metrics.RecordLifecycle("revoke", "error")

	recorder := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(recorder, httptest.NewRequest("GET", "/metrics", nil))
	body := recorder.Body.String()

	assertMetric(t, body, `uclaw_activation_requests_total{outcome="success",code="none"} 1`)
	assertMetric(t, body, `uclaw_activation_requests_total{outcome="error",code="ACTIVATION_INVALID"} 1`)
	assertMetric(t, body, `uclaw_activation_requests_total{outcome="error",code="INTERNAL_ERROR"} 1`)
	assertMetric(t, body, `uclaw_activation_duration_seconds_bucket{le="0.25"} 1`)
	assertMetric(t, body, `uclaw_activation_duration_seconds_bucket{le="1"} 2`)
	assertMetric(t, body, `uclaw_activation_duration_seconds_bucket{le="+Inf"} 3`)
	assertMetric(t, body, `uclaw_activation_duration_seconds_count 3`)
	assertMetric(t, body, `uclaw_db_operation_failures_total{operation="begin_binding"} 1`)
	assertMetric(t, body, `uclaw_binding_lease_stale_total 1`)
	assertMetric(t, body, `uclaw_signing_failures_total{dependency="license"} 1`)
	assertMetric(t, body, `uclaw_signing_failures_total{dependency="kms"} 1`)
	assertMetric(t, body, `uclaw_commit_stale_total 1`)
	assertMetric(t, body, `uclaw_lifecycle_operations_total{action="reissue",outcome="success"} 1`)
	assertMetric(t, body, `uclaw_lifecycle_operations_total{action="revoke",outcome="error"} 1`)
	if strings.Contains(body, "secret-db-message") {
		t.Fatal("unstable internal error leaked into metric labels")
	}
}

func TestMetricsExposeBoundedModelProxySignals(t *testing.T) {
	metrics := NewMetrics()
	metrics.RecordModelProxyAuthRejected()
	metrics.RecordModelProxyAdmissionLimited()
	metrics.RecordModelProxyUpstream("success", 125*time.Millisecond)
	metrics.RecordModelProxyUpstream("secret-host", time.Second)
	metrics.RecordModelProxyFinalizeFailure("complete")
	metrics.RecordModelProxyFinalizeFailure("secret-operation")
	recorder := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := recorder.Body.String()
	assertMetric(t, body, `uclaw_model_proxy_auth_rejected_total 1`)
	assertMetric(t, body, `uclaw_model_proxy_admission_limited_total 1`)
	assertMetric(t, body, `uclaw_model_proxy_upstream_total{outcome="success"} 1`)
	assertMetric(t, body, `uclaw_model_proxy_upstream_total{outcome="unknown"} 1`)
	assertMetric(t, body, `uclaw_model_proxy_finalize_failures_total{operation="complete"} 1`)
	assertMetric(t, body, `uclaw_model_proxy_finalize_failures_total{operation="unknown"} 1`)
	if strings.Contains(body, "secret-host") {
		t.Fatal("unbounded upstream label leaked")
	}
}

func assertMetric(t *testing.T, body, metric string) {
	t.Helper()
	if !strings.Contains(body, metric+"\n") {
		t.Fatalf("metric %q missing from:\n%s", metric, body)
	}
}
