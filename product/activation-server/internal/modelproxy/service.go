package modelproxy

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"strings"
	"time"

	"u-claw-activation-server/internal/security"
)

var (
	ErrNotFound             = errors.New("model proxy authorization not found")
	ErrAuthenticationFailed = errors.New("authentication failed")
	ErrModelNotAllowed      = errors.New("model not allowed")
	ErrAdmissionLimited     = errors.New("model proxy admission limited")
	ErrServiceUnavailable   = errors.New("model proxy service unavailable")
)

type Authorization struct {
	TokenID, InventoryID, DeviceID, LicenseID                 string
	TokenStatus, InventoryStatus, DeviceStatus, LicenseStatus string
	BindingStatus, SetupStatus, BalanceStatus                 string
	Envelope                                                  []byte
	KeyVersion, BaseURL, DefaultModel                         string
	AllowedModels                                             []string
	RequestsPerMinute, ConcurrentRequests                     int
}

type Audit struct {
	RequestID, TokenID, InventoryID, DeviceID, LicenseID, Route, Outcome string
	Status                                                               int
	Usage                                                                *Usage
}

type Usage struct{ PromptTokens, CompletionTokens, TotalTokens int }

type Repository interface {
	AuthorizeByDigest(context.Context, [32]byte) (Authorization, error)
	Admit(context.Context, string, string, int, int) error
	Complete(context.Context, string) error
	Audit(context.Context, Audit) error
}
type SecretEnvelope interface {
	Decrypt(context.Context, security.SecretBinding, []byte) ([]byte, error)
}
type ServiceOptions struct {
	Repository Repository
	Digest     func(string) [32]byte
	Envelope   SecretEnvelope
	Random     io.Reader
	Observer   Observer
}
type Observer interface {
	RecordModelProxyAuthRejected()
	RecordModelProxyAdmissionLimited()
	RecordModelProxyUpstream(string, time.Duration)
}
type Service struct {
	repository Repository
	digest     func(string) [32]byte
	envelope   SecretEnvelope
	random     io.Reader
	observer   Observer
}

func NewService(options ServiceOptions) (*Service, error) {
	if options.Repository == nil || options.Digest == nil || options.Envelope == nil {
		return nil, errors.New("model proxy service configuration invalid")
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	return &Service{repository: options.Repository, digest: options.Digest, envelope: options.Envelope, random: options.Random, observer: options.Observer}, nil
}

type Grant struct {
	Authorization Authorization
	RequestID     string
	APIKey        []byte
}

func (g *Grant) Clear() { clear(g.APIKey); g.APIKey = nil }

func (s *Service) Authorize(ctx context.Context, bearer, model, requestID string) (Grant, error) {
	auth, err := s.repository.AuthorizeByDigest(ctx, s.digest(bearer))
	if errors.Is(err, ErrNotFound) {
		if s.observer != nil {
			s.observer.RecordModelProxyAuthRejected()
		}
		return Grant{}, ErrAuthenticationFailed
	}
	if err != nil {
		return Grant{}, ErrServiceUnavailable
	}
	if !active(auth) {
		if s.observer != nil {
			s.observer.RecordModelProxyAuthRejected()
		}
		_ = s.repository.Audit(ctx, auditOf(auth, requestID, "authentication.rejected", 401))
		return Grant{}, ErrAuthenticationFailed
	}
	if model != "" && !contains(auth.AllowedModels, model) {
		_ = s.repository.Audit(ctx, auditOf(auth, requestID, "model.rejected", 403))
		return Grant{}, ErrModelNotAllowed
	}
	if err = s.repository.Admit(ctx, auth.TokenID, requestID, auth.RequestsPerMinute, auth.ConcurrentRequests); err != nil {
		if errors.Is(err, ErrAdmissionLimited) {
			if s.observer != nil {
				s.observer.RecordModelProxyAdmissionLimited()
			}
			_ = s.repository.Audit(ctx, auditOf(auth, requestID, "admission.limited", 429))
			return Grant{}, ErrAdmissionLimited
		}
		return Grant{}, ErrServiceUnavailable
	}
	plaintext, err := s.envelope.Decrypt(ctx, security.SecretBinding{Purpose: "new-api-key", SubjectID: auth.InventoryID, KeyVersion: auth.KeyVersion}, auth.Envelope)
	if err != nil || len(plaintext) == 0 || len(plaintext) > 8192 || strings.TrimSpace(string(plaintext)) != string(plaintext) {
		clear(plaintext)
		_ = s.repository.Complete(ctx, requestID)
		_ = s.repository.Audit(ctx, auditOf(auth, requestID, "secret.unavailable", 503))
		return Grant{}, ErrServiceUnavailable
	}
	_ = s.repository.Audit(ctx, auditOf(auth, requestID, "admitted", 0))
	return Grant{Authorization: auth, RequestID: requestID, APIKey: plaintext}, nil
}
func (s *Service) Complete(ctx context.Context, grant Grant, route, outcome string, status int, usage *Usage) {
	_ = s.repository.Complete(ctx, grant.RequestID)
	a := auditOf(grant.Authorization, grant.RequestID, outcome, status)
	a.Route = route
	a.Usage = usage
	_ = s.repository.Audit(ctx, a)
}
func active(a Authorization) bool {
	return a.TokenStatus == "active" && a.InventoryStatus == "active" && a.DeviceStatus == "active" && a.LicenseStatus == "active" && a.BindingStatus == "active" && a.SetupStatus == "configured" && a.BalanceStatus == "configured" && len(a.Envelope) > 0 && a.KeyVersion != "" && a.BaseURL != "" && a.DefaultModel != "" && a.RequestsPerMinute > 0 && a.ConcurrentRequests > 0
}
func contains(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}
func auditOf(a Authorization, requestID, outcome string, status int) Audit {
	return Audit{RequestID: requestID, TokenID: a.TokenID, InventoryID: a.InventoryID, DeviceID: a.DeviceID, LicenseID: a.LicenseID, Outcome: outcome, Status: status}
}
