package modelproxy

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"u-claw-activation-server/internal/security"
)

type fakeRepository struct {
	auth           Authorization
	err            error
	admitErr       error
	digest         [32]byte
	completed      string
	audits         []Audit
	lease          time.Duration
	completeCtxErr error
	auditCtxErr    error
	completeErr    error
	auditErr       error
}

func (r *fakeRepository) AuthorizeByDigest(_ context.Context, d [32]byte) (Authorization, error) {
	r.digest = d
	return r.auth, r.err
}
func (r *fakeRepository) Admit(_ context.Context, tokenID, requestID string, rpm, concurrent int, lease time.Duration) error {
	r.lease = lease
	return r.admitErr
}
func (r *fakeRepository) Complete(ctx context.Context, requestID string) error {
	r.completed = requestID
	r.completeCtxErr = ctx.Err()
	return r.completeErr
}
func (r *fakeRepository) Audit(ctx context.Context, a Audit) error {
	r.audits = append(r.audits, a)
	r.auditCtxErr = ctx.Err()
	return r.auditErr
}

type fakeEnvelope struct {
	value   []byte
	err     error
	binding security.SecretBinding
}
type blockingEnvelope struct{}

func (blockingEnvelope) Decrypt(ctx context.Context, _ security.SecretBinding, _ []byte) ([]byte, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

type fakeObserver struct {
	auth, limited int
	outcomes      []string
	finalize      []string
}

func runtimeSecret(t *testing.T) []byte {
	t.Helper()
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	return []byte(hex.EncodeToString(value))
}

func (o *fakeObserver) RecordModelProxyAuthRejected()     { o.auth++ }
func (o *fakeObserver) RecordModelProxyAdmissionLimited() { o.limited++ }
func (o *fakeObserver) RecordModelProxyUpstream(outcome string, _ time.Duration) {
	o.outcomes = append(o.outcomes, outcome)
}
func (o *fakeObserver) RecordModelProxyFinalizeFailure(operation string) {
	o.finalize = append(o.finalize, operation)
}

func (e *fakeEnvelope) Decrypt(_ context.Context, b security.SecretBinding, _ []byte) ([]byte, error) {
	e.binding = b
	return append([]byte(nil), e.value...), e.err
}

func activeAuthorization() Authorization {
	return Authorization{TokenID: "10000000-0000-4000-8000-000000000001", InventoryID: "20000000-0000-4000-8000-000000000001", DeviceID: "30000000-0000-4000-8000-000000000001", LicenseID: "40000000-0000-4000-8000-000000000001", TokenStatus: "active", InventoryStatus: "active", DeviceStatus: "active", LicenseStatus: "active", BindingStatus: "active", SetupStatus: "configured", BalanceStatus: "configured", Envelope: []byte("envelope"), KeyVersion: "kms-v1", BaseURL: "https://api.example.test/v1", DefaultModel: "allowed", AllowedModels: []string{"allowed"}, RequestsPerMinute: 60, ConcurrentRequests: 2}
}

func TestAuthorizeRejectsEveryInactiveStateUniformlyBeforeAdmission(t *testing.T) {
	fields := []func(*Authorization){func(a *Authorization) { a.TokenStatus = "disabled" }, func(a *Authorization) { a.TokenStatus = "revoked" }, func(a *Authorization) { a.InventoryStatus = "disabled" }, func(a *Authorization) { a.DeviceStatus = "revoked" }, func(a *Authorization) { a.LicenseStatus = "expired" }, func(a *Authorization) { a.BindingStatus = "disabled" }, func(a *Authorization) { a.SetupStatus = "pending" }, func(a *Authorization) { a.BalanceStatus = "pending" }}
	for i, mutate := range fields {
		a := activeAuthorization()
		mutate(&a)
		repo := &fakeRepository{auth: a}
		service, _ := NewService(ServiceOptions{Repository: repo, Digest: func(string) [32]byte { return [32]byte{byte(i + 1)} }, Envelope: &fakeEnvelope{value: runtimeSecret(t)}, Random: rand.Reader})
		_, err := service.Authorize(context.Background(), "raw-token", "allowed", "req-123")
		if !errors.Is(err, ErrAuthenticationFailed) {
			t.Fatalf("case %d err=%v", i, err)
		}
	}
}

func TestAuthorizeRecordsBoundedRejectionMetrics(t *testing.T) {
	observer := &fakeObserver{}
	a := activeAuthorization()
	a.DeviceStatus = "disabled"
	service, _ := NewService(ServiceOptions{Repository: &fakeRepository{auth: a}, Digest: func(string) [32]byte { return [32]byte{} }, Envelope: &fakeEnvelope{value: runtimeSecret(t)}, Observer: observer})
	_, _ = service.Authorize(context.Background(), "token", "allowed", "req-123")
	if observer.auth != 1 {
		t.Fatalf("auth=%d", observer.auth)
	}
	a = activeAuthorization()
	repo := &fakeRepository{auth: a, admitErr: ErrAdmissionLimited}
	service, _ = NewService(ServiceOptions{Repository: repo, Digest: func(string) [32]byte { return [32]byte{} }, Envelope: &fakeEnvelope{value: runtimeSecret(t)}, Observer: observer})
	_, _ = service.Authorize(context.Background(), "token", "allowed", "req-124")
	if observer.limited != 1 {
		t.Fatalf("limited=%d", observer.limited)
	}
}

func TestAdmissionDeniedAuditFailureRecordsFinalizeMetric(t *testing.T) {
	observer := &fakeObserver{}
	repo := &fakeRepository{auth: activeAuthorization(), admitErr: ErrAdmissionLimited, auditErr: errors.New("audit")}
	service, _ := NewService(ServiceOptions{Repository: repo, Digest: func(string) [32]byte { return [32]byte{} }, Envelope: &fakeEnvelope{value: runtimeSecret(t)}, Observer: observer})
	_, err := service.Authorize(context.Background(), "token", "allowed", "req-123")
	if !errors.Is(err, ErrAdmissionLimited) {
		t.Fatalf("err=%v", err)
	}
	if strings.Join(observer.finalize, ",") != "audit" {
		t.Fatalf("finalize=%v", observer.finalize)
	}
}

func TestAuthorizeModelAdmissionAndSecretBinding(t *testing.T) {
	repo := &fakeRepository{auth: activeAuthorization()}
	secret := runtimeSecret(t)
	env := &fakeEnvelope{value: secret}
	service, _ := NewService(ServiceOptions{Repository: repo, Digest: func(string) [32]byte { return [32]byte{9} }, Envelope: env, Random: rand.Reader})
	if _, err := service.Authorize(context.Background(), "raw-token", "blocked", "req-123"); !errors.Is(err, ErrModelNotAllowed) {
		t.Fatalf("model err=%v", err)
	}
	repo.admitErr = ErrAdmissionLimited
	if _, err := service.Authorize(context.Background(), "raw-token", "allowed", "req-124"); !errors.Is(err, ErrAdmissionLimited) {
		t.Fatalf("admit err=%v", err)
	}
	repo.admitErr = nil
	grant, err := service.Authorize(context.Background(), "raw-token", "allowed", "req-125")
	if err != nil {
		t.Fatal(err)
	}
	defer grant.Clear()
	if !bytes.Equal(grant.APIKey, secret) {
		t.Fatal("secret mismatch")
	}
	want := security.SecretBinding{Purpose: "new-api-key", SubjectID: repo.auth.InventoryID, KeyVersion: "kms-v1"}
	if env.binding != want {
		t.Fatalf("binding=%+v", env.binding)
	}
	if strings.Contains(strings.Join([]string{repo.audits[0].RequestID, repo.audits[0].Route}, " "), "raw-token") {
		t.Fatal("raw token audited")
	}
}

func TestAuthorizeMapsLookupAndDecryptFailures(t *testing.T) {
	for _, tc := range []struct {
		name               string
		repoErr, errorWant error
		decryptErr         error
		secret             []byte
	}{{"missing", ErrNotFound, ErrAuthenticationFailed, nil, nil}, {"db", errors.New("db host secret"), ErrServiceUnavailable, nil, nil}, {"decrypt", nil, ErrServiceUnavailable, errors.New("kms detail"), nil}, {"whitespace", nil, ErrServiceUnavailable, nil, []byte(" bad ")}} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &fakeRepository{auth: activeAuthorization(), err: tc.repoErr}
			env := &fakeEnvelope{value: tc.secret, err: tc.decryptErr}
			if tc.secret == nil && tc.decryptErr == nil {
				env.value = runtimeSecret(t)
			}
			service, _ := NewService(ServiceOptions{Repository: repo, Digest: func(string) [32]byte { return [32]byte{} }, Envelope: env, Random: rand.Reader})
			_, err := service.Authorize(context.Background(), "token", "allowed", "req-123")
			if !errors.Is(err, tc.errorWant) {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestAuthorizeUsesSharedAPIKeyBoundaries(t *testing.T) {
	for _, test := range []struct {
		name string
		key  []byte
		ok   bool
	}{{"min", bytes.Repeat([]byte{'k'}, 16), true}, {"max", bytes.Repeat([]byte{'k'}, 16<<10), true}, {"surrounding whitespace", append(append([]byte("  "), bytes.Repeat([]byte{'k'}, 16)...), ' ', ' '), true}, {"short", bytes.Repeat([]byte{'k'}, 15), false}, {"long", bytes.Repeat([]byte{'k'}, (16<<10)+1), false}, {"space", bytes.Repeat([]byte{' '}, 16), false}} {
		t.Run(test.name, func(t *testing.T) {
			service, _ := NewService(ServiceOptions{Repository: &fakeRepository{auth: activeAuthorization()}, Digest: func(string) [32]byte { return [32]byte{} }, Envelope: &fakeEnvelope{value: test.key}})
			grant, err := service.Authorize(context.Background(), "token", "allowed", "req-123")
			if test.ok && err != nil {
				t.Fatal(err)
			}
			if !test.ok && !errors.Is(err, ErrServiceUnavailable) {
				t.Fatalf("err=%v", err)
			}
			grant.Clear()
		})
	}
}

func TestAuthorizeDerivesLeaseFromOverallDeadline(t *testing.T) {
	repo := &fakeRepository{auth: activeAuthorization()}
	service, _ := NewService(ServiceOptions{Repository: repo, Digest: func(string) [32]byte { return [32]byte{} }, Envelope: &fakeEnvelope{value: runtimeSecret(t)}})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	grant, err := service.Authorize(ctx, "token", "allowed", "req-123")
	if err != nil {
		t.Fatal(err)
	}
	grant.Clear()
	if repo.lease < 39*time.Second || repo.lease > 41*time.Second {
		t.Fatalf("lease=%s", repo.lease)
	}
}

func TestCompleteDetachesFromClientCancellationAndRecordsFailures(t *testing.T) {
	repo := &fakeRepository{auth: activeAuthorization(), completeErr: errors.New("complete"), auditErr: errors.New("audit")}
	observer := &fakeObserver{}
	service, _ := NewService(ServiceOptions{Repository: repo, Digest: func(string) [32]byte { return [32]byte{} }, Envelope: &fakeEnvelope{value: runtimeSecret(t)}, Observer: observer})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	service.Complete(ctx, Grant{Authorization: repo.auth, RequestID: "req-123"}, "chat", "unavailable", 502, nil)
	if repo.completeCtxErr != nil || repo.auditCtxErr != nil {
		t.Fatalf("complete=%v audit=%v", repo.completeCtxErr, repo.auditCtxErr)
	}
	if strings.Join(observer.finalize, ",") != "complete,audit" {
		t.Fatalf("finalize=%v", observer.finalize)
	}
}

func TestAuthorizeSlowDecryptHonorsOverallDeadline(t *testing.T) {
	repo := &fakeRepository{auth: activeAuthorization()}
	service, _ := NewService(ServiceOptions{Repository: repo, Digest: func(string) [32]byte { return [32]byte{} }, Envelope: blockingEnvelope{}})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := service.Authorize(ctx, "token", "allowed", "req-123")
	if !errors.Is(err, ErrServiceUnavailable) || time.Since(started) > time.Second {
		t.Fatalf("err=%v duration=%s", err, time.Since(started))
	}
	if repo.completed != "req-123" {
		t.Fatal("admission not finalized")
	}
}
