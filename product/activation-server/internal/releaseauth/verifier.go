package releaseauth

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	maximumSafeInteger = uint64(9007199254740991)
	maximumLifetime    = 15 * time.Minute
)

var (
	ErrInvalid        = errors.New("release authorization invalid")
	releaseIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	sha256Pattern     = regexp.MustCompile(`^[a-f0-9]{64}$`)
	commitPattern     = regexp.MustCompile(`^[a-f0-9]{40}$`)
	requiredArtifacts = []string{"inventory.json", "runtime-manifest.json", "runtime-tree.sha256", "runtime.pkg", "sbom.spdx.json"}
)

type Artifact struct {
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	URL    string `json:"url,omitempty"`
}

type Evidence struct {
	BuildCompletedAt             string `json:"buildCompletedAt"`
	FinalRuntimeSmokeCompletedAt string `json:"finalRuntimeSmokeCompletedAt"`
	PromotionsCompletedAt        string `json:"promotionsCompletedAt"`
	UploadCompletedAt            string `json:"uploadCompletedAt"`
	CDNReadbackCompletedAt       string `json:"cdnReadbackCompletedAt"`
}

type Signature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

type Authorization struct {
	SchemaVersion           int                 `json:"schemaVersion"`
	Allowed                 bool                `json:"allowed"`
	Gate                    string              `json:"gate"`
	ReleaseID               string              `json:"releaseId"`
	RequiredReleaseSequence uint64              `json:"requiredReleaseSequence"`
	CommitSHA               string              `json:"commitSha"`
	ManifestURL             string              `json:"manifestUrl"`
	ManifestSHA256          string              `json:"manifestSha256"`
	RuntimeSHA256           string              `json:"runtimeSha256"`
	Artifacts               map[string]Artifact `json:"artifacts"`
	CDNReadback             map[string]Artifact `json:"cdnReadback"`
	Evidence                Evidence            `json:"evidence"`
	IssuedAt                string              `json:"issuedAt"`
	ExpiresAt               string              `json:"expiresAt"`
	Signature               Signature           `json:"signature"`
}

type ExpectedRelease struct {
	ReleaseSequence uint64
	ReleaseID       string
	ManifestURL     string
	ManifestSHA256  string
}

type Verifier struct {
	keyID     string
	publicKey ed25519.PublicKey
	clock     func() time.Time
}

func NewVerifier(keyID string, publicKey ed25519.PublicKey, clock func() time.Time) (*Verifier, error) {
	if !releaseIDPattern.MatchString(keyID) || len(publicKey) != ed25519.PublicKeySize {
		return nil, ErrInvalid
	}
	if clock == nil {
		clock = time.Now
	}
	return &Verifier{keyID: keyID, publicKey: append(ed25519.PublicKey(nil), publicKey...), clock: clock}, nil
}

func (verifier *Verifier) Verify(value Authorization, expected ExpectedRelease) error {
	if verifier == nil || value.SchemaVersion != 1 || !value.Allowed || value.Gate != "cdn-readback-complete" ||
		!releaseIDPattern.MatchString(value.ReleaseID) || value.RequiredReleaseSequence == 0 || value.RequiredReleaseSequence > maximumSafeInteger ||
		!commitPattern.MatchString(value.CommitSHA) || !sha256Pattern.MatchString(value.ManifestSHA256) || !sha256Pattern.MatchString(value.RuntimeSHA256) ||
		value.Signature.Algorithm != "ed25519" || value.Signature.KeyID != verifier.keyID {
		return ErrInvalid
	}
	issuedAt, issuedErr := time.Parse(time.RFC3339, value.IssuedAt)
	expiresAt, expiresErr := time.Parse(time.RFC3339, value.ExpiresAt)
	now := verifier.clock().UTC()
	if issuedErr != nil || expiresErr != nil || !expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > maximumLifetime || now.Before(issuedAt) || !now.Before(expiresAt) {
		return ErrInvalid
	}
	if !validEvidence(value.Evidence, issuedAt) || !validArtifactProof(value) || !validHTTPSURL(value.ManifestURL) {
		return ErrInvalid
	}
	signature, err := base64.StdEncoding.Strict().DecodeString(value.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(verifier.publicKey, SigningPayload(value), signature) {
		return ErrInvalid
	}
	if value.RequiredReleaseSequence != expected.ReleaseSequence || value.ReleaseID != expected.ReleaseID || value.ManifestURL != expected.ManifestURL || value.ManifestSHA256 != expected.ManifestSHA256 {
		return ErrInvalid
	}
	return nil
}

func SigningPayload(value Authorization) []byte {
	artifactRecords := make([]any, 0, len(requiredArtifacts))
	readbackRecords := make([]any, 0, len(requiredArtifacts))
	for _, name := range requiredArtifacts {
		artifact := value.Artifacts[name]
		readback := value.CDNReadback[name]
		artifactRecords = append(artifactRecords, []any{name, artifact.Bytes, artifact.SHA256})
		readbackRecords = append(readbackRecords, []any{name, readback.Bytes, readback.SHA256, readback.URL})
	}
	payload, _ := json.Marshal([]any{
		"uclaw-pointer-switch-authorization-v1", value.SchemaVersion, value.Allowed, value.Gate,
		value.ReleaseID, value.RequiredReleaseSequence, value.CommitSHA, value.ManifestURL, value.ManifestSHA256, value.RuntimeSHA256,
		artifactRecords, readbackRecords,
		value.Evidence.BuildCompletedAt, value.Evidence.FinalRuntimeSmokeCompletedAt, value.Evidence.PromotionsCompletedAt,
		value.Evidence.UploadCompletedAt, value.Evidence.CDNReadbackCompletedAt,
		value.IssuedAt, value.ExpiresAt, value.Signature.Algorithm, value.Signature.KeyID,
	})
	return payload
}

func validArtifactProof(value Authorization) bool {
	if len(value.Artifacts) != len(requiredArtifacts) || len(value.CDNReadback) != len(requiredArtifacts) {
		return false
	}
	names := make([]string, 0, len(value.Artifacts))
	for name := range value.Artifacts {
		names = append(names, name)
	}
	slices.Sort(names)
	if !slices.Equal(names, requiredArtifacts) {
		return false
	}
	for _, name := range requiredArtifacts {
		artifact, artifactOK := value.Artifacts[name]
		readback, readbackOK := value.CDNReadback[name]
		if !artifactOK || !readbackOK || artifact.Bytes < 1 || uint64(artifact.Bytes) > maximumSafeInteger || artifact.URL != "" || readback.Bytes != artifact.Bytes ||
			!sha256Pattern.MatchString(artifact.SHA256) || readback.SHA256 != artifact.SHA256 || !validArtifactURL(readback.URL, name) {
			return false
		}
	}
	manifest := value.Artifacts["runtime-manifest.json"]
	runtime := value.Artifacts["runtime.pkg"]
	return value.ManifestSHA256 == manifest.SHA256 && value.RuntimeSHA256 == runtime.SHA256 && value.ManifestURL == value.CDNReadback["runtime-manifest.json"].URL
}

func validEvidence(value Evidence, issuedAt time.Time) bool {
	raw := []string{value.BuildCompletedAt, value.FinalRuntimeSmokeCompletedAt, value.PromotionsCompletedAt, value.UploadCompletedAt, value.CDNReadbackCompletedAt}
	var previous time.Time
	for index, item := range raw {
		parsed, err := time.Parse(time.RFC3339, item)
		if err != nil || (index > 0 && parsed.Before(previous)) || parsed.After(issuedAt) {
			return false
		}
		previous = parsed
	}
	return true
}

func validArtifactURL(raw, name string) bool {
	if !validHTTPSURL(raw) {
		return false
	}
	parsed, _ := url.Parse(raw)
	return path.Base(parsed.Path) == name
}

func validHTTPSURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == "" && strings.TrimSpace(raw) == raw
}
