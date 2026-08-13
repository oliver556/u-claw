package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	adminservice "u-claw-activation-server/internal/admin"
	"u-claw-activation-server/internal/config"
	"u-claw-activation-server/internal/persistence"
)

type operatorCredential struct {
	OperatorID string `json:"operatorId"`
	Secret     string `json:"secret"`
}

type adminService interface {
	Generate(context.Context, adminservice.GenerateInput) ([]adminservice.InventorySummary, error)
	PrepareGenerate(adminservice.GenerateInput) (adminservice.GeneratePlan, error)
	ExecuteGenerate(context.Context, adminservice.GeneratePlan) ([]adminservice.InventorySummary, error)
	Import(context.Context, adminservice.ImportInput) ([]adminservice.InventorySummary, error)
	Show(context.Context, adminservice.InventoryLocator) (adminservice.InventorySummary, error)
	MutateLicense(context.Context, adminservice.Mutation) (adminservice.MutationResult, error)
	PrepareReissue(context.Context, adminservice.Mutation) (adminservice.ReissuePlan, error)
	ExecuteReissue(context.Context, adminservice.ReissuePlan) (adminservice.MutationResult, error)
	MarkConfigured(context.Context, adminservice.InventoryLocator, adminservice.Operation) (adminservice.InventorySummary, error)
}

func main() { os.Exit(realMain(context.Background(), os.Args[1:], os.Getenv, os.Stdout, os.Stderr)) }

func realMain(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	cfg, err := config.LoadFrom(getenv)
	if err != nil {
		fmt.Fprintln(stderr, "admin configuration invalid")
		return 1
	}
	pool, err := persistence.OpenPostgres(ctx, cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintln(stderr, "admin database unavailable")
		return 1
	}
	defer pool.Close()
	if err = persistence.VerifyMigrations(ctx, pool); err != nil {
		fmt.Fprintln(stderr, "admin migration failed")
		return 1
	}
	repository, err := persistence.NewActivationRepository(pool)
	if err != nil {
		fmt.Fprintln(stderr, "admin repository unavailable")
		return 1
	}
	service, err := adminservice.NewService(adminservice.ServiceOptions{Repository: repository, Pepper: cfg.ActivationPepper})
	if err != nil {
		fmt.Fprintln(stderr, "admin service unavailable")
		return 1
	}
	return run(ctx, args, getenv, service, stdout, stderr)
}

func run(ctx context.Context, args []string, getenv func(string) string, service adminService, stdout, stderr io.Writer) int {
	if len(args) < 2 || service == nil {
		fmt.Fprintln(stderr, "usage: inventory|license|new-api command")
		return 2
	}
	operatorID, credentialErr := loadOperatorCredential(getenv("UCLAW_OPERATOR_CREDENTIAL_FILE"), getenv("UCLAW_OPERATOR_ID"), getenv("ADMIN_OPERATORS_FILE"))
	if credentialErr != nil {
		fmt.Fprintln(stderr, "operator credential is invalid")
		return 2
	}
	op := adminservice.Operation{OperatorID: operatorID, RequestID: getenv("UCLAW_REQUEST_ID"), IdempotencyKey: getenv("UCLAW_IDEMPOTENCY_KEY")}
	if op.OperatorID == "" || op.RequestID == "" || op.IdempotencyKey == "" {
		fmt.Fprintln(stderr, "operator, request ID, and idempotency key are required")
		return 2
	}
	write := func(value any) int {
		if err := json.NewEncoder(stdout).Encode(value); err != nil {
			fmt.Fprintln(stderr, "encode output")
			return 1
		}
		return 0
	}
	switch args[0] + " " + args[1] {
	case "inventory generate":
		flags := flag.NewFlagSet("inventory generate", flag.ContinueOnError)
		flags.SetOutput(stderr)
		count := flags.Int("count", 0, "")
		reason := flags.String("reason", "", "")
		secretFile := flags.String("secret-file", "", "")
		if flags.Parse(args[2:]) != nil {
			return 2
		}
		op.Reason = *reason
		if strings.TrimSpace(op.Reason) == "" {
			fmt.Fprintln(stderr, "reason is required")
			return 2
		}
		plan, err := service.PrepareGenerate(adminservice.GenerateInput{Count: *count, Operation: op})
		if err != nil {
			return writeCLIError(stderr, err)
		}
		staged, err := stageInventorySecrets(*secretFile, plan.Secrets)
		if err != nil {
			return writeCLIError(stderr, err)
		}
		result, err := service.ExecuteGenerate(ctx, plan)
		if err != nil {
			staged.abort()
			return writeCLIError(stderr, err)
		}
		if err = staged.commit(); err != nil {
			return writeCLIError(stderr, err)
		}
		return write(result)
	case "inventory import":
		flags := flag.NewFlagSet("inventory import", flag.ContinueOnError)
		flags.SetOutput(stderr)
		file := flags.String("file", "", "")
		reason := flags.String("reason", "", "")
		if flags.Parse(args[2:]) != nil {
			return 2
		}
		records, err := readImport(*file)
		if err != nil {
			return writeCLIError(stderr, err)
		}
		op.Reason = *reason
		if strings.TrimSpace(op.Reason) == "" {
			fmt.Fprintln(stderr, "reason is required")
			return 2
		}
		result, err := service.Import(ctx, adminservice.ImportInput{Records: records, Operation: op})
		if err != nil {
			return writeCLIError(stderr, err)
		}
		return write(result)
	case "inventory show":
		flags := flag.NewFlagSet("inventory show", flag.ContinueOnError)
		flags.SetOutput(stderr)
		username := flags.String("username", "", "")
		id := flags.String("inventory-id", "", "")
		if flags.Parse(args[2:]) != nil {
			return 2
		}
		result, err := service.Show(ctx, adminservice.InventoryLocator{Username: *username, InventoryID: *id})
		if err != nil {
			return writeCLIError(stderr, err)
		}
		return write(result)
	case "new-api mark-configured":
		flags := flag.NewFlagSet("new-api mark-configured", flag.ContinueOnError)
		flags.SetOutput(stderr)
		device := flags.String("device-id", "", "")
		id := flags.String("inventory-id", "", "")
		reason := flags.String("reason", "", "")
		if flags.Parse(args[2:]) != nil {
			return 2
		}
		op.Reason = *reason
		if strings.TrimSpace(op.Reason) == "" {
			fmt.Fprintln(stderr, "reason is required")
			return 2
		}
		result, err := service.MarkConfigured(ctx, adminservice.InventoryLocator{DeviceID: *device, InventoryID: *id}, op)
		if err != nil {
			return writeCLIError(stderr, err)
		}
		return write(result)
	default:
		if args[0] != "license" {
			fmt.Fprintln(stderr, "unknown command")
			return 2
		}
		action := adminservice.Action(args[1])
		flags := flag.NewFlagSet("license "+args[1], flag.ContinueOnError)
		flags.SetOutput(stderr)
		licenseID := flags.String("license-id", "", "")
		confirmTarget := flags.String("confirm-target", "", "")
		reason := flags.String("reason", "", "")
		secretFile := flags.String("secret-file", "", "")
		if flags.Parse(args[2:]) != nil {
			return 2
		}
		op.Reason = *reason
		if strings.TrimSpace(op.Reason) == "" || *confirmTarget != adminservice.TargetDigest(*licenseID) {
			fmt.Fprintln(stderr, "reason is required")
			return 2
		}
		if action == adminservice.ActionReissue {
			plan, err := service.PrepareReissue(ctx, adminservice.Mutation{Action: action, LicenseID: *licenseID, ConfirmTarget: *confirmTarget, Operation: op})
			if err != nil {
				return writeCLIError(stderr, err)
			}
			staged, stageErr := stageReplacementSecret(*secretFile, plan.Secret)
			if stageErr != nil {
				return writeCLIError(stderr, stageErr)
			}
			result, err := service.ExecuteReissue(ctx, plan)
			if err != nil {
				staged.abort()
				return writeCLIError(stderr, err)
			}
			if err = staged.commit(); err != nil {
				return writeCLIError(stderr, err)
			}
			return write(result)
		}
		result, err := service.MutateLicense(ctx, adminservice.Mutation{Action: action, LicenseID: *licenseID, ConfirmTarget: *confirmTarget, Operation: op})
		if err != nil {
			return writeCLIError(stderr, err)
		}
		return write(result)
	}
}

func loadOperatorCredential(path, claimedID, operatorsPath string) (string, error) {
	if !filepath.IsAbs(path) || !filepath.IsAbs(operatorsPath) {
		return "", adminservice.ErrInvalidInput
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 || info.Size() < 1 || info.Size() > 4096 {
		return "", adminservice.ErrInvalidInput
	}
	file, err := os.Open(path)
	if err != nil {
		return "", adminservice.ErrInvalidInput
	}
	defer file.Close()
	var credential operatorCredential
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&credential); err != nil || decoder.Decode(&struct{}{}) != io.EOF || (claimedID != "" && credential.OperatorID != claimedID) || len(credential.Secret) < 32 || len(credential.Secret) > 512 {
		return "", adminservice.ErrInvalidInput
	}
	registry, err := loadOperatorRegistry(operatorsPath)
	if err != nil {
		return "", adminservice.ErrInvalidInput
	}
	authenticated, ok := registry.Authenticate(credential.Secret)
	if !ok || authenticated != credential.OperatorID {
		return "", adminservice.ErrInvalidInput
	}
	return credential.OperatorID, nil
}

func loadOperatorRegistry(path string) (adminservice.OperatorRegistry, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() < 2 || info.Size() > 4096 {
		return nil, adminservice.ErrInvalidInput
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, adminservice.ErrInvalidInput
	}
	var encoded map[string]string
	decoder := json.NewDecoder(bytes.NewReader(contents))
	if decoder.Decode(&encoded) != nil || decoder.Decode(&struct{}{}) != io.EOF || len(encoded) == 0 {
		return nil, adminservice.ErrInvalidInput
	}
	registry := make(adminservice.OperatorRegistry, len(encoded))
	for id, value := range encoded {
		decoded, decodeErr := hex.DecodeString(value)
		if decodeErr != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != value {
			return nil, adminservice.ErrInvalidInput
		}
		var digest [32]byte
		copy(digest[:], decoded)
		registry[id] = digest
	}
	return registry, nil
}

type stagedSecret struct{ temporary, final string }

func (value stagedSecret) abort() {
	if value.temporary != "" {
		_ = os.Remove(value.temporary)
	}
}
func (value stagedSecret) commit() error {
	if err := os.Link(value.temporary, value.final); err != nil {
		value.abort()
		return adminservice.ErrInvalidInput
	}
	value.abort()
	directory, err := os.Open(filepath.Dir(value.final))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func stageInventorySecrets(path string, values []adminservice.InventorySummary) (stagedSecret, error) {
	if path == "" {
		return stagedSecret{}, adminservice.ErrInvalidInput
	}
	rows := make([]map[string]string, len(values))
	for i, value := range values {
		if value.ActivationCode == "" {
			return stagedSecret{}, adminservice.ErrInvalidInput
		}
		rows[i] = map[string]string{"inventoryId": value.InventoryID, "username": value.Username, "activationCode": value.ActivationCode}
	}
	return stageSecretJSON(path, rows)
}
func stageReplacementSecret(path string, value adminservice.MutationResult) (stagedSecret, error) {
	if path == "" || value.ReplacementInventoryID == nil || value.ReplacementActivationCode == "" || value.ReplacementUsername == "" {
		return stagedSecret{}, adminservice.ErrInvalidInput
	}
	return stageSecretJSON(path, map[string]string{"inventoryId": *value.ReplacementInventoryID, "username": value.ReplacementUsername, "activationCode": value.ReplacementActivationCode})
}
func stageSecretJSON(path string, value any) (stagedSecret, error) {
	if !filepath.IsAbs(path) {
		return stagedSecret{}, adminservice.ErrInvalidInput
	}
	parent := filepath.Dir(path)
	info, err := os.Lstat(parent)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o022 != 0 {
		return stagedSecret{}, adminservice.ErrInvalidInput
	}
	if _, err = os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return stagedSecret{}, adminservice.ErrInvalidInput
	}
	file, err := os.CreateTemp(parent, ".uclaw-admin-secret-*")
	if err != nil {
		return stagedSecret{}, err
	}
	temporary := file.Name()
	cleanup := func() { _ = file.Close(); _ = os.Remove(temporary) }
	if err = file.Chmod(0o600); err != nil {
		cleanup()
		return stagedSecret{}, err
	}
	encoderErr := json.NewEncoder(file).Encode(value)
	if encoderErr == nil {
		encoderErr = file.Sync()
	}
	closeErr := file.Close()
	if encoderErr != nil {
		_ = os.Remove(temporary)
		return stagedSecret{}, encoderErr
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return stagedSecret{}, closeErr
	}
	return stagedSecret{temporary: temporary, final: path}, nil
}

func writeCLIError(stderr io.Writer, err error) int {
	if errors.Is(err, adminservice.ErrInvalidInput) {
		fmt.Fprintln(stderr, "invalid admin input")
		return 2
	}
	fmt.Fprintln(stderr, "admin operation failed")
	return 1
}
func readImport(path string) ([]adminservice.ImportRecord, error) {
	if path == "" {
		return nil, adminservice.ErrInvalidInput
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	rows, err := csv.NewReader(io.LimitReader(file, 16<<20)).ReadAll()
	if err != nil || len(rows) < 2 {
		return nil, adminservice.ErrInvalidInput
	}
	header := map[string]int{}
	for i, v := range rows[0] {
		header[v] = i
	}
	required := []string{"username", "activationCode", "newApiUserId", "newApiUsername", "policyDigest"}
	for _, key := range required {
		if _, ok := header[key]; !ok {
			return nil, adminservice.ErrInvalidInput
		}
	}
	records := make([]adminservice.ImportRecord, 0, len(rows)-1)
	for _, row := range rows[1:] {
		if len(row) != len(rows[0]) {
			return nil, adminservice.ErrInvalidInput
		}
		records = append(records, adminservice.ImportRecord{Username: row[header[required[0]]], ActivationCode: row[header[required[1]]], NewAPIUserID: row[header[required[2]]], NewAPIUsername: row[header[required[3]]], PolicyDigest: row[header[required[4]]]})
	}
	return records, nil
}

var _ = strconv.IntSize
var _ = strings.Builder{}
