package postgres

import (
	"context"
	"database/sql"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"uclaw-cloud-api/internal/activation"
	"uclaw-cloud-api/internal/admin"
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

func TestStoreEnsureEcommerceImageUsageSchemaCreatesMissingTable(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectExec(regexp.QuoteMeta("CREATE TABLE IF NOT EXISTS ecommerce_image_usage_events")).
		WillReturnResult(sqlmock.NewResult(0, 0))

	if err := store.EnsureEcommerceImageUsageSchema(context.Background()); err != nil {
		t.Fatalf("EnsureEcommerceImageUsageSchema() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
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

func TestStoreBindFirstStartUpsertsUsernameAndBindsCode(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	at := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta("INSERT INTO uclaw_users")).
		WithArgs("UCLAW-BIANCHENG", at).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(int64(77)))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE activation_codes")).
		WithArgs(store.activationCodeHash("ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ"), int64(77), "UCLAW-BIANCHENG", at).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	userID, err := store.BindFirstStart(context.Background(), "ABCDE-FGHIJ-KLMNO-PQRST-UVWXYZ", "uclaw-biancheng", at)
	if err != nil {
		t.Fatalf("BindFirstStart() error = %v", err)
	}
	if userID != 77 {
		t.Fatalf("user id = %d, want 77", userID)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreRecordFirstStartAttemptUpsertsServerBoundCheckpoint(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	at := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO activation_attempts")).
		WithArgs("act_123", "UCLAW-BIANCHENG", "PREVIEW-ONLY", "server_bound", "pending_client_write", at).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := store.RecordFirstStartAttempt(context.Background(), activation.FirstStartAttempt{
		ActivationID:          "act_123",
		UsernameNormalized:    "UCLAW-BIANCHENG",
		USBFingerprintSummary: "PREVIEW-ONLY",
		Stage:                 "server_bound",
		ArtifactStatus:        "pending_client_write",
	}, at)
	if err != nil {
		t.Fatalf("RecordFirstStartAttempt() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreCommitFirstStartAttemptRequiresMatchingAttempt(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	at := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	mock.ExpectExec(regexp.QuoteMeta("UPDATE activation_attempts")).
		WithArgs("act_123", "verified", at).
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := store.CommitFirstStartAttempt(context.Background(), "act_123", "verified", at); err != nil {
		t.Fatalf("CommitFirstStartAttempt() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreCommitFirstStartAttemptRejectsMissingAttempt(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	at := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	mock.ExpectExec(regexp.QuoteMeta("UPDATE activation_attempts")).
		WithArgs("act_missing", "verified", at).
		WillReturnResult(sqlmock.NewResult(0, 0))

	err := store.CommitFirstStartAttempt(context.Background(), "act_missing", "verified", at)
	if err == nil || !strings.Contains(err.Error(), "activation id is unknown") {
		t.Fatalf("CommitFirstStartAttempt() error = %v, want unknown activation id", err)
	}
}

func TestStoreSeedActivationCodeHashesPrintedCode(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	batchID := sql.NullInt64{Int64: 7, Valid: true}

	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO activation_codes")).
		WithArgs(batchID, store.activationCodeHash("ABCD-EFGH-IJKL-MNOP"), "streamer").
		WillReturnResult(sqlmock.NewResult(0, 1))

	if err := store.SeedActivationCode(context.Background(), "ABCD-EFGH-IJKL-MNOP", batchID, " streamer "); err != nil {
		t.Fatalf("SeedActivationCode() error = %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreActivationCodeNewAPIGroupReturnsTrimmedGroup(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT COALESCE(newapi_user_group, '')")).
		WithArgs(store.activationCodeHash("ABCD-EFGH-IJKL-MNOP")).
		WillReturnRows(sqlmock.NewRows([]string{"newapi_user_group"}).AddRow(" streamer "))

	group, err := store.ActivationCodeNewAPIGroup(context.Background(), "ABCD-EFGH-IJKL-MNOP")
	if err != nil {
		t.Fatalf("ActivationCodeNewAPIGroup() error = %v", err)
	}
	if group != "streamer" {
		t.Fatalf("group = %q, want streamer", group)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreCreateAdminUserLocksBeforeInsert(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	at := time.Date(2026, 8, 29, 8, 0, 0, 0, time.UTC)

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("LOCK TABLE admin_users IN EXCLUSIVE MODE")).
		WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(regexp.QuoteMeta("INSERT INTO admin_users")).
		WithArgs("uclawroot", "hash", at).
		WillReturnRows(sqlmock.NewRows([]string{"id", "username", "password_hash", "status", "created_at"}).
			AddRow(int64(1), "uclawroot", "hash", "active", at))
	mock.ExpectCommit()

	user, err := store.CreateAdminUser(context.Background(), "uclawroot", "hash", at)
	if err != nil {
		t.Fatalf("CreateAdminUser() error = %v", err)
	}
	if user.ID != 1 || user.Username != "uclawroot" || user.Status != "active" {
		t.Fatalf("user = %+v", user)
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

func TestStoreListActivationCodesReturnsCodeAndAccountMapping(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	createdAt := time.Date(2026, 8, 29, 8, 0, 0, 0, time.UTC)
	boundAt := time.Date(2026, 8, 29, 8, 3, 0, 0, time.UTC)
	rotatedAt := time.Date(2026, 8, 29, 8, 4, 0, 0, time.UTC)
	committedAt := time.Date(2026, 8, 29, 8, 5, 0, 0, time.UTC)

	rows := sqlmock.NewRows([]string{
		"id",
		"batch_id",
		"name",
		"status",
		"bound_user_id",
		"bound_phone",
		"bound_at",
		"created_at",
		"expires_at",
		"code_ciphertext",
		"code_display_hint",
		"newapi_user_group",
		"newapi_user_id",
		"newapi_username",
		"newapi_base_url",
		"token_rotated_at",
		"activation_id",
		"stage",
		"committed_at",
	}).AddRow(
		int64(10),
		int64(3),
		"验收批次",
		"bound",
		int64(42),
		"15067729715",
		boundAt,
		createdAt,
		nil,
		"v1:ciphertext",
		"ABCD",
		"streamer",
		int64(77),
		"15067729715",
		"https://api.yiyong.me",
		rotatedAt,
		"act_123",
		"committed",
		committedAt,
	)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT\n  ac.id")).
		WithArgs("bound", 20).
		WillReturnRows(rows)

	codes, err := store.ListActivationCodes(context.Background(), admin.ActivationCodeFilter{Status: "bound", Limit: 20})
	if err != nil {
		t.Fatalf("ListActivationCodes() error = %v", err)
	}
	if len(codes) != 1 {
		t.Fatalf("codes length = %d, want 1", len(codes))
	}
	code := codes[0]
	if code.CodeCiphertext != "v1:ciphertext" || code.CodeDisplayHint != "ABCD" || code.BoundPhone != "15067729715" || code.NewAPIUsername != "15067729715" || code.NewAPIUserGroup != "streamer" {
		t.Fatalf("code mapping = %+v", code)
	}
	if code.BoundUserID == nil || *code.BoundUserID != 42 || code.NewAPIUserID == nil || *code.NewAPIUserID != 77 {
		t.Fatalf("code ids = %+v", code)
	}
	if code.LatestActivationID != "act_123" || code.LatestActivationStage != "committed" || code.LatestActivationCommit == nil {
		t.Fatalf("activation detail = %+v", code)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}

func TestStoreListRechargeOrdersReturnsPaymentAndAccountMapping(t *testing.T) {
	store, mock, cleanup := newMockStore(t)
	defer cleanup()
	createdAt := time.Date(2026, 8, 31, 8, 0, 0, 0, time.UTC)
	updatedAt := time.Date(2026, 8, 31, 8, 1, 0, 0, time.UTC)
	paidAt := time.Date(2026, 8, 31, 8, 2, 0, 0, time.UTC)
	creditedAt := time.Date(2026, 8, 31, 8, 3, 0, 0, time.UTC)
	callbackAt := time.Date(2026, 8, 31, 8, 4, 0, 0, time.UTC)

	rows := sqlmock.NewRows([]string{
		"id",
		"order_no",
		"uclaw_user_id",
		"phone",
		"provider",
		"amount_cents",
		"quota_tokens",
		"status",
		"provider_trade_no",
		"paid_at",
		"credited_at",
		"last_error",
		"created_at",
		"updated_at",
		"newapi_user_id",
		"newapi_username",
		"callback_count",
		"last_callback_at",
	}).AddRow(
		int64(9),
		"UC202608310001",
		int64(42),
		"15067729715",
		"alipay",
		int64(1000),
		int64(60000000),
		"credited",
		"2026083122001234",
		paidAt,
		creditedAt,
		"",
		createdAt,
		updatedAt,
		int64(77),
		"15067729715",
		int64(2),
		callbackAt,
	)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT\n  po.id")).
		WithArgs("credited", "alipay", "15067729715", "UC20260831", 20).
		WillReturnRows(rows)

	orders, err := store.ListRechargeOrders(context.Background(), admin.RechargeOrderFilter{
		Status:   "credited",
		Provider: "alipay",
		Phone:    "15067729715",
		OrderNo:  "UC20260831",
		Limit:    20,
	})
	if err != nil {
		t.Fatalf("ListRechargeOrders() error = %v", err)
	}
	if len(orders) != 1 {
		t.Fatalf("orders length = %d, want 1", len(orders))
	}
	order := orders[0]
	if order.OrderNo != "UC202608310001" || order.Phone != "15067729715" || order.ProviderTradeNo != "2026083122001234" {
		t.Fatalf("order identifiers = %+v", order)
	}
	if order.AmountCents != 1000 || order.QuotaTokens != 60000000 || order.Status != "credited" || order.CallbackCount != 2 {
		t.Fatalf("order accounting = %+v", order)
	}
	if order.NewAPIUserID == nil || *order.NewAPIUserID != 77 || order.NewAPIUsername != "15067729715" {
		t.Fatalf("newapi mapping = %+v", order)
	}
	if order.PaidAt == nil || order.CreditedAt == nil || order.LastCallbackAt == nil {
		t.Fatalf("nullable times not set = %+v", order)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet sql expectations: %v", err)
	}
}
