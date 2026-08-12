package admin

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

type fakeRepository struct {
	created  []InventoryRecord
	shown    InventorySummary
	mutation Mutation
	target   ReissueTarget
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
func (*fakeRepository) Audit(context.Context, AuditQuery) ([]AuditEvent, error) { return nil, nil }

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
