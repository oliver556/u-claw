package policy

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	policySchemaVersion = 1
	maximumSafeInteger  = uint64(9007199254740991)
)

const (
	ReleaseReasonRelease  = "release"
	ReleaseReasonRollback = "rollback"

	ReleaseStatusCurrent   = "current"
	ReleaseStatusStable    = "stable"
	ReleaseStatusWithdrawn = "withdrawn"
)

var (
	ErrUnavailable               = errors.New("release policy unavailable")
	ErrInvalidRelease            = errors.New("release invalid")
	ErrArtifactUnavailable       = errors.New("release artifact unavailable")
	ErrSequenceRegression        = errors.New("release sequence must increase")
	ErrPreviousStableUnavailable = errors.New("previous stable release unavailable")
	ErrPolicySignatureInvalid    = errors.New("release policy signature invalid")
	ErrPolicyExpired             = errors.New("release policy expired")
	ErrPolicyEpochRegression     = errors.New("release policy epoch regressed")
	releaseIDPattern             = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	contentVersionPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$`)
	sha256Pattern                = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type Signature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

type ClientPolicy struct {
	SchemaVersion           int       `json:"schemaVersion"`
	PolicyEpoch             uint64    `json:"policyEpoch"`
	RequiredReleaseSequence uint64    `json:"requiredReleaseSequence"`
	ReleaseID               string    `json:"releaseId"`
	ContentVersion          string    `json:"contentVersion"`
	Reason                  string    `json:"reason"`
	ManifestURL             string    `json:"manifestUrl"`
	ManifestSHA256          string    `json:"manifestSha256"`
	IssuedAt                string    `json:"issuedAt"`
	ExpiresAt               string    `json:"expiresAt"`
	Signature               Signature `json:"signature"`
}

type Release struct {
	ReleaseSequence          uint64
	ReleaseID                string
	ContentVersion           string
	Reason                   string
	ManifestURL              string
	ManifestSHA256           string
	ManifestReadbackVerified bool
	CDNAvailable             bool
	Status                   string
	ContentSourceSequence    uint64
	RollbackFromSequence     uint64
}

type ProductionState struct {
	PolicyEpoch    uint64
	Current        *Release
	PreviousStable *Release
	Withdrawn      *Release
}

type Repository interface {
	Production(context.Context) (ProductionState, error)
	Publish(context.Context, Release) (ProductionState, error)
	ForwardRollback(context.Context, Release) (ProductionState, error)
}

type ServiceOptions struct {
	Repository Repository
	KeyID      string
	PrivateKey ed25519.PrivateKey
	TTL        time.Duration
	Clock      func() time.Time
}

type Service struct {
	repository Repository
	keyID      string
	privateKey ed25519.PrivateKey
	ttl        time.Duration
	clock      func() time.Time
}

func NewService(options ServiceOptions) (*Service, error) {
	if options.Repository == nil || !releaseIDPattern.MatchString(options.KeyID) || len(options.PrivateKey) != ed25519.PrivateKeySize || options.TTL < time.Minute || options.TTL > time.Hour {
		return nil, ErrUnavailable
	}
	clock := options.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Service{repository: options.Repository, keyID: options.KeyID, privateKey: append(ed25519.PrivateKey(nil), options.PrivateKey...), ttl: options.TTL, clock: clock}, nil
}

func (service *Service) Current(ctx context.Context) (ClientPolicy, error) {
	state, err := service.repository.Production(ctx)
	if err != nil || state.Current == nil || state.PolicyEpoch == 0 || state.PolicyEpoch > maximumSafeInteger {
		return ClientPolicy{}, ErrUnavailable
	}
	release := *state.Current
	if err := validateRelease(release, true); err != nil || release.Status != ReleaseStatusCurrent {
		if errors.Is(err, ErrArtifactUnavailable) {
			return ClientPolicy{}, ErrArtifactUnavailable
		}
		return ClientPolicy{}, ErrUnavailable
	}
	now := service.clock().UTC().Truncate(time.Second)
	result := ClientPolicy{
		SchemaVersion: policySchemaVersion, PolicyEpoch: state.PolicyEpoch, RequiredReleaseSequence: release.ReleaseSequence,
		ReleaseID: release.ReleaseID, ContentVersion: release.ContentVersion, Reason: release.Reason,
		ManifestURL: release.ManifestURL, ManifestSHA256: release.ManifestSHA256,
		IssuedAt: now.Format(time.RFC3339), ExpiresAt: now.Add(service.ttl).Format(time.RFC3339),
		Signature: Signature{Algorithm: "ed25519", KeyID: service.keyID},
	}
	result.Signature.Value = base64.StdEncoding.EncodeToString(ed25519.Sign(service.privateKey, SigningPayload(result)))
	return result, nil
}

func (service *Service) Publish(ctx context.Context, release Release) (ProductionState, error) {
	release.Reason = ReleaseReasonRelease
	release.ContentSourceSequence = release.ReleaseSequence
	if err := validateRelease(release, true); err != nil {
		return ProductionState{}, err
	}
	return service.repository.Publish(ctx, release)
}

func (service *Service) ForwardRollback(ctx context.Context, release Release) (ProductionState, error) {
	release.Reason = ReleaseReasonRollback
	if err := validateReleaseIdentity(release); err != nil {
		return ProductionState{}, err
	}
	if !release.ManifestReadbackVerified || !release.CDNAvailable {
		return ProductionState{}, ErrArtifactUnavailable
	}
	return service.repository.ForwardRollback(ctx, release)
}

func SigningPayload(policy ClientPolicy) []byte {
	payload, _ := json.Marshal([]any{
		"uclaw-release-policy-v1", policy.SchemaVersion, policy.PolicyEpoch, policy.RequiredReleaseSequence,
		policy.ReleaseID, policy.ContentVersion, policy.Reason, policy.ManifestURL, policy.ManifestSHA256,
		policy.IssuedAt, policy.ExpiresAt, policy.Signature.Algorithm, policy.Signature.KeyID,
	})
	return payload
}

func ExactReleaseMatch(localReleaseSequence, requiredReleaseSequence uint64) bool {
	return localReleaseSequence != 0 && localReleaseSequence == requiredReleaseSequence
}

func VerifyClientPolicy(clientPolicy ClientPolicy, publicKeys map[string]ed25519.PublicKey, now time.Time, minimumPolicyEpoch uint64) error {
	if clientPolicy.SchemaVersion != policySchemaVersion || clientPolicy.PolicyEpoch < minimumPolicyEpoch || clientPolicy.PolicyEpoch > maximumSafeInteger || clientPolicy.RequiredReleaseSequence == 0 || clientPolicy.RequiredReleaseSequence > maximumSafeInteger {
		return ErrPolicyEpochRegression
	}
	issuedAt, issuedErr := time.Parse(time.RFC3339, clientPolicy.IssuedAt)
	expiresAt, expiresErr := time.Parse(time.RFC3339, clientPolicy.ExpiresAt)
	if issuedErr != nil || expiresErr != nil || !expiresAt.After(issuedAt) || now.Before(issuedAt) || !now.Before(expiresAt) {
		return ErrPolicyExpired
	}
	publicKey := publicKeys[clientPolicy.Signature.KeyID]
	signature, err := base64.StdEncoding.DecodeString(clientPolicy.Signature.Value)
	if clientPolicy.Signature.Algorithm != "ed25519" || len(publicKey) != ed25519.PublicKeySize || err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(publicKey, SigningPayload(clientPolicy), signature) {
		return ErrPolicySignatureInvalid
	}
	return nil
}

func validateRelease(release Release, requireArtifact bool) error {
	if err := validateReleaseIdentity(release); err != nil {
		return err
	}
	if !contentVersionPattern.MatchString(release.ContentVersion) || (release.Reason != ReleaseReasonRelease && release.Reason != ReleaseReasonRollback) {
		return ErrInvalidRelease
	}
	if requireArtifact && (!release.ManifestReadbackVerified || !release.CDNAvailable) {
		return ErrArtifactUnavailable
	}
	return nil
}

func validateReleaseIdentity(release Release) error {
	if release.ReleaseSequence == 0 || release.ReleaseSequence > maximumSafeInteger || !releaseIDPattern.MatchString(release.ReleaseID) || !sha256Pattern.MatchString(release.ManifestSHA256) {
		return ErrInvalidRelease
	}
	parsed, err := url.Parse(release.ManifestURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || strings.TrimSpace(release.ManifestURL) != release.ManifestURL {
		return ErrInvalidRelease
	}
	return nil
}
