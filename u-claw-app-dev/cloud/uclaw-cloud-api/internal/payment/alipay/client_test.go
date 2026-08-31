package alipay

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"uclaw-cloud-api/internal/recharge"
)

func TestCreateCheckoutPrecreatesSignedAlipayQRCode(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	var rawRequest string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		rawRequest = r.Form.Encode()
		if r.Form.Get("method") != "alipay.trade.precreate" {
			t.Fatalf("method = %q", r.Form.Get("method"))
		}
		if !strings.Contains(r.Form.Get("biz_content"), `"out_trade_no":"UC1"`) ||
			!strings.Contains(r.Form.Get("biz_content"), `"total_amount":"0.01"`) {
			t.Fatalf("biz_content = %s", r.Form.Get("biz_content"))
		}
		_, _ = w.Write([]byte(`{"alipay_trade_precreate_response":{"code":"10000","msg":"Success","out_trade_no":"UC1","qr_code":"https://qr.alipay.com/test"},"sign":"ignored"}`))
	}))
	defer server.Close()

	client := NewClient(Config{
		AppID:              "app-1",
		GatewayURL:         server.URL,
		NotifyURL:          "https://license.yiyong.me/v1/payments/alipay/notify",
		PrivateKey:         privateKey,
		SkipResponseVerify: true,
	})
	result, err := client.CreateCheckout(context.Background(), recharge.CheckoutRequest{
		OrderNo:     "UC1",
		Name:        "测试充值",
		AmountCents: 1,
		Currency:    "CNY",
	})
	if err != nil {
		t.Fatalf("CreateCheckout() error = %v", err)
	}
	if result.QRCodeURL != "https://qr.alipay.com/test" {
		t.Fatalf("QRCodeURL = %q", result.QRCodeURL)
	}
	if !strings.Contains(rawRequest, "sign=") || !strings.Contains(rawRequest, "notify_url=") {
		t.Fatalf("request missing sign or notify_url: %s", rawRequest)
	}
}

func TestSignFormIncludesSignTypeForOpenAPIRequests(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	params := map[string]string{
		"app_id":        "app-1",
		"biz_content":   `{"out_trade_no":"UC1","total_amount":"0.01"}`,
		"charset":       "utf-8",
		"format":        "JSON",
		"method":        "alipay.trade.precreate",
		"sign_type":     "RSA2",
		"timestamp":     "2026-08-31 15:50:48",
		"version":       "1.0",
		"empty_ignored": " ",
	}

	signature, err := SignForm(params, privateKey)
	if err != nil {
		t.Fatalf("SignForm() error = %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		t.Fatalf("decode signature: %v", err)
	}
	sum := sha256.Sum256([]byte(canonicalRequestSignContent(params)))
	if err := rsa.VerifyPKCS1v15(&privateKey.PublicKey, crypto.SHA256, sum[:], decoded); err != nil {
		t.Fatalf("signature should verify with sign_type included: %v", err)
	}
	legacySum := sha256.Sum256([]byte(canonicalNotifySignContent(params)))
	if err := rsa.VerifyPKCS1v15(&privateKey.PublicKey, crypto.SHA256, legacySum[:], decoded); err == nil {
		t.Fatalf("request signature unexpectedly verified when sign_type was excluded")
	}
}

func TestCreateCheckoutVerifiesSignedPrecreateResponse(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	responseObject := `{"code":"10000","msg":"Success","out_trade_no":"UC1","qr_code":"https://qr.alipay.com/test"}`
	signature, err := signRawResponse(responseObject, privateKey)
	if err != nil {
		t.Fatalf("sign response: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"alipay_trade_precreate_response":` + responseObject + `,"sign":"` + signature + `"}`))
	}))
	defer server.Close()

	client := NewClient(Config{
		AppID:      "app-1",
		GatewayURL: server.URL,
		NotifyURL:  "https://license.yiyong.me/v1/payments/alipay/notify",
		PrivateKey: privateKey,
		PublicKey:  &privateKey.PublicKey,
	})
	result, err := client.CreateCheckout(context.Background(), recharge.CheckoutRequest{
		OrderNo:     "UC1",
		Name:        "测试充值",
		AmountCents: 1,
		Currency:    "CNY",
	})
	if err != nil {
		t.Fatalf("CreateCheckout() error = %v", err)
	}
	if result.QRCodeURL != "https://qr.alipay.com/test" {
		t.Fatalf("QRCodeURL = %q", result.QRCodeURL)
	}
}

func TestParseAndVerifyNotifyAcceptsSuccessfulTrade(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	form := map[string]string{
		"app_id":       "app-1",
		"out_trade_no": "UC1",
		"trade_no":     "2026083122001",
		"total_amount": "0.01",
		"trade_status": "TRADE_SUCCESS",
		"gmt_payment":  "2026-08-31 15:04:05",
	}
	sign, err := SignForm(form, privateKey)
	if err != nil {
		t.Fatalf("sign form: %v", err)
	}
	form["sign"] = sign
	form["sign_type"] = "RSA2"

	client := NewClient(Config{AppID: "app-1", PublicKey: &privateKey.PublicKey})
	notify, err := client.ParseAndVerifyNotify(valuesFromMap(form))
	if err != nil {
		t.Fatalf("ParseAndVerifyNotify() error = %v", err)
	}
	if notify.OrderNo != "UC1" || notify.ProviderTradeNo != "2026083122001" || notify.AmountCents != 1 || !notify.Paid {
		t.Fatalf("notify = %+v", notify)
	}
}

func TestLoadKeysAcceptsPublicCertificatePath(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "Alipay Test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	rawCert, err := x509.CreateCertificate(rand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	certPath := filepath.Join(t.TempDir(), "alipay-public-cert.pem")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rawCert}), 0o600); err != nil {
		t.Fatalf("write cert: %v", err)
	}

	client := NewClient(Config{AppID: "app-1", PublicCertPath: certPath})
	if err := client.LoadKeys(); err != nil {
		t.Fatalf("LoadKeys() error = %v", err)
	}
	if client.publicKey == nil || client.publicKey.N.Cmp(privateKey.PublicKey.N) != 0 {
		t.Fatalf("public key was not loaded from certificate")
	}
}

func valuesFromMap(input map[string]string) url.Values {
	values := make(url.Values, len(input))
	for key, value := range input {
		values.Set(key, value)
	}
	return values
}

func signRawResponse(content string, key *rsa.PrivateKey) (string, error) {
	sum := sha256.Sum256([]byte(content))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(signature), nil
}
