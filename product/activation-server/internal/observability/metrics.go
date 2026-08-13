package observability

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type responseCapture struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (capture *responseCapture) WriteHeader(status int) {
	capture.status = status
	capture.ResponseWriter.WriteHeader(status)
}

func (capture *responseCapture) Write(value []byte) (int, error) {
	if capture.status == 0 {
		capture.status = http.StatusOK
	}
	if capture.body.Len() < 4096 {
		_, _ = capture.body.Write(value[:min(len(value), 4096-capture.body.Len())])
	}
	return capture.ResponseWriter.Write(value)
}

func (capture *responseCapture) Unwrap() http.ResponseWriter { return capture.ResponseWriter }

var activationDurationBuckets = []float64{0.05, 0.1, 0.25, 0.5, 1, 2.5, 5}

var stableActivationCodes = map[string]struct{}{
	"ACTIVATION_CODE_ALREADY_BOUND":  {},
	"ACTIVATION_IN_PROGRESS":         {},
	"ACTIVATION_INVALID":             {},
	"ACTIVATION_SERVICE_UNAVAILABLE": {},
	"IDEMPOTENCY_CONFLICT":           {},
	"NEW_API_NOT_CONFIGURED":         {},
}

// Metrics holds bounded-cardinality activation service metrics. Callers must
// never pass customer identifiers as labels.
type Metrics struct {
	mu                  sync.Mutex
	activationRequests  map[string]uint64
	activationBuckets   []uint64
	activationCount     uint64
	activationSum       float64
	dbFailures          map[string]uint64
	bindingLeaseStale   uint64
	signingFailures     map[string]uint64
	commitStale         uint64
	lifecycleOperations map[string]uint64
}

func NewMetrics() *Metrics {
	return &Metrics{
		activationRequests:  make(map[string]uint64),
		activationBuckets:   make([]uint64, len(activationDurationBuckets)),
		dbFailures:          make(map[string]uint64),
		signingFailures:     make(map[string]uint64),
		lifecycleOperations: make(map[string]uint64),
	}
}

func (metrics *Metrics) RecordActivation(outcome, code string, duration time.Duration) {
	if outcome != "success" {
		outcome = "error"
	} else {
		code = "none"
	}
	if outcome == "error" {
		if _, ok := stableActivationCodes[code]; !ok {
			code = "INTERNAL_ERROR"
		}
	}
	seconds := duration.Seconds()
	if seconds < 0 {
		seconds = 0
	}
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.activationRequests[outcome+"\x00"+code]++
	metrics.activationCount++
	metrics.activationSum += seconds
	for index, upperBound := range activationDurationBuckets {
		if seconds <= upperBound {
			metrics.activationBuckets[index]++
		}
	}
}

func (metrics *Metrics) RecordDBFailure(operation string) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.dbFailures[boundedValue(operation, []string{"validate_binding", "begin_binding", "complete_binding", "commit", "lifecycle", "admin"})]++
}

func (metrics *Metrics) RecordBindingLeaseStale() {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.bindingLeaseStale++
}

func (metrics *Metrics) RecordSigningFailure(dependency string) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.signingFailures[boundedValue(dependency, []string{"license", "status", "kms"})]++
}

func (metrics *Metrics) RecordCommitStale() {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.commitStale++
}

func (metrics *Metrics) RecordLifecycle(action, outcome string) {
	action = boundedValue(action, []string{"reissue", "revoke"})
	outcome = boundedValue(outcome, []string{"success", "error"})
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.lifecycleOperations[action+"\x00"+outcome]++
}

func (metrics *Metrics) Handler() http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writer.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = writer.Write([]byte(metrics.render()))
	})
}

func (metrics *Metrics) InstrumentPublicHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/activations" {
			next.ServeHTTP(writer, request)
			return
		}
		started := time.Now()
		capture := &responseCapture{ResponseWriter: writer}
		next.ServeHTTP(capture, request)
		outcome, code := "success", ""
		if capture.status < 200 || capture.status >= 300 {
			outcome = "error"
			var response struct {
				Code string `json:"code"`
			}
			if json.Unmarshal(capture.body.Bytes(), &response) == nil {
				code = response.Code
			}
		}
		metrics.RecordActivation(outcome, code, time.Since(started))
	})
}

func (metrics *Metrics) render() string {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	var output strings.Builder
	writeMap(&output, "uclaw_activation_requests_total", "Activation requests by stable outcome and code.", metrics.activationRequests, []string{"outcome", "code"})
	output.WriteString("# HELP uclaw_activation_duration_seconds End-to-end activation latency.\n# TYPE uclaw_activation_duration_seconds histogram\n")
	for index, upperBound := range activationDurationBuckets {
		fmt.Fprintf(&output, "uclaw_activation_duration_seconds_bucket{le=\"%g\"} %d\n", upperBound, metrics.activationBuckets[index])
	}
	fmt.Fprintf(&output, "uclaw_activation_duration_seconds_bucket{le=\"+Inf\"} %d\n", metrics.activationCount)
	fmt.Fprintf(&output, "uclaw_activation_duration_seconds_sum %g\n", metrics.activationSum)
	fmt.Fprintf(&output, "uclaw_activation_duration_seconds_count %d\n", metrics.activationCount)
	writeMap(&output, "uclaw_db_operation_failures_total", "Database operation failures by bounded operation.", metrics.dbFailures, []string{"operation"})
	writeCounter(&output, "uclaw_binding_lease_stale_total", "Expired binding leases observed.", metrics.bindingLeaseStale)
	writeMap(&output, "uclaw_signing_failures_total", "License signing or KMS failures.", metrics.signingFailures, []string{"dependency"})
	writeCounter(&output, "uclaw_commit_stale_total", "Stale activation commit attempts.", metrics.commitStale)
	writeMap(&output, "uclaw_lifecycle_operations_total", "Reissue and revoke operations.", metrics.lifecycleOperations, []string{"action", "outcome"})
	return output.String()
}

func writeCounter(output *strings.Builder, name, help string, value uint64) {
	fmt.Fprintf(output, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, value)
}

func writeMap(output *strings.Builder, name, help string, values map[string]uint64, labels []string) {
	fmt.Fprintf(output, "# HELP %s %s\n# TYPE %s counter\n", name, help, name)
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		parts := strings.Split(key, "\x00")
		pairs := make([]string, len(labels))
		for index := range labels {
			pairs[index] = labels[index] + "=\"" + parts[index] + "\""
		}
		fmt.Fprintf(output, "%s{%s} %d\n", name, strings.Join(pairs, ","), values[key])
	}
}

func boundedValue(value string, allowed []string) string {
	for _, candidate := range allowed {
		if value == candidate {
			return value
		}
	}
	return "unknown"
}
