package policy

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

type memoryRepository struct{ state ProductionState }

func (repository *memoryRepository) Production(context.Context) (ProductionState, error) {
	return repository.state, nil
}
func (repository *memoryRepository) Publish(_ context.Context, release Release) (ProductionState, error) {
	if !release.ManifestReadbackVerified || !release.CDNAvailable {
		return ProductionState{}, ErrArtifactUnavailable
	}
	if repository.state.Current != nil && release.ReleaseSequence <= repository.state.Current.ReleaseSequence {
		return ProductionState{}, ErrSequenceRegression
	}
	previous := repository.state.Current
	if previous != nil {
		copy := *previous
		copy.Status = ReleaseStatusStable
		previous = &copy
	}
	release.Status = ReleaseStatusCurrent
	repository.state = ProductionState{PolicyEpoch: repository.state.PolicyEpoch + 1, Current: &release, PreviousStable: previous}
	return repository.state, nil
}
func (repository *memoryRepository) ForwardRollback(_ context.Context, release Release) (ProductionState, error) {
	if repository.state.Current == nil || repository.state.PreviousStable == nil {
		return ProductionState{}, ErrPreviousStableUnavailable
	}
	if !release.ManifestReadbackVerified || !release.CDNAvailable {
		return ProductionState{}, ErrArtifactUnavailable
	}
	if release.ReleaseSequence <= repository.state.Current.ReleaseSequence {
		return ProductionState{}, ErrSequenceRegression
	}
	fault := *repository.state.Current
	fault.Status = ReleaseStatusWithdrawn
	stable := *repository.state.PreviousStable
	release.ContentVersion = stable.ContentVersion
	release.ContentSourceSequence = stable.ReleaseSequence
	release.RollbackFromSequence = fault.ReleaseSequence
	release.Reason = ReleaseReasonRollback
	release.Status = ReleaseStatusCurrent
	repository.state = ProductionState{PolicyEpoch: repository.state.PolicyEpoch + 1, Current: &release, PreviousStable: &stable, Withdrawn: &fault}
	return repository.state, nil
}

func fixtureService(t *testing.T, repository Repository, now time.Time) (*Service, ed25519.PublicKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(ServiceOptions{Repository: repository, KeyID: "release-policy-fixture", PrivateKey: privateKey, TTL: 5 * time.Minute, Clock: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	return service, publicKey
}

func readyRelease(sequence uint64, id, version string) Release {
	return Release{ReleaseSequence: sequence, ReleaseID: id, ContentVersion: version, Reason: ReleaseReasonRelease, ManifestURL: "https://cdn.example.test/releases/" + id + "/manifest.json", ManifestSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ManifestReadbackVerified: true, CDNAvailable: true, Status: ReleaseStatusCurrent}
}

func TestCurrentPolicyIsSignedFreshAndEpochBound(t *testing.T) {
	now := time.Date(2026, 8, 21, 1, 2, 3, 0, time.UTC)
	repository := &memoryRepository{state: ProductionState{PolicyEpoch: 107, Current: ptr(readyRelease(107, "release-107", "1.5.0"))}}
	service, publicKey := fixtureService(t, repository, now)
	got, err := service.Current(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.SchemaVersion != 1 || got.PolicyEpoch != 107 || got.RequiredReleaseSequence != 107 || got.ReleaseID != "release-107" || got.ContentVersion != "1.5.0" || got.Reason != ReleaseReasonRelease {
		t.Fatalf("policy=%+v", got)
	}
	if got.IssuedAt != "2026-08-21T01:02:03Z" || got.ExpiresAt != "2026-08-21T01:07:03Z" {
		t.Fatalf("freshness=%s..%s", got.IssuedAt, got.ExpiresAt)
	}
	signature, err := base64.StdEncoding.DecodeString(got.Signature.Value)
	if err != nil || !ed25519.Verify(publicKey, SigningPayload(got), signature) {
		t.Fatal("policy signature invalid")
	}
	tampered := got
	tampered.PolicyEpoch++
	if ed25519.Verify(publicKey, SigningPayload(tampered), signature) {
		t.Fatal("policy epoch was not signed")
	}
	tampered = got
	tampered.ExpiresAt = now.Add(-time.Second).Format(time.RFC3339)
	if ed25519.Verify(publicKey, SigningPayload(tampered), signature) {
		t.Fatal("policy expiry was not signed")
	}
	keys := map[string]ed25519.PublicKey{got.Signature.KeyID: publicKey}
	if err := VerifyClientPolicy(got, keys, now, 107); err != nil {
		t.Fatalf("verify=%v", err)
	}
	if err := VerifyClientPolicy(got, keys, now.Add(6*time.Minute), 107); !errors.Is(err, ErrPolicyExpired) {
		t.Fatalf("expired=%v", err)
	}
	if err := VerifyClientPolicy(got, keys, now, 108); !errors.Is(err, ErrPolicyEpochRegression) {
		t.Fatalf("epoch=%v", err)
	}
	tampered = got
	tampered.ManifestSHA256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if err := VerifyClientPolicy(tampered, keys, now, 107); !errors.Is(err, ErrPolicySignatureInvalid) {
		t.Fatalf("tampered=%v", err)
	}
}

func TestPublishMaintainsCurrentAndPreviousStableAndRejectsDowngrade(t *testing.T) {
	repository := &memoryRepository{}
	service, _ := fixtureService(t, repository, time.Now())
	if _, err := service.Publish(context.Background(), readyRelease(105, "release-105", "1.5.0")); err != nil {
		t.Fatal(err)
	}
	state, err := service.Publish(context.Background(), readyRelease(106, "release-106", "1.6.0"))
	if err != nil {
		t.Fatal(err)
	}
	if state.Current.ReleaseSequence != 106 || state.PreviousStable.ReleaseSequence != 105 || state.PolicyEpoch != 2 {
		t.Fatalf("state=%+v", state)
	}
	if _, err := service.Publish(context.Background(), readyRelease(105, "release-105b", "1.5.1")); !errors.Is(err, ErrSequenceRegression) {
		t.Fatalf("downgrade=%v", err)
	}
}

func TestForwardRollbackUsesStableContentAtHigherSequenceAndWithdrawsFault(t *testing.T) {
	repository := &memoryRepository{}
	service, _ := fixtureService(t, repository, time.Now())
	_, _ = service.Publish(context.Background(), readyRelease(105, "release-105", "1.5.0"))
	_, _ = service.Publish(context.Background(), readyRelease(106, "release-106", "1.6.0"))
	state, err := service.ForwardRollback(context.Background(), readyRelease(107, "release-107", "must-be-derived"))
	if err != nil {
		t.Fatal(err)
	}
	if state.Current.ReleaseSequence != 107 || state.Current.ContentVersion != "1.5.0" || state.Current.ContentSourceSequence != 105 || state.Current.RollbackFromSequence != 106 || state.Current.Reason != ReleaseReasonRollback {
		t.Fatalf("rollback=%+v", state.Current)
	}
	if state.PreviousStable.ReleaseSequence != 105 || state.Withdrawn.ReleaseSequence != 106 || state.Withdrawn.Status != ReleaseStatusWithdrawn {
		t.Fatalf("slots=%+v", state)
	}
	if _, err := service.ForwardRollback(context.Background(), readyRelease(106, "release-106b", "ignored")); !errors.Is(err, ErrSequenceRegression) {
		t.Fatalf("rollback downgrade=%v", err)
	}
}

func TestPolicyAndPromotionFailClosedForUnavailableArtifacts(t *testing.T) {
	notReady := readyRelease(108, "release-108", "1.8.0")
	notReady.ManifestReadbackVerified = false
	repository := &memoryRepository{state: ProductionState{PolicyEpoch: 108, Current: &notReady}}
	service, _ := fixtureService(t, repository, time.Now())
	if _, err := service.Current(context.Background()); !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("current=%v", err)
	}
	if _, err := service.Publish(context.Background(), notReady); !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("publish=%v", err)
	}
	notReady.ManifestReadbackVerified = true
	notReady.CDNAvailable = false
	if _, err := service.Publish(context.Background(), notReady); !errors.Is(err, ErrArtifactUnavailable) {
		t.Fatalf("cdn=%v", err)
	}
}

func TestClientGateRequiresExactReleaseSequence(t *testing.T) {
	for _, test := range []struct {
		local, required uint64
		allowed         bool
	}{{107, 107, true}, {106, 107, false}, {108, 107, false}} {
		if ExactReleaseMatch(test.local, test.required) != test.allowed {
			t.Fatalf("local=%d required=%d", test.local, test.required)
		}
	}
}

func TestPolicyJSONContainsOnlyPublicContract(t *testing.T) {
	repository := &memoryRepository{state: ProductionState{PolicyEpoch: 1, Current: ptr(readyRelease(1, "release-1", "1.0.0"))}}
	service, _ := fixtureService(t, repository, time.Now())
	clientPolicy, _ := service.Current(context.Background())
	encoded, _ := json.Marshal(clientPolicy)
	var object map[string]any
	_ = json.Unmarshal(encoded, &object)
	if len(object) != 11 {
		t.Fatalf("fields=%v", object)
	}
}

func ptr(release Release) *Release { return &release }
