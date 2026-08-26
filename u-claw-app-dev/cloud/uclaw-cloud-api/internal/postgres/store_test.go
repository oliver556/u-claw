package postgres

import (
	"context"
	"database/sql"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"uclaw-cloud-api/internal/auth"
	"uclaw-cloud-api/internal/provisioning"
)

// newMockStore creates a PostgreSQL store with sqlmock so store behavior is testable without a live DB.
func newMockStore(t *testing.T) (*Store, sqlmock.Sqlmock, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New() error = %v", err)
	}
	return NewStore(db, "pepper"), mock, func() {
		mock.ExpectClose()
		if err := db.Close(); err != nil {
			t.Fatalf("close db: %v", err)
		}
	}
}

func TestStoreSaveSMSCodeUpsertsLatestCode(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO sms_codes")).
		WithArgs("13800138000", "login", "hash", sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := store.SaveSMSCode(context.Background(), "13800138000", "login", auth.SMSCode{
		CodeHash:  "hash",
		ExpiresAt: time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("SaveSMSCode() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreConsumeSMSCodeRequiresSingleMatchingRow(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	mock.ExpectExec(regexp.QuoteMeta("UPDATE sms_codes")).
		WithArgs("13800138000", "login", "hash", now, now).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := store.ConsumeSMSCode(context.Background(), "13800138000", "login", "hash", now); err != nil {
		t.Fatalf("ConsumeSMSCode() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreConsumeSMSCodeRejectsMissingRow(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	mock.ExpectExec(regexp.QuoteMeta("UPDATE sms_codes")).
		WithArgs("13800138000", "login", "hash", now, now).
		WillReturnResult(sqlmock.NewResult(0, 0))

	err := store.ConsumeSMSCode(context.Background(), "13800138000", "login", "hash", now)
	if err == nil || !strings.Contains(err.Error(), "sms code is invalid") {
		t.Fatalf("ConsumeSMSCode() error = %v, want invalid sms code", err)
	}
}

func TestStoreUpsertUserReturnsUser(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	verifiedAt := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	mock.ExpectQuery(regexp.QuoteMeta("INSERT INTO uclaw_users")).
		WithArgs("13800138000", verifiedAt).
		WillReturnRows(sqlmock.NewRows([]string{"id", "phone"}).AddRow(int64(42), "13800138000"))

	user, err := store.UpsertUser(context.Background(), "13800138000", verifiedAt)
	if err != nil {
		t.Fatalf("UpsertUser() error = %v", err)
	}
	if user.ID != 42 || user.Phone != "13800138000" {
		t.Fatalf("user = %+v", user)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreRedeemBindsUnusedActivationCode(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	at := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	mock.ExpectExec(regexp.QuoteMeta("UPDATE activation_codes")).
		WithArgs(store.activationCodeHash("ABCD-EFGH-IJKL-MNOP"), int64(42), "13800138000", at).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := store.Redeem(context.Background(), "ABCD-EFGH-IJKL-MNOP", 42, "13800138000", at); err != nil {
		t.Fatalf("Redeem() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreSeedActivationCodeHashesPrintedCode(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	batchID := sql.NullInt64{Int64: 7, Valid: true}

	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO activation_codes")).
		WithArgs(batchID, store.activationCodeHash("ABCD-EFGH-IJKL-MNOP")).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := store.SeedActivationCode(context.Background(), "ABCD-EFGH-IJKL-MNOP", batchID); err != nil {
		t.Fatalf("SeedActivationCode() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreSaveNewAPIAccountUpsertsMapping(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	rotatedAt := time.Date(2026, 8, 27, 1, 0, 0, 0, time.UTC)

	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO newapi_accounts")).
		WithArgs(int64(5), "https://api.example.com/v1", int64(9), "13800138000", "fingerprint", rotatedAt).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := store.SaveNewAPIAccount(context.Background(), provisioning.Account{
		UClawUserID:      5,
		NewAPIBaseURL:    "https://api.example.com/v1",
		NewAPIUserID:     9,
		NewAPIUsername:   "13800138000",
		TokenFingerprint: "fingerprint",
		TokenRotatedAt:   rotatedAt,
	})
	if err != nil {
		t.Fatalf("SaveNewAPIAccount() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}
