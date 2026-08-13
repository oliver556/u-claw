package admin

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"
)

type fakeRepository struct {
	created  []InventoryRecord
	shown    InventorySummary
	mutation Mutation
	target   ReissueTarget
	audit    []AuditEvent
	query    AuditQuery
	mapping  MappingInput
	token    DeviceTokenMutation
}

type fakeSecretEnvelope struct {
	binding   SecretBinding
	plaintext []byte
}

func (envelope *fakeSecretEnvelope) Encrypt(_ context.Context, binding SecretBinding, plaintext []byte) ([]byte, error) {
	envelope.binding = binding
	envelope.plaintext = append([]byte(nil), plaintext...)
	return []byte("opaque-envelope"), nil
}

func (repository *fakeRepository) PrepareReissueTarget(context.Context, Mutation) (ReissueTarget, error) {
	if repository.target.Revision != 0 {
		return repository.target, nil
	}
	return ReissueTarget{Username: "UCLAW-FIXTURE-001", Revision: 4}, nil
}

func TestPrepareReissueReplayReturnsSameCredential(t *testing.T) {
	repository := &fakeRepository{target: ReissueTarget{Username: "UCLAW-FIXTURE-001", Revision: 4}}
	service, _ := NewService(ServiceOptions{Repository: repository, Pepper: bytes.Repeat([]byte{1}, 32)})
	mutation := Mutation{Action: ActionReissue, LicenseID: "lic_fixture_001", ConfirmTarget: TargetDigest("lic_fixture_001"), Operation: operation()}
	first, err := service.PrepareReissue(context.Background(), mutation)
	if err != nil {
		t.Fatal(err)
	}
	repository.target = ReissueTarget{Username: "UCLAW-FIXTURE-001", Revision: 4}
	second, err := service.PrepareReissue(context.Background(), mutation)
	if err != nil {
		t.Fatal(err)
	}
	if first.Secret.ReplacementInventoryID == nil || second.Secret.ReplacementInventoryID == nil || *first.Secret.ReplacementInventoryID != *second.Secret.ReplacementInventoryID || first.Secret.ReplacementActivationCode != second.Secret.ReplacementActivationCode || first.Secret.ReplacementUsername != second.Secret.ReplacementUsername || first.Mutation.Replacement.UsernameDisplay != second.Mutation.Replacement.UsernameDisplay || first.Mutation.Replacement.EntitlementRevision != second.Mutation.Replacement.EntitlementRevision {
		t.Fatalf("replay changed credential: first=%#v second=%#v", first, second)
	}
}
func (repository *fakeRepository) Audit(_ context.Context, query AuditQuery) ([]AuditEvent, error) {
	repository.query = query
	return repository.audit, nil
}

func TestAuditCursorRoundTripsTimestampAndUUID(t *testing.T) {
	want := AuditCursor{CreatedAt: time.Date(2026, 8, 13, 1, 2, 3, 456, time.UTC), EventID: "00000000-0000-4000-8000-000000000002"}
	encoded := EncodeAuditCursor(want)
	got, err := DecodeAuditCursor(encoded)
	if err != nil || !got.CreatedAt.Equal(want.CreatedAt) || got.EventID != want.EventID {
		t.Fatalf("cursor=%+v error=%v encoded=%q", got, err, encoded)
	}
	for _, invalid := range []string{"", "not-base64", "e30", EncodeAuditCursor(AuditCursor{CreatedAt: want.CreatedAt, EventID: "not-a-uuid"})} {
		if _, err = DecodeAuditCursor(invalid); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid cursor %q error=%v", invalid, err)
		}
	}
}

func TestAuditReturnsStableNextCursorAtPageBoundary(t *testing.T) {
	createdAt := "2026-08-13T01:02:03.000000456Z"
	repository := &fakeRepository{audit: []AuditEvent{
		{EventID: "00000000-0000-4000-8000-000000000003", CreatedAt: createdAt},
		{EventID: "00000000-0000-4000-8000-000000000002", CreatedAt: createdAt},
		{EventID: "00000000-0000-4000-8000-000000000001", CreatedAt: createdAt},
	}}
	service, _ := NewService(ServiceOptions{Repository: repository, Pepper: bytes.Repeat([]byte{1}, 32)})
	page, err := service.Audit(context.Background(), AuditQuery{Limit: 2})
	if err != nil || len(page.Items) != 2 || page.NextBefore == nil {
		t.Fatalf("page=%+v error=%v", page, err)
	}
	cursor, err := DecodeAuditCursor(*page.NextBefore)
	if err != nil || cursor.EventID != page.Items[1].EventID || cursor.CreatedAt.Format(time.RFC3339Nano) != createdAt {
		t.Fatalf("cursor=%+v error=%v", cursor, err)
	}
	if repository.query.Limit != 3 {
		t.Fatalf("repository limit=%d", repository.query.Limit)
	}
}

func (repository *fakeRepository) CreateInventory(_ context.Context, records []InventoryRecord, operation Operation) ([]InventorySummary, error) {
	repository.created = append([]InventoryRecord(nil), records...)
	return []InventorySummary{{InventoryID: "inv_fixture_001", Username: records[0].Username, Status: "prepared", NewAPISetupStatus: "pending"}}, nil
}
func (repository *fakeRepository) ShowInventory(context.Context, InventoryLocator) (InventorySummary, error) {
	return repository.shown, nil
}
func (repository *fakeRepository) Mutate(_ context.Context, mutation Mutation) (MutationResult, error) {
	repository.mutation = mutation
	return MutationResult{LicenseID: mutation.LicenseID, Status: string(mutation.Action), Revision: 2}, nil
}
func (repository *fakeRepository) MarkConfigured(_ context.Context, locator InventoryLocator, operation Operation) (InventorySummary, error) {
	return InventorySummary{InventoryID: locator.InventoryID, Status: "prepared", NewAPISetupStatus: "configured"}, nil
}

func operation() Operation {
	return Operation{OperatorID: "operator_fixture", RequestID: "request_fixture_001", IdempotencyKey: "admin-fixture-001", Reason: "customer support request"}
}

func TestGenerateCreatesDigestOnlyAndReturnsRedactedSummary(t *testing.T) {
	repository := &fakeRepository{}
	service, err := NewService(ServiceOptions{Repository: repository, Pepper: bytes.Repeat([]byte{1}, 32), Random: bytes.NewReader(bytes.Repeat([]byte{2}, 256))})
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Generate(context.Background(), GenerateInput{Count: 1, Operation: operation()})
	if err != nil {
		t.Fatal(err)
	}
	if len(repository.created) != 1 || len(repository.created[0].ActivationCodeDigest) != 32 {
		t.Fatalf("created=%#v", repository.created)
	}
	if repository.created[0].ActivationCode == "" || result[0].ActivationCode == "" || strings.Contains(strings.Join([]string{result[0].InventoryID, result[0].Username}, " "), "0123456789ABCDEFGHJKMNPQRS") {
		t.Fatal("admin output leaked generated activation material")
	}
	if repository.created[0].Username != strings.ToUpper(result[0].Username) {
		t.Fatalf("generated normalized username=%q display=%q", repository.created[0].Username, result[0].Username)
	}
}

func TestDangerousMutationRequiresActorReasonAndIdempotency(t *testing.T) {
	repository := &fakeRepository{}
	service, err := NewService(ServiceOptions{Repository: repository, Pepper: bytes.Repeat([]byte{1}, 32), Random: bytes.NewReader(bytes.Repeat([]byte{3}, 256))})
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Operation){
		"operator":    func(value *Operation) { value.OperatorID = "" },
		"reason":      func(value *Operation) { value.Reason = "" },
		"request":     func(value *Operation) { value.RequestID = "" },
		"idempotency": func(value *Operation) { value.IdempotencyKey = "" },
	} {
		t.Run(name, func(t *testing.T) {
			op := operation()
			mutate(&op)
			_, err := service.MutateLicense(context.Background(), Mutation{Action: ActionRevoke, LicenseID: "lic_fixture_001", ConfirmTarget: TargetDigest("lic_fixture_001"), Operation: op})
			if err == nil {
				t.Fatal("invalid mutation accepted")
			}
		})
	}
	result, err := service.MutateLicense(context.Background(), Mutation{Action: ActionReissue, LicenseID: "lic_fixture_001", ConfirmTarget: TargetDigest("lic_fixture_001"), Operation: operation()})
	if err != nil || result.Status != "reissue" || repository.mutation.Action != ActionReissue {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	if repository.mutation.Replacement == nil || repository.mutation.Replacement.InventoryID == "" || len(repository.mutation.Replacement.ActivationCodeDigest) != 32 || repository.mutation.Replacement.ActivationCode == "" {
		t.Fatalf("replacement=%#v", repository.mutation.Replacement)
	}
	if repository.mutation.Replacement.UsernameDisplay != "UCLAW-FIXTURE-001-r5" || repository.mutation.Replacement.EntitlementRevision != 5 {
		t.Fatalf("replacement identity=%#v", repository.mutation.Replacement)
	}
	if repository.mutation.Replacement.Username != strings.ToUpper(repository.mutation.Replacement.UsernameDisplay) {
		t.Fatalf("reissue normalized username=%q", repository.mutation.Replacement.Username)
	}
}

func TestImportNormalizesCodesButDoesNotExposeThem(t *testing.T) {
	repository := &fakeRepository{}
	service, _ := NewService(ServiceOptions{Repository: repository, Pepper: bytes.Repeat([]byte{1}, 32), Random: bytes.NewReader(bytes.Repeat([]byte{4}, 256))})
	input := ImportInput{Records: []ImportRecord{{Username: " UCLAW-IMPORT-001 ", ActivationCode: "01234-56789-abcde-fghjk-mnpqrs", NewAPIUserID: "usr_import_001", NewAPIUsername: "uclaw_import_001", PolicyDigest: strings.Repeat("a", 64)}}, Operation: operation()}
	result, err := service.Import(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if repository.created[0].Username != "UCLAW-IMPORT-001" || repository.created[0].ActivationCode != "" {
		t.Fatalf("record=%#v", repository.created[0])
	}
	if strings.Contains(result[0].Username, "0123456789") {
		t.Fatal("import output leaked activation code")
	}
}

func (repository *fakeRepository) SetMapping(_ context.Context, input MappingInput) (MappingSummary, error) {
	repository.mapping = input
	u, _ := url.Parse(input.BaseURL)
	return MappingSummary{InventoryID: input.InventoryID, NewAPIUserID: input.NewAPIUserID, NewAPIUsername: input.NewAPIUsername, BaseURLHost: u.Host, DefaultModel: input.DefaultModel, AllowedModels: input.AllowedModels, RequestsPerMinute: input.RequestsPerMinute, ConcurrentRequests: input.ConcurrentRequests, KeyVersion: input.KeyVersion, Status: "configured"}, nil
}
func (repository *fakeRepository) ShowMapping(_ context.Context, inventoryID string) (MappingSummary, error) {
	return MappingSummary{InventoryID: inventoryID, BaseURLHost: "api.example.test", Status: "configured"}, nil
}
func (repository *fakeRepository) MutateDeviceToken(_ context.Context, mutation DeviceTokenMutation) (DeviceTokenResult, error) {
	repository.token = mutation
	return DeviceTokenResult{DeviceTokenID: mutation.ReplacementTokenID, InventoryID: "00000000-0000-4000-8000-000000000001", DeviceID: "00000000-0000-4000-8000-000000000002", LicenseID: mutation.LicenseID, Status: string(mutation.Action)}, nil
}
func (*fakeRepository) PrepareDeviceTokenTarget(_ context.Context, licenseID string) (DeviceTokenResult, error) {
	return DeviceTokenResult{InventoryID: "00000000-0000-4000-8000-000000000001", DeviceID: "00000000-0000-4000-8000-000000000002", LicenseID: licenseID, Status: "active"}, nil
}

func TestSetMappingEncryptsAPIKeyWithInventoryBindingAndReturnsRedactedSummary(t *testing.T) {
	repository := &fakeRepository{}
	envelope := &fakeSecretEnvelope{}
	service, err := NewService(ServiceOptions{Repository: repository, Pepper: bytes.Repeat([]byte{1}, 32), SecretEnvelope: envelope, KeyVersion: "kms-v1"})
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("runtime-" + strings.Repeat("s", 32))
	input := MappingInput{InventoryID: "00000000-0000-4000-8000-000000000001", NewAPIUserID: "usr_fixture_001", NewAPIUsername: "user_fixture_001", BaseURL: "https://api.example.test/v1", DefaultModel: "model-a", AllowedModels: []string{"model-a", "model-b"}, RequestsPerMinute: 60, ConcurrentRequests: 2, APIKey: secret, Operation: operation()}
	result, err := service.SetMapping(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.binding != (SecretBinding{Purpose: "new-api-key", SubjectID: input.InventoryID, KeyVersion: "kms-v1"}) || !bytes.Equal(envelope.plaintext, secret) {
		t.Fatalf("binding=%+v", envelope.binding)
	}
	if string(repository.mapping.APIKeyEnvelope) != "opaque-envelope" || len(repository.mapping.APIKey) != 0 || repository.mapping.KeyVersion != "kms-v1" {
		t.Fatalf("stored=%+v", repository.mapping)
	}
	encoded := result.InventoryID + result.BaseURLHost + result.Status
	if strings.Contains(encoded, string(secret)) || result.BaseURLHost != "api.example.test" {
		t.Fatalf("result=%+v", result)
	}
}

func TestSetMappingRejectsUnsafeEndpointModelsAndLimits(t *testing.T) {
	service, _ := NewService(ServiceOptions{Repository: &fakeRepository{}, Pepper: bytes.Repeat([]byte{1}, 32), SecretEnvelope: &fakeSecretEnvelope{}, KeyVersion: "kms-v1"})
	valid := MappingInput{InventoryID: "00000000-0000-4000-8000-000000000001", NewAPIUserID: "usr_fixture_001", NewAPIUsername: "user_fixture_001", BaseURL: "https://api.example.test/v1", DefaultModel: "model-a", AllowedModels: []string{"model-a"}, RequestsPerMinute: 60, ConcurrentRequests: 2, APIKey: []byte("key"), Operation: operation()}
	mutations := []func(*MappingInput){func(v *MappingInput) { v.BaseURL = "http://api.example.test" }, func(v *MappingInput) { v.BaseURL = "https://user@api.example.test" }, func(v *MappingInput) { v.BaseURL = "https://api.example.test/@unsafe" }, func(v *MappingInput) { v.DefaultModel = "other" }, func(v *MappingInput) { v.AllowedModels = []string{"model-a", "model-a"} }, func(v *MappingInput) { v.RequestsPerMinute = 6001 }, func(v *MappingInput) { v.ConcurrentRequests = 0 }}
	for _, mutate := range mutations {
		candidate := valid
		candidate.AllowedModels = append([]string(nil), valid.AllowedModels...)
		mutate(&candidate)
		if _, err := service.SetMapping(context.Background(), candidate); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("accepted=%+v err=%v", candidate, err)
		}
	}
}

func TestDeviceTokenReissueGeneratesOpaqueCredentialAndDigest(t *testing.T) {
	repository := &fakeRepository{}
	service, _ := NewService(ServiceOptions{Repository: repository, Pepper: bytes.Repeat([]byte{9}, 32), Random: bytes.NewReader(bytes.Repeat([]byte{5}, 128))})
	mutation := DeviceTokenMutation{Action: DeviceTokenReissue, LicenseID: "00000000-0000-4000-8000-000000000003", ConfirmTarget: TargetDigest("00000000-0000-4000-8000-000000000003"), Operation: operation()}
	result, err := service.MutateDeviceToken(context.Background(), mutation)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(result.DeviceToken, "uclaw_dt_") || len(result.DeviceToken) != len("uclaw_dt_")+43 || len(repository.token.ReplacementDigest) != 32 || repository.token.ReplacementTokenID == "" {
		t.Fatalf("result=%+v mutation=%+v", result, repository.token)
	}
	if repository.token.DeviceToken != "" {
		t.Fatal("repository received plaintext token")
	}
}
