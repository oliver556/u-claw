package sms

import (
	"context"
	"os"
	"strings"
	"testing"

	"uclaw-cloud-api/internal/auth"
)

type fakeAliyunSender struct {
	request AliyunSMSRequest
	result  AliyunSMSResult
	err     error
}

// SendSMS captures requests and returns a controlled response for provider tests.
func (s *fakeAliyunSender) SendSMS(request AliyunSMSRequest) (AliyunSMSResult, error) {
	s.request = request
	return s.result, s.err
}

func TestAliyunProviderSendsCodeWithTemplateJSON(t *testing.T) {
	sender := &fakeAliyunSender{result: AliyunSMSResult{Code: "OK", RequestID: "req-1", BizID: "biz-1"}}
	provider, err := NewAliyunProviderWithSender(AliyunProviderConfig{
		AccessKeyID:       "id",
		AccessKeySecret:   "secret",
		SignName:          "U-Claw",
		TemplateCode:      "SMS_123456789",
		TemplateParamName: "code",
	}, sender)
	if err != nil {
		t.Fatalf("NewAliyunProviderWithSender() error = %v", err)
	}

	err = provider.SendCode(context.Background(), auth.SMSDelivery{
		Phone:   "13800138000",
		Purpose: "login",
		Code:    "123456",
	})
	if err != nil {
		t.Fatalf("SendCode() error = %v", err)
	}
	if sender.request.PhoneNumbers != "13800138000" {
		t.Fatalf("PhoneNumbers = %q", sender.request.PhoneNumbers)
	}
	if sender.request.SignName != "U-Claw" || sender.request.TemplateCode != "SMS_123456789" {
		t.Fatalf("sender request = %+v", sender.request)
	}
	if sender.request.TemplateParam != `{"code":"123456"}` {
		t.Fatalf("TemplateParam = %q", sender.request.TemplateParam)
	}
}

func TestAliyunProviderReturnsBusinessErrorWithoutSecrets(t *testing.T) {
	sender := &fakeAliyunSender{result: AliyunSMSResult{Code: "isv.SMS_SIGNATURE_ILLEGAL", Message: "signature invalid", RequestID: "req-1"}}
	provider, err := NewAliyunProviderWithSender(AliyunProviderConfig{
		AccessKeyID:     "id",
		AccessKeySecret: "secret",
		SignName:        "U-Claw",
		TemplateCode:    "SMS_123456789",
	}, sender)
	if err != nil {
		t.Fatalf("NewAliyunProviderWithSender() error = %v", err)
	}

	err = provider.SendCode(context.Background(), auth.SMSDelivery{Phone: "13800138000", Code: "123456"})
	if err == nil {
		t.Fatal("SendCode() error = nil, want business error")
	}
	message := err.Error()
	for _, secret := range []string{"123456", "13800138000", "secret"} {
		if strings.Contains(message, secret) {
			t.Fatalf("SendCode() error leaked secret-bearing value: %q", message)
		}
	}
	if !strings.Contains(message, "isv.SMS_SIGNATURE_ILLEGAL") || !strings.Contains(message, "req-1") {
		t.Fatalf("SendCode() error = %q", message)
	}
}

func TestAliyunProviderRequiresConfig(t *testing.T) {
	_, err := NewAliyunProviderWithSender(AliyunProviderConfig{}, &fakeAliyunSender{})
	if err == nil {
		t.Fatal("NewAliyunProviderWithSender() error = nil, want missing config")
	}
	for _, name := range []string{"ALIYUN_SMS_ACCESS_KEY_ID", "ALIYUN_SMS_ACCESS_KEY_SECRET", "ALIYUN_SMS_SIGN_NAME", "ALIYUN_SMS_TEMPLATE_CODE"} {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("error %q missing %s", err.Error(), name)
		}
	}
}

func TestAliyunProviderSmokeSendsRealSMS(t *testing.T) {
	if os.Getenv("UCLAW_ALIYUN_SMS_SMOKE") != "1" {
		t.Skip("set UCLAW_ALIYUN_SMS_SMOKE=1 to send one real Aliyun SMS")
	}
	provider, err := NewAliyunProvider(AliyunProviderConfig{
		AccessKeyID:       os.Getenv("ALIYUN_SMS_ACCESS_KEY_ID"),
		AccessKeySecret:   os.Getenv("ALIYUN_SMS_ACCESS_KEY_SECRET"),
		SignName:          os.Getenv("ALIYUN_SMS_SIGN_NAME"),
		TemplateCode:      os.Getenv("ALIYUN_SMS_TEMPLATE_CODE"),
		Endpoint:          os.Getenv("ALIYUN_SMS_ENDPOINT"),
		TemplateParamName: os.Getenv("ALIYUN_SMS_TEMPLATE_PARAM_NAME"),
	})
	if err != nil {
		t.Fatalf("NewAliyunProvider() error = %v", err)
	}
	phone := os.Getenv("ALIYUN_SMS_SMOKE_PHONE")
	if phone == "" {
		t.Fatal("ALIYUN_SMS_SMOKE_PHONE is required")
	}
	if err := provider.SendCode(context.Background(), auth.SMSDelivery{Phone: phone, Purpose: "login", Code: "123456"}); err != nil {
		t.Fatalf("SendCode() error = %v", err)
	}
}
