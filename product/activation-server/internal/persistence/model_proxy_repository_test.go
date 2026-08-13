package persistence

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"u-claw-activation-server/internal/modelproxy"
)

func TestNewModelProxyRepositoryRejectsNilPool(t *testing.T) {
	if _, err := NewModelProxyRepository(nil); err == nil {
		t.Fatal("nil pool accepted")
	}
}
func TestModelProxyRepositoryPostgreSQLAuthorizationAdmissionAndAudit(t *testing.T) {
	databaseURL := os.Getenv("ACTIVATION_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ACTIVATION_TEST_DATABASE_URL is not set; model proxy PostgreSQL test skipped")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	random := make([]byte, 8)
	_, _ = rand.Read(random)
	schema := "model_proxy_" + hex.EncodeToString(random)
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE") }()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	pool2, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool2.Close()
	if err = Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	ids := []string{"20000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000001", "50000000-0000-4000-8000-000000000001"}
	digest := [32]byte{}
	_, _ = rand.Read(digest[:])
	envelope := make([]byte, 64)
	_, _ = rand.Read(envelope)
	queries := []struct {
		q    string
		args []any
	}{{`INSERT INTO activation_inventory(id,username_normalized,username_display,activation_code_digest,status,new_api_setup_status,created_at,activated_at) VALUES($1,'PROXYUSER','proxyuser',$2,'active','configured',now(),now())`, []any{ids[0], digest[:]}}, {`INSERT INTO devices(device_id,inventory_id,fingerprint_version,fingerprint_sha256,status,created_at,updated_at) VALUES($1,$2,'uclaw-usb-v1',$3,'active',now(),now())`, []any{ids[1], ids[0], digest[:]}}, {`INSERT INTO licenses(license_id,device_id,status,revision,key_id,startup_secret_salt,startup_secret_hash,not_before,expires_at,created_at,updated_at) VALUES($1,$2,'active',1,'key',decode(repeat('01',16),'hex'),$3,now(),now()+interval '1 year',now(),now())`, []any{ids[2], ids[1], digest[:]}}, {`UPDATE new_api_bindings SET device_id=$1,balance_setup_status='configured',api_key_envelope=$2,api_key_version='kms-v1',base_url='https://api.example.test/v1',default_model='allowed',allowed_models=ARRAY['allowed'] WHERE inventory_id=$3`, []any{ids[1], envelope, ids[0]}}, {`INSERT INTO device_access_tokens(device_token_id,inventory_id,device_id,license_id,token_digest,status,issued_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',now(),now(),now())`, []any{ids[3], ids[0], ids[1], ids[2], digest[:]}}}
	for _, q := range queries {
		if _, err = pool.Exec(ctx, q.q, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	r1, _ := NewModelProxyRepository(pool)
	r2, _ := NewModelProxyRepository(pool2)
	auth, err := r1.AuthorizeByDigest(ctx, digest)
	if err != nil || auth.TokenID != ids[3] || auth.BaseURL == "" {
		t.Fatalf("auth=%+v err=%v", auth, err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i, r := range []*ModelProxyRepository{r1, r2} {
		wg.Add(1)
		go func(i int, r *ModelProxyRepository) {
			defer wg.Done()
			errs <- r.Admit(ctx, ids[3], []string{"60000000-0000-4000-8000-000000000001", "60000000-0000-4000-8000-000000000002"}[i], 60, 1)
		}(i, r)
	}
	wg.Wait()
	close(errs)
	success, limited := 0, 0
	for e := range errs {
		if e == nil {
			success++
		} else if errors.Is(e, modelproxy.ErrAdmissionLimited) {
			limited++
		} else {
			t.Fatal(e)
		}
	}
	if success != 1 || limited != 1 {
		t.Fatalf("success=%d limited=%d", success, limited)
	}
	var requestID string
	if err = pool.QueryRow(ctx, `SELECT request_id FROM model_proxy_admissions`).Scan(&requestID); err != nil {
		t.Fatal(err)
	}
	if err = r1.Complete(ctx, requestID); err != nil {
		t.Fatal(err)
	}
	if err = r2.Admit(ctx, ids[3], "60000000-0000-4000-8000-000000000003", 60, 1); err != nil {
		t.Fatal(err)
	}
	if err = r2.Complete(ctx, "60000000-0000-4000-8000-000000000003"); err != nil {
		t.Fatal(err)
	}
	if err = r1.Admit(ctx, ids[3], "60000000-0000-4000-8000-000000000004", 2, 10); !errors.Is(err, modelproxy.ErrAdmissionLimited) {
		t.Fatalf("completed requests did not count toward RPM: %v", err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM model_proxy_admissions WHERE device_token_id=$1`, ids[3]); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO model_proxy_admissions(request_id,device_token_id,started_at,lease_expires_at) VALUES('60000000-0000-4000-8000-000000000005',$1,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`, ids[3]); err != nil {
		t.Fatal(err)
	}
	if err = r2.Admit(ctx, ids[3], "60000000-0000-4000-8000-000000000006", 1, 1); err != nil {
		t.Fatalf("expired lease blocked admission: %v", err)
	}
	var expired int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM model_proxy_admissions WHERE request_id='60000000-0000-4000-8000-000000000005'`).Scan(&expired); err != nil || expired != 0 {
		t.Fatalf("expired=%d err=%v", expired, err)
	}
	if err = r1.Audit(ctx, modelproxy.Audit{RequestID: "req-pg-test", TokenID: ids[3], InventoryID: ids[0], DeviceID: ids[1], LicenseID: ids[2], Route: "chat", Outcome: "succeeded", Status: 200}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE request_id='req-pg-test' AND actor_id=$1`, ids[3]).Scan(&count); err != nil || count != 1 {
		t.Fatalf("audit count=%d err=%v", count, err)
	}
}
