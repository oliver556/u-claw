package usage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"uclaw-cloud-api/internal/newapi"
	"uclaw-cloud-api/internal/provisioning"
)

func TestGetSummaryLogsInAndAggregatesUsage(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	secret := "test-password-secret"
	expectedPassword := provisioning.DeriveUserPassword(5, "13800138000", secret)
	var sawLogin bool
	var sawSelf bool
	var sawLogs bool

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/user/login":
			sawLogin = true
			var req map[string]string
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Fatalf("decode login: %v", err)
			}
			if req["username"] != "13800138000" || req["password"] != expectedPassword {
				t.Fatalf("login payload = %+v", req)
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"access_token":"user-access-token"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/user/self":
			sawSelf = true
			if r.Header.Get("Authorization") != "Bearer user-access-token" {
				t.Fatalf("self Authorization = %q", r.Header.Get("Authorization"))
			}
			_, _ = w.Write([]byte(`{"success":true,"data":{"id":9,"username":"13800138000","quota":100000,"used_quota":300,"request_count":12}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/log/self":
			sawLogs = true
			if r.URL.Query().Get("p") != "0" || r.URL.Query().Get("page_size") != "4" {
				t.Fatalf("query = %q", r.URL.RawQuery)
			}
			today := now.Add(-1 * time.Hour).Unix()
			recent := now.AddDate(0, 0, -3).Unix()
			old := now.AddDate(0, 0, -9).Unix()
			_, _ = w.Write([]byte(`{"success":true,"data":{"page":1,"page_size":4,"total":4,"items":[` +
				`{"id":1,"created_at":` + itoa(today) + `,"type":2,"content":"consume","model_name":"gpt-5.5","quota":100,"prompt_tokens":10,"completion_tokens":20,"request_id":"req_today"},` +
				`{"id":2,"created_at":` + itoa(today) + `,"type":1,"content":"Logged in successfully via password","quota":0},` +
				`{"id":3,"created_at":` + itoa(recent) + `,"type":2,"model_name":"gpt-image-2","quota":200},` +
				`{"id":4,"created_at":` + itoa(old) + `,"type":7,"content":"login","quota":999}` +
				`]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	admin, err := newapi.NewClient(server.URL, "admin-token", server.Client())
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	service, err := NewService(admin, Config{PasswordSecret: secret, PageSize: 4})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	service.now = func() time.Time { return now }

	summary, err := service.GetSummary(context.Background(), SummaryRequest{UserID: 5, Phone: "13800138000"})
	if err != nil {
		t.Fatalf("GetSummary() error = %v", err)
	}
	if !sawLogin || !sawSelf || !sawLogs {
		t.Fatalf("sawLogin=%t sawSelf=%t sawLogs=%t", sawLogin, sawSelf, sawLogs)
	}
	if summary.AccountBalance != 100000 || summary.UsedQuota != 300 || summary.RequestCount != 12 {
		t.Fatalf("summary counters = %+v", summary)
	}
	if summary.AccountBalanceCompute != 1200000 || summary.UsedCompute != 3600 {
		t.Fatalf("summary compute counters = %+v", summary)
	}
	if summary.TodayUsage != 100 || summary.Last7DaysUsage != 300 || summary.CumulativeUsage != 300 {
		t.Fatalf("summary usage = %+v", summary)
	}
	if summary.TodayCompute != 1200 || summary.Last7DaysCompute != 3600 || summary.CumulativeCompute != 3600 {
		t.Fatalf("summary compute usage = %+v", summary)
	}
	if summary.NewAPIQuotaPerCNY != 500000 || summary.ComputeUnitsPerCNY != 6000000 {
		t.Fatalf("summary conversion = %+v", summary)
	}
	if len(summary.Records) != 2 || summary.Records[0].RequestID != "req_today" {
		t.Fatalf("records = %+v", summary.Records)
	}
	for _, record := range summary.Records {
		if strings.Contains(record.Content, "Logged in successfully") || record.Content == "login" {
			t.Fatalf("authentication log leaked into usage records: %+v", record)
		}
	}
	if summary.Records[0].Compute != 1200 {
		t.Fatalf("record compute = %+v", summary.Records[0])
	}
}

func TestNewServiceRejectsMissingPasswordSecret(t *testing.T) {
	admin, err := newapi.NewClient("http://127.0.0.1:3000", "admin-token", nil)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	_, err = NewService(admin, Config{})
	if err == nil {
		t.Fatal("NewService() error = nil, want password secret error")
	}
}

// itoa formats epoch test values without bringing strconv into response assembly code.
func itoa(value int64) string {
	return strconv.FormatInt(value, 10)
}
