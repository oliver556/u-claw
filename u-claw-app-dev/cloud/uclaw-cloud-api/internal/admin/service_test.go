package admin

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"
)

func TestServiceRegistersFirstAdminAndLogsIn(t *testing.T) {
	store := NewMemoryStore()
	service, err := NewService(store, Config{EncryptionKey: "admin-encryption-key-at-least-32-bytes"})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	setup, err := service.SetupStatus(context.Background())
	if err != nil {
		t.Fatalf("SetupStatus() error = %v", err)
	}
	if !setup.RegistrationOpen {
		t.Fatal("registration should be open before first admin exists")
	}

	registered, err := service.Register(context.Background(), "UClawRoot", "DummyPass123!")
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if registered.Token == "" || registered.Username != "uclawroot" {
		t.Fatalf("registered = %+v", registered)
	}

	if _, err := service.Register(context.Background(), "other", "DummyPass123!"); err == nil || !strings.Contains(err.Error(), "closed") {
		t.Fatalf("second Register() error = %v, want closed", err)
	}

	loggedIn, err := service.Login(context.Background(), "uclawroot", "DummyPass123!")
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}
	session, err := service.VerifySession(context.Background(), loggedIn.Token)
	if err != nil {
		t.Fatalf("VerifySession() error = %v", err)
	}
	if session.Username != "uclawroot" {
		t.Fatalf("session = %+v", session)
	}
}

func TestServiceRegisterRejectsBlankUsername(t *testing.T) {
	service, err := NewService(NewMemoryStore(), Config{EncryptionKey: "admin-encryption-key-at-least-32-bytes"})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	if _, err := service.Register(context.Background(), " ", "DummyPass123!"); err == nil || !strings.Contains(err.Error(), "username") {
		t.Fatalf("Register() error = %v, want username validation", err)
	}
}

func TestServiceRegisterRejectsUnsafeUsername(t *testing.T) {
	service, err := NewService(NewMemoryStore(), Config{EncryptionKey: "admin-encryption-key-at-least-32-bytes"})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	if _, err := service.Register(context.Background(), "root<script>", "DummyPass123!"); err == nil || !strings.Contains(err.Error(), "username") {
		t.Fatalf("Register() error = %v, want username validation", err)
	}
}

func TestServiceListsEncryptedNewCodesAndHidesLegacyHashOnlyCodes(t *testing.T) {
	store := NewMemoryStore()
	service, err := NewService(store, Config{EncryptionKey: "admin-encryption-key-at-least-32-bytes"})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	legacy, err := store.CreateActivationCode(context.Background(), ActivationCodeSecret{
		Code:        "OLD1-OLD2-OLD3-OLD4",
		DisplayHint: "OLD4",
	}, sql.NullInt64{}, "", time.Date(2026, 8, 29, 1, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("CreateActivationCode() legacy error = %v", err)
	}
	generated, err := service.GenerateActivationCodes(context.Background(), GenerateRequest{Count: 1, BatchName: "验收批次", NewAPIUserGroup: "streamer"})
	if err != nil {
		t.Fatalf("GenerateActivationCodes() error = %v", err)
	}
	if generated[0].PlainCode == "" || !generated[0].CodeVisible {
		t.Fatalf("generated code should be returned once: %+v", generated[0])
	}
	if generated[0].NewAPIUserGroup != "streamer" {
		t.Fatalf("generated newapi group = %q, want streamer", generated[0].NewAPIUserGroup)
	}

	list, err := service.ListActivationCodes(context.Background(), ActivationCodeFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListActivationCodes() error = %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("list length = %d, want 2", len(list))
	}

	var sawLegacyHidden, sawGeneratedVisible bool
	for _, item := range list {
		switch item.ID {
		case legacy.ID:
			sawLegacyHidden = !item.CodeVisible && item.PlainCode == "" && item.CodeDisplayHint == "OLD4"
		case generated[0].ID:
			sawGeneratedVisible = item.CodeVisible && item.PlainCode == generated[0].PlainCode
		}
	}
	if !sawLegacyHidden || !sawGeneratedVisible {
		t.Fatalf("list visibility mismatch: %+v", list)
	}
}
