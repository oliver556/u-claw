package main

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	"uclaw-cloud-api/internal/config"
	"uclaw-cloud-api/internal/newapi"
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
	if len(args) < 1 || args[0] != "generate" {
		usage()
		os.Exit(2)
	}
	count := 10
	if len(args) > 1 {
		parsed, err := strconv.Atoi(args[1])
		if err != nil || parsed <= 0 {
			log.Fatalf("invalid activation count %q", args[1])
		}
		count = parsed
	}
	for i := 0; i < count; i++ {
		code, err := generateActivationCode()
		if err != nil {
			log.Fatalf("generate activation code: %v", err)
		}
		fmt.Println(code)
	}
}

// runSpike handles external-system verification commands for Phase 0.
func runSpike(args []string) {
	if len(args) < 1 || args[0] != "newapi" {
		usage()
		os.Exit(2)
	}
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	client, err := newapi.NewClient(cfg.NewAPIAdminBaseURL, cfg.NewAPIAdminToken, nil)
	if err != nil {
		log.Fatalf("newapi client: %v", err)
	}
	username := requiredFlag(args[1:], "--username")
	password := requiredFlag(args[1:], "--password")
	quotaRaw := optionalFlag(args[1:], "--quota", "0")
	quota, err := strconv.ParseInt(quotaRaw, 10, 64)
	if err != nil {
		log.Fatalf("invalid --quota %q", quotaRaw)
	}
	userIDRaw := optionalFlag(args[1:], "--user-id", "0")
	userID, err := strconv.ParseInt(userIDRaw, 10, 64)
	if err != nil {
		log.Fatalf("invalid --user-id %q", userIDRaw)
	}

	ctx := context.Background()
	if err := client.CreateUser(ctx, newapi.CreateUserRequest{Username: username, Password: password, DisplayName: username}); err != nil {
		log.Fatalf("create user: %v", err)
	}
	fmt.Println("create_user ok")
	if quota > 0 {
		if userID <= 0 {
			log.Fatal("--user-id is required when --quota is greater than 0")
		}
		if err := client.AddQuota(ctx, newapi.AddQuotaRequest{UserID: userID, Quota: quota}); err != nil {
			log.Fatalf("add quota: %v", err)
		}
		fmt.Println("add_quota ok")
	}
}

// generateActivationCode creates a human-readable one-time code for USB card printing.
func generateActivationCode() (string, error) {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	return "UCLAW-" + encoded[:4] + "-" + encoded[4:8] + "-" + encoded[8:12] + "-" + encoded[12:16], nil
}

// requiredFlag returns a flag value or exits because admin commands must fail loudly.
func requiredFlag(args []string, name string) string {
	value := optionalFlag(args, name, "")
	if value == "" {
		log.Fatalf("missing %s", name)
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

// usage prints supported admin commands.
func usage() {
	fmt.Fprintln(os.Stderr, "usage:")
	fmt.Fprintln(os.Stderr, "  uclaw-adminctl activation generate [count]")
	fmt.Fprintln(os.Stderr, "  uclaw-adminctl spike newapi --username <phone> --password <password> [--user-id <id> --quota <tokens>]")
}
