package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"uclaw-cloud-api/internal/activation"
	"uclaw-cloud-api/internal/admin"
	"uclaw-cloud-api/internal/config"
	"uclaw-cloud-api/internal/newapi"
	"uclaw-cloud-api/internal/postgres"
	"uclaw-cloud-api/internal/provisioning"
)

// main provides operational commands that do not belong in the public HTTP process.
func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "activation":
		runActivation(os.Args[2:])
	case "spike":
		runSpike(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
}

// runActivation handles activation-code operational commands.
func runActivation(args []string) {
	if len(args) < 1 {
		usage()
		os.Exit(2)
	}
	switch args[0] {
	case "generate":
		runActivationGenerate(args[1:])
	case "seed":
		runActivationSeed(args[1:])
	default:
		usage()
		os.Exit(2)
	}
}

// runActivationGenerate prints human-readable codes for USB-card operations.
func runActivationGenerate(args []string) {
	count := 10
	if len(args) > 0 {
		parsed, err := strconv.Atoi(args[0])
		if err != nil || parsed <= 0 {
			log.Fatalf("invalid activation count %q", args[0])
		}
		count = parsed
	}
	for i := 0; i < count; i++ {
		code, err := admin.GenerateActivationCode()
		if err != nil {
			log.Fatalf("generate activation code: %v", err)
		}
		fmt.Println(code)
	}
}

// runActivationSeed persists an already printed activation code into PostgreSQL.
func runActivationSeed(args []string) {
	code := requiredFlag(args, "--code")
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if cfg.DatabaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	store, err := postgres.Open(context.Background(), cfg.DatabaseURL, cfg.ActivationCodePepper)
	if err != nil {
		log.Fatalf("postgres: %v", err)
	}
	defer func() {
		if err := store.Close(); err != nil {
			log.Printf("close postgres: %v", err)
		}
	}()

	batchID := sql.NullInt64{}
	if raw := optionalFlag(args, "--batch-id", ""); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			log.Fatalf("--batch-id must be a positive integer")
		}
		batchID = sql.NullInt64{Int64: parsed, Valid: true}
	}
	if err := store.SeedActivationCode(context.Background(), code, batchID); err != nil {
		log.Fatalf("seed activation code: %v", err)
	}
	printJSON(map[string]any{"step": "activation_seed", "ok": true})
}

// runSpike handles external-system verification commands for Phase 0.
func runSpike(args []string) {
	if len(args) < 1 || args[0] != "newapi" || len(args) < 2 {
		usage()
		os.Exit(2)
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	client, err := newapi.NewClient(cfg.NewAPIAdminBaseURL, cfg.NewAPIAdminToken, nil, newapi.WithAdminCredentials(cfg.NewAPIAdminUsername, cfg.NewAPIAdminPassword))
	if err != nil {
		log.Fatalf("newapi client: %v", err)
	}

	command := args[1]
	commandArgs := args[2:]
	if strings.HasPrefix(command, "--") {
		command = "full"
		commandArgs = args[1:]
	}

	ctx := context.Background()
	switch command {
	case "create-user":
		spikeCreateUser(ctx, client, commandArgs)
	case "create-token":
		spikeCreateToken(ctx, client, commandArgs)
	case "add-quota":
		spikeAddQuota(ctx, client, commandArgs)
	case "provision":
		spikeProvision(ctx, client, cfg, commandArgs)
	case "user-models":
		spikeUserModels(ctx, client, commandArgs)
	case "full":
		spikeFull(ctx, client, commandArgs)
	default:
		usage()
		os.Exit(2)
	}
}

// spikeProvisionStore captures New API account mappings for local spike output.
type spikeProvisionStore struct {
	account provisioning.Account
}

// SaveNewAPIAccount captures provisioning output without writing local spike data to production DB.
func (s *spikeProvisionStore) SaveNewAPIAccount(_ context.Context, account provisioning.Account) error {
	s.account = account
	return nil
}

// spikeProvision verifies the production New API orchestration path without printing raw API keys.
func spikeProvision(ctx context.Context, client *newapi.Client, cfg config.Config, args []string) {
	username := requiredFlag(args, "--username")
	quota := cfg.NewAPIActivationQuota
	if raw := optionalFlag(args, "--quota", ""); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			log.Fatalf("--quota must be a non-negative integer")
		}
		quota = parsed
	}
	store := &spikeProvisionStore{}
	service, err := provisioning.NewService(client, store, provisioning.Config{
		ClientBaseURL:  cfg.NewAPIClientBaseURL,
		TokenName:      cfg.NewAPITokenName,
		InitialQuota:   quota,
		PasswordSecret: cfg.NewAPIUserPasswordSecret,
	})
	if err != nil {
		log.Fatalf("provision service: %v", err)
	}
	result, err := service.ProvisionNewAPI(ctx, activation.ProvisionRequest{UserID: time.Now().Unix(), Phone: username})
	if err != nil {
		log.Fatalf("provision newapi: %v", err)
	}
	printJSON(map[string]any{
		"step":              "provision",
		"ok":                true,
		"username":          username,
		"newapi_user_id":    result.NewAPIUserID,
		"token_present":     result.Token != "",
		"token_version":     result.TokenVersion,
		"quota":             quota,
		"mapping_persisted": store.account.NewAPIUserID == result.NewAPIUserID,
	})
}

// spikeCreateUser verifies New API user creation with the planned phone-as-username rule.
func spikeCreateUser(ctx context.Context, client *newapi.Client, args []string) {
	username := requiredFlag(args, "--username")
	password := requiredFlag(args, "--password")
	if err := client.CreateUser(ctx, newapi.CreateUserRequest{Username: username, Password: password, DisplayName: username}); err != nil {
		log.Fatalf("create user: %v", err)
	}
	printJSON(map[string]any{"step": "create_user", "ok": true, "username": username})
}

// spikeCreateToken verifies whether New API token creation works through the configured admin route.
func spikeCreateToken(ctx context.Context, client *newapi.Client, args []string) {
	tokenName := optionalFlag(args, "--token-name", "uclaw-main")
	var response newapi.CreateTokenResponse
	if err := client.CreateToken(ctx, newapi.CreateTokenRequest{Name: tokenName}, &response); err != nil {
		log.Fatalf("create token: %v", err)
	}
	printJSON(map[string]any{
		"step":          "create_token",
		"ok":            true,
		"token_name":    tokenName,
		"success":       response.Success,
		"message":       response.Message,
		"token_present": response.Token != "" || response.Key != "",
	})
}

// spikeAddQuota verifies quota crediting through New API manage endpoint.
func spikeAddQuota(ctx context.Context, client *newapi.Client, args []string) {
	userID := parsePositiveIntFlag(args, "--user-id")
	quota := parsePositiveIntFlag(args, "--quota")
	if err := client.AddQuota(ctx, newapi.AddQuotaRequest{UserID: userID, Quota: quota}); err != nil {
		log.Fatalf("add quota: %v", err)
	}
	printJSON(map[string]any{"step": "add_quota", "ok": true, "user_id": userID, "quota": quota})
}

// spikeUserModels verifies the New API user model-permission endpoint without printing secrets.
func spikeUserModels(ctx context.Context, client *newapi.Client, args []string) {
	username := requiredFlag(args, "--username")
	password := requiredFlag(args, "--password")
	login, err := client.Login(ctx, username, password)
	if err != nil {
		log.Fatalf("login user: %v", err)
	}
	userClient, err := client.WithAccessToken(login.Data.AccessToken)
	if err != nil {
		log.Fatalf("newapi user client: %v", err)
	}
	models, err := userClient.ListUserModels(ctx)
	if err != nil {
		log.Fatalf("list user models: %v", err)
	}
	printJSON(map[string]any{
		"step":     "user_models",
		"ok":       true,
		"username": username,
		"channels": models,
		"count":    countUserModels(models),
	})
}

// countUserModels counts unique model IDs across New API channel permissions.
func countUserModels(models newapi.UserModels) int {
	seen := map[string]bool{}
	for _, names := range models {
		for _, name := range names {
			if name == "" {
				continue
			}
			seen[name] = true
		}
	}
	return len(seen)
}

// spikeFull preserves the original one-command flow for quick manual checks.
func spikeFull(ctx context.Context, client *newapi.Client, args []string) {
	username := requiredFlag(args, "--username")
	password := requiredFlag(args, "--password")
	tokenName := optionalFlag(args, "--token-name", "")
	quotaRaw := optionalFlag(args, "--quota", "0")
	quota, err := strconv.ParseInt(quotaRaw, 10, 64)
	if err != nil {
		log.Fatalf("invalid --quota %q", quotaRaw)
	}
	userIDRaw := optionalFlag(args, "--user-id", "0")
	userID, err := strconv.ParseInt(userIDRaw, 10, 64)
	if err != nil {
		log.Fatalf("invalid --user-id %q", userIDRaw)
	}

	if err := client.CreateUser(ctx, newapi.CreateUserRequest{Username: username, Password: password, DisplayName: username}); err != nil {
		log.Fatalf("create user: %v", err)
	}
	printJSON(map[string]any{"step": "create_user", "ok": true, "username": username})
	if tokenName != "" {
		var response newapi.CreateTokenResponse
		if err := client.CreateToken(ctx, newapi.CreateTokenRequest{Name: tokenName}, &response); err != nil {
			log.Fatalf("create token: %v", err)
		}
		printJSON(map[string]any{
			"step":          "create_token",
			"ok":            true,
			"token_name":    tokenName,
			"success":       response.Success,
			"message":       response.Message,
			"token_present": response.Token != "" || response.Key != "",
		})
	}
	if quota > 0 {
		if userID <= 0 {
			log.Fatal("--user-id is required when --quota is greater than 0")
		}
		if err := client.AddQuota(ctx, newapi.AddQuotaRequest{UserID: userID, Quota: quota}); err != nil {
			log.Fatalf("add quota: %v", err)
		}
		printJSON(map[string]any{"step": "add_quota", "ok": true, "user_id": userID, "quota": quota})
	}
}

// requiredFlag returns a flag value or exits because admin commands must fail loudly.
func requiredFlag(args []string, name string) string {
	value := optionalFlag(args, name, "")
	if value == "" {
		log.Fatalf("missing %s", name)
	}
	return value
}

// parsePositiveIntFlag parses an int64 flag that must be greater than zero.
func parsePositiveIntFlag(args []string, name string) int64 {
	raw := requiredFlag(args, name)
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		log.Fatalf("%s must be a positive integer", name)
	}
	return value
}

// optionalFlag parses either "--name value" or "--name=value" without adding CLI dependencies.
func optionalFlag(args []string, name string, fallback string) string {
	prefix := name + "="
	for i, arg := range args {
		if strings.HasPrefix(arg, prefix) {
			return strings.TrimPrefix(arg, prefix)
		}
		if arg == name && i+1 < len(args) {
			return args[i+1]
		}
	}
	return fallback
}

// printJSON writes machine-readable spike output without exposing raw token secrets.
func printJSON(payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		log.Fatalf("marshal output: %v", err)
	}
	fmt.Println(string(encoded))
}

// usage prints supported admin commands.
func usage() {
	fmt.Fprintln(os.Stderr, "usage:")
	fmt.Fprintln(os.Stderr, "  uclaw-adminctl activation generate [count]")
	fmt.Fprintln(os.Stderr, "  uclaw-adminctl activation seed --code <activation-code> [--batch-id <id>]")
	fmt.Fprintln(os.Stderr, "  uclaw-adminctl spike newapi create-user --username <phone> --password <password>")
	fmt.Fprintln(os.Stderr, "  uclaw-adminctl spike newapi create-token [--token-name <name>]")
	fmt.Fprintln(os.Stderr, "  uclaw-adminctl spike newapi add-quota --user-id <id> --quota <tokens>")
	fmt.Fprintln(os.Stderr, "  uclaw-adminctl spike newapi provision --username <phone> [--quota <tokens>]")
	fmt.Fprintln(os.Stderr, "  uclaw-adminctl spike newapi user-models --username <phone> --password <password>")
	fmt.Fprintln(os.Stderr, "  uclaw-adminctl spike newapi full --username <phone> --password <password> [--token-name <name>] [--user-id <id> --quota <tokens>]")
}
