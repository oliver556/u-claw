package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	adminservice "u-claw-activation-server/internal/admin"
)

func trustedEnv(t *testing.T, overrides map[string]string) func(string) string {
	t.Helper()
	credential := filepath.Join(t.TempDir(), "operator.json")
	secret := "01234567890123456789012345678901"
	if err := os.WriteFile(credential, []byte(`{"operatorId":"operator_fixture","secret":"`+secret+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(secret))
	operators := filepath.Join(filepath.Dir(credential), "operators.json")
	if err := os.WriteFile(operators, []byte(`{"operator_fixture":"`+hex.EncodeToString(digest[:])+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{"UCLAW_OPERATOR_ID": "operator_fixture", "UCLAW_OPERATOR_CREDENTIAL_FILE": credential, "ADMIN_OPERATORS_FILE": operators, "UCLAW_REQUEST_ID": "request_fixture_001", "UCLAW_IDEMPOTENCY_KEY": "admin-fixture-001"}
	for key, value := range overrides {
		values[key] = value
	}
	return func(key string) string { return values[key] }
}

type fakeAdminService struct {
	mutation adminservice.Mutation
	mapping  adminservice.MappingInput
	token    adminservice.DeviceTokenMutation
	execute  func() error
}

func (service *fakeAdminService) PrepareGenerate(input adminservice.GenerateInput) (adminservice.GeneratePlan, error) {
	result, _ := service.Generate(context.Background(), input)
	return adminservice.GeneratePlan{Input: input, Secrets: result}, nil
}
func (service *fakeAdminService) ExecuteGenerate(_ context.Context, plan adminservice.GeneratePlan) ([]adminservice.InventorySummary, error) {
	if service.execute != nil {
		if err := service.execute(); err != nil {
			return nil, err
		}
	}
	return service.Generate(context.Background(), plan.Input)
}
func (service *fakeAdminService) PrepareReissue(_ context.Context, mutation adminservice.Mutation) (adminservice.ReissuePlan, error) {
	id := "inv_replacement_001"
	return adminservice.ReissuePlan{Mutation: mutation, Secret: adminservice.MutationResult{ReplacementInventoryID: &id, ReplacementActivationCode: "0123456789ABCDEFGHJKMNPQRS", ReplacementUsername: "UCLAW-FIXTURE-001-r2"}}, nil
}
func (service *fakeAdminService) ExecuteReissue(ctx context.Context, plan adminservice.ReissuePlan) (adminservice.MutationResult, error) {
	if service.execute != nil {
		if err := service.execute(); err != nil {
			return adminservice.MutationResult{}, err
		}
	}
	return service.MutateLicense(ctx, plan.Mutation)
}

func TestSecretFileStagesBeforeMutationAndPublishesAtomically(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "codes.json")
	service := &fakeAdminService{}
	service.execute = func() error {
		if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("final visible before mutation")
		}
		matches, _ := filepath.Glob(filepath.Join(directory, ".uclaw-admin-secret-*"))
		if len(matches) != 1 {
			t.Fatalf("staged=%v", matches)
		}
		info, _ := os.Stat(matches[0])
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("mode=%o", info.Mode().Perm())
		}
		return nil
	}
	var out, stderr bytes.Buffer
	env := trustedEnv(t, nil)
	if code := run(context.Background(), []string{"inventory", "generate", "--count", "1", "--reason", "stock", "--secret-file", target}, env, service, &out, &stderr); code != 0 {
		t.Fatalf("code=%d err=%s", code, stderr.String())
	}
	info, err := os.Stat(target)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("final mode=%v err=%v", info, err)
	}
}

func TestSecretFileFailureCleanupAndUnsafeTargets(t *testing.T) {
	directory := t.TempDir()
	env := trustedEnv(t, nil)
	runOne := func(target string, service *fakeAdminService) int {
		var out, stderr bytes.Buffer
		return run(context.Background(), []string{"inventory", "generate", "--count", "1", "--reason", "stock", "--secret-file", target}, env, service, &out, &stderr)
	}
	target := filepath.Join(directory, "failure.json")
	if code := runOne(target, &fakeAdminService{execute: func() error { return errors.New("database failed") }}); code == 0 {
		t.Fatal("failure accepted")
	}
	if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed mutation published secret")
	}
	matches, _ := filepath.Glob(filepath.Join(directory, ".uclaw-admin-secret-*"))
	if len(matches) != 0 {
		t.Fatalf("temp leak=%v", matches)
	}
	existing := filepath.Join(directory, "existing.json")
	if err := os.WriteFile(existing, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := runOne(existing, &fakeAdminService{}); code == 0 {
		t.Fatal("existing target overwritten")
	}
	unsafe := filepath.Join(directory, "unsafe")
	if err := os.Mkdir(unsafe, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(unsafe, 0o777); err != nil {
		t.Fatal(err)
	}
	if code := runOne(filepath.Join(unsafe, "codes.json"), &fakeAdminService{}); code == 0 {
		t.Fatal("unsafe parent accepted")
	}
}

func TestStagedSecretCommitAtomicallyCreatesWithoutReplacement(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "winner.json")
	first, err := stageSecretJSON(target, map[string]string{"winner": "first"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := stageSecretJSON(target, map[string]string{"winner": "second"})
	if err != nil {
		t.Fatal(err)
	}
	staged := []stagedSecret{first, second}
	errorsSeen := make([]error, 2)
	var wait sync.WaitGroup
	for index := range staged {
		wait.Add(1)
		go func(i int) { defer wait.Done(); errorsSeen[i] = staged[i].commit() }(index)
	}
	wait.Wait()
	successes := 0
	winner := ""
	for index, commitErr := range errorsSeen {
		if commitErr == nil {
			successes++
			if index == 0 {
				winner = "first"
			} else {
				winner = "second"
			}
		}
	}
	if successes != 1 {
		t.Fatalf("commit errors=%v", errorsSeen)
	}
	contents, err := os.ReadFile(target)
	if err != nil || !strings.Contains(string(contents), `"winner":"`+winner+`"`) {
		t.Fatalf("winner=%s contents=%s err=%v", winner, contents, err)
	}
	for _, item := range staged {
		if _, err = os.Lstat(item.temporary); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("temporary remains: %s", item.temporary)
		}
	}
}

func (*fakeAdminService) Generate(context.Context, adminservice.GenerateInput) ([]adminservice.InventorySummary, error) {
	return []adminservice.InventorySummary{{InventoryID: "inv_fixture_001", Username: "uclaw-001", Status: "prepared", ActivationCode: "0123456789ABCDEFGHJKMNPQRS"}}, nil
}
func (*fakeAdminService) Import(context.Context, adminservice.ImportInput) ([]adminservice.InventorySummary, error) {
	return nil, nil
}
func (*fakeAdminService) Show(context.Context, adminservice.InventoryLocator) (adminservice.InventorySummary, error) {
	return adminservice.InventorySummary{}, nil
}
func (service *fakeAdminService) MutateLicense(_ context.Context, mutation adminservice.Mutation) (adminservice.MutationResult, error) {
	service.mutation = mutation
	result := adminservice.MutationResult{LicenseID: mutation.LicenseID, Status: string(mutation.Action)}
	if mutation.Action == adminservice.ActionReissue {
		id := "inv_replacement_001"
		result.ReplacementInventoryID = &id
		result.ReplacementActivationCode = "0123456789ABCDEFGHJKMNPQRS"
	}
	return result, nil
}
func (*fakeAdminService) MarkConfigured(context.Context, adminservice.InventoryLocator, adminservice.Operation) (adminservice.InventorySummary, error) {
	return adminservice.InventorySummary{}, nil
}
func (service *fakeAdminService) SetMapping(_ context.Context, input adminservice.MappingInput) (adminservice.MappingSummary, error) {
	input.APIKey = append([]byte(nil), input.APIKey...)
	service.mapping = input
	return adminservice.MappingSummary{InventoryID: input.InventoryID, BaseURLHost: "api.example.test", Status: "configured", KeyVersion: "kms-v1"}, nil
}
func (*fakeAdminService) ShowMapping(_ context.Context, inventoryID string) (adminservice.MappingSummary, error) {
	return adminservice.MappingSummary{InventoryID: inventoryID, BaseURLHost: "api.example.test", Status: "configured", KeyVersion: "kms-v1"}, nil
}
func (service *fakeAdminService) MutateDeviceToken(_ context.Context, mutation adminservice.DeviceTokenMutation) (adminservice.DeviceTokenResult, error) {
	service.token = mutation
	return adminservice.DeviceTokenResult{DeviceTokenID: "00000000-0000-4000-8000-000000000004", InventoryID: "00000000-0000-4000-8000-000000000001", DeviceID: "00000000-0000-4000-8000-000000000002", LicenseID: mutation.LicenseID, Status: "active", DeviceToken: "uclaw_dt_" + strings.Repeat("A", 43)}, nil
}
func (service *fakeAdminService) PrepareDeviceTokenReissue(_ context.Context, mutation adminservice.DeviceTokenMutation) (adminservice.DeviceTokenReissuePlan, error) {
	result, _ := service.MutateDeviceToken(context.Background(), mutation)
	return adminservice.DeviceTokenReissuePlan{Mutation: mutation, Secret: result}, nil
}
func (service *fakeAdminService) ExecuteDeviceTokenReissue(ctx context.Context, plan adminservice.DeviceTokenReissuePlan) (adminservice.DeviceTokenResult, error) {
	if service.execute != nil {
		if err := service.execute(); err != nil {
			return adminservice.DeviceTokenResult{}, err
		}
	}
	return service.MutateDeviceToken(ctx, plan.Mutation)
}

func TestMappingSetReadsOnlySecureRegularKeyFileAndNeverLeaksSecret(t *testing.T) {
	directory := t.TempDir()
	secret := "runtime-" + strings.Repeat("k", 32)
	secure := filepath.Join(directory, "new-api.key")
	if err := os.WriteFile(secure, []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	service := &fakeAdminService{}
	args := []string{"mapping", "set", "--inventory-id", "00000000-0000-4000-8000-000000000001", "--new-api-user-id", "usr_fixture_001", "--new-api-username", "user_fixture_001", "--base-url", "https://api.example.test/v1", "--default-model", "model-a", "--allowed-models", "model-a,model-b", "--requests-per-minute", "60", "--concurrent-requests", "2", "--key-file", secure, "--reason", "provision"}
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), args, trustedEnv(t, nil), service, &stdout, &stderr)
	if code != 0 || string(service.mapping.APIKey) != secret {
		t.Fatalf("code=%d out=%s err=%s", code, stdout.String(), stderr.String())
	}
	if strings.Contains(stdout.String()+stderr.String(), secret) || strings.Contains(stdout.String()+stderr.String(), "Authorization") || strings.Contains(stdout.String()+stderr.String(), "opaque-envelope") {
		t.Fatal("secret leaked")
	}

	unsafe := filepath.Join(directory, "unsafe.key")
	if err := os.WriteFile(unsafe, []byte(secret), 0o644); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(directory, "link.key")
	if err := os.Symlink(secure, symlink); err != nil {
		t.Fatal(err)
	}
	empty := filepath.Join(directory, "empty.key")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	long := filepath.Join(directory, "long.key")
	if err := os.WriteFile(long, bytes.Repeat([]byte{'x'}, maxAPIKeyFileBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{unsafe, symlink, empty, long} {
		candidate := append([]string(nil), args...)
		candidate[17] = path
		stdout.Reset()
		stderr.Reset()
		if code = run(context.Background(), candidate, trustedEnv(t, nil), service, &stdout, &stderr); code == 0 {
			t.Fatalf("unsafe key file accepted: %s", path)
		}
		if strings.Contains(stdout.String()+stderr.String(), secret) {
			t.Fatal("rejected secret leaked")
		}
	}
}

func TestDeviceTokenReissueWritesOnlyOutputFile(t *testing.T) {
	service := &fakeAdminService{}
	licenseID := "00000000-0000-4000-8000-000000000003"
	target := filepath.Join(t.TempDir(), "device-token.json")
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), []string{"device-token", "reissue", "--license-id", licenseID, "--confirm-target", adminservice.TargetDigest(licenseID), "--reason", "replace credential", "--output-file", target}, trustedEnv(t, nil), service, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("code=%d err=%s", code, stderr.String())
	}
	contents, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(contents), `"schemaVersion":1`) || !strings.Contains(string(contents), `"deviceToken":"uclaw_dt_`) {
		t.Fatalf("contents=%s", contents)
	}
	if strings.Contains(stdout.String()+stderr.String(), "uclaw_dt_") {
		t.Fatal("token leaked to console")
	}
	info, _ := os.Stat(target)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%o", info.Mode().Perm())
	}
}

func TestRunRequiresTrustedOperatorAndReason(t *testing.T) {
	service := &fakeAdminService{}
	for _, test := range []struct {
		name string
		env  map[string]string
		args []string
	}{
		{"operator", map[string]string{}, []string{"license", "revoke", "--license-id", "lic_fixture_001", "--reason", "support"}},
		{"reason", map[string]string{"UCLAW_OPERATOR_ID": "operator_fixture"}, []string{"license", "revoke", "--license-id", "lic_fixture_001"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := run(context.Background(), test.args, func(key string) string { return test.env[key] }, service, &stdout, &stderr)
			if code == 0 {
				t.Fatal("invalid CLI accepted")
			}
		})
	}
	var stdout, stderr bytes.Buffer
	licenseID := "lic_fixture_001"
	code := run(context.Background(), []string{"license", "reissue", "--license-id", licenseID, "--confirm-target", adminservice.TargetDigest(licenseID), "--reason", "support request", "--secret-file", t.TempDir() + "/replacement.json"}, trustedEnv(t, nil), service, &stdout, &stderr)
	if code != 0 || service.mutation.Operation.OperatorID != "operator_fixture" || strings.Contains(stdout.String(), "secret") {
		t.Fatalf("code=%d mutation=%#v stderr=%s", code, service.mutation, stderr.String())
	}
}

func TestRunGenerateOutputsRedactedJSON(t *testing.T) {
	var stdout, stderr bytes.Buffer
	env := trustedEnv(t, nil)
	code := run(context.Background(), []string{"inventory", "generate", "--count", "1", "--reason", "stock", "--secret-file", t.TempDir() + "/codes.json"}, env, &fakeAdminService{}, &stdout, &stderr)
	if code != 0 || !strings.Contains(stdout.String(), "inv_fixture_001") || strings.Contains(stdout.String(), "activationCode") {
		t.Fatalf("code=%d out=%s err=%s", code, stdout.String(), stderr.String())
	}
}

func TestRunRejectsUntrustedOperatorAndMissingTargetConfirmation(t *testing.T) {
	service := &fakeAdminService{}
	licenseID := "lic_fixture_001"
	for name, env := range map[string]func(string) string{
		"missing credential": trustedEnv(t, map[string]string{"UCLAW_OPERATOR_CREDENTIAL_FILE": ""}),
		"identity mismatch":  trustedEnv(t, map[string]string{"UCLAW_OPERATOR_ID": "operator_other"}),
	} {
		t.Run(name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if run(context.Background(), []string{"license", "revoke", "--license-id", licenseID, "--confirm-target", adminservice.TargetDigest(licenseID), "--reason", "support"}, env, service, &stdout, &stderr) == 0 {
				t.Fatal("untrusted operator accepted")
			}
		})
	}
	for _, confirmation := range []string{"", strings.Repeat("0", 64)} {
		var stdout, stderr bytes.Buffer
		if run(context.Background(), []string{"license", "revoke", "--license-id", licenseID, "--confirm-target", confirmation, "--reason", "support"}, trustedEnv(t, nil), service, &stdout, &stderr) == 0 {
			t.Fatal("invalid target confirmation accepted")
		}
	}
}
