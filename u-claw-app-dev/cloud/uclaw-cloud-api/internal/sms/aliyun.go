package sms

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
	dysmsapi20170525 "github.com/alibabacloud-go/dysmsapi-20170525/v5/client"
	util "github.com/alibabacloud-go/tea-utils/v2/service"
	"github.com/alibabacloud-go/tea/tea"

	"uclaw-cloud-api/internal/auth"
)

const (
	defaultAliyunEndpoint          = "dysmsapi.aliyuncs.com"
	defaultAliyunTemplateParamName = "code"
	defaultAliyunTimeout           = 3 * time.Second
	minAliyunTimeout               = time.Second
)

// AliyunProviderConfig contains the SMS settings injected from production env.
type AliyunProviderConfig struct {
	AccessKeyID       string
	AccessKeySecret   string
	SignName          string
	TemplateCode      string
	Endpoint          string
	TemplateParamName string
	Timeout           time.Duration
}

// AliyunSMSRequest is the small request shape used by the SDK wrapper seam.
type AliyunSMSRequest struct {
	PhoneNumbers  string
	SignName      string
	TemplateCode  string
	TemplateParam string
}

// AliyunSMSResult is the sanitized response shape returned by the SDK wrapper seam.
type AliyunSMSResult struct {
	Code      string
	Message   string
	RequestID string
	BizID     string
}

// AliyunSender sends a fully-formed Aliyun SMS request.
type AliyunSender interface {
	SendSMS(request AliyunSMSRequest) (AliyunSMSResult, error)
}

// AliyunProvider implements auth.SMSProvider with Alibaba Cloud SMS.
type AliyunProvider struct {
	sender            AliyunSender
	signName          string
	templateCode      string
	templateParamName string
}

// NewAliyunProvider creates a production Aliyun SMS provider backed by the official SDK.
func NewAliyunProvider(cfg AliyunProviderConfig) (*AliyunProvider, error) {
	normalized, err := normalizeAliyunConfig(cfg)
	if err != nil {
		return nil, err
	}
	sender, err := NewAliyunSDKSender(normalized)
	if err != nil {
		return nil, err
	}
	return NewAliyunProviderWithSender(normalized, sender)
}

// NewAliyunProviderWithSender creates a provider with a testable sender seam.
func NewAliyunProviderWithSender(cfg AliyunProviderConfig, sender AliyunSender) (*AliyunProvider, error) {
	normalized, err := normalizeAliyunConfig(cfg)
	if err != nil {
		return nil, err
	}
	if sender == nil {
		return nil, fmt.Errorf("aliyun sms sender is required")
	}
	return &AliyunProvider{
		sender:            sender,
		signName:          normalized.SignName,
		templateCode:      normalized.TemplateCode,
		templateParamName: normalized.TemplateParamName,
	}, nil
}

// SendCode sends a verification code without logging the phone or code payload.
func (p *AliyunProvider) SendCode(ctx context.Context, delivery auth.SMSDelivery) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	templateParam, err := json.Marshal(map[string]string{p.templateParamName: delivery.Code})
	if err != nil {
		return fmt.Errorf("build aliyun sms template param: %w", err)
	}
	result, err := p.sender.SendSMS(AliyunSMSRequest{
		PhoneNumbers:  delivery.Phone,
		SignName:      p.signName,
		TemplateCode:  p.templateCode,
		TemplateParam: string(templateParam),
	})
	if err != nil {
		return fmt.Errorf("send aliyun sms: %w", err)
	}
	if result.Code != "OK" {
		return fmt.Errorf("aliyun sms send failed: code=%s message=%s requestId=%s", result.Code, result.Message, result.RequestID)
	}
	return nil
}

// AliyunSDKSender wraps the official Alibaba Cloud SMS Go SDK.
type AliyunSDKSender struct {
	client  *dysmsapi20170525.Client
	runtime *util.RuntimeOptions
}

// NewAliyunSDKSender initializes the official SDK client once for process reuse.
func NewAliyunSDKSender(cfg AliyunProviderConfig) (*AliyunSDKSender, error) {
	normalized, err := normalizeAliyunConfig(cfg)
	if err != nil {
		return nil, err
	}
	client, err := dysmsapi20170525.NewClient(&openapi.Config{
		AccessKeyId:     tea.String(normalized.AccessKeyID),
		AccessKeySecret: tea.String(normalized.AccessKeySecret),
		Endpoint:        tea.String(normalized.Endpoint),
	})
	if err != nil {
		return nil, fmt.Errorf("create aliyun sms client: %w", err)
	}
	timeoutMS := int(normalized.Timeout / time.Millisecond)
	runtime := (&util.RuntimeOptions{}).
		SetConnectTimeout(timeoutMS).
		SetReadTimeout(timeoutMS).
		SetAutoretry(false).
		SetMaxAttempts(1)
	return &AliyunSDKSender{client: client, runtime: runtime}, nil
}

// SendSMS calls Aliyun SendSms and returns only support-safe response fields.
func (s *AliyunSDKSender) SendSMS(request AliyunSMSRequest) (AliyunSMSResult, error) {
	response, err := s.client.SendSmsWithOptions(&dysmsapi20170525.SendSmsRequest{
		PhoneNumbers:  tea.String(request.PhoneNumbers),
		SignName:      tea.String(request.SignName),
		TemplateCode:  tea.String(request.TemplateCode),
		TemplateParam: tea.String(request.TemplateParam),
	}, s.runtime)
	if err != nil {
		return AliyunSMSResult{}, err
	}
	if response == nil || response.Body == nil {
		return AliyunSMSResult{}, fmt.Errorf("empty aliyun sms response")
	}
	return AliyunSMSResult{
		Code:      stringValue(response.Body.Code),
		Message:   stringValue(response.Body.Message),
		RequestID: stringValue(response.Body.RequestId),
		BizID:     stringValue(response.Body.BizId),
	}, nil
}

// normalizeAliyunConfig trims config and applies conservative transport defaults.
func normalizeAliyunConfig(cfg AliyunProviderConfig) (AliyunProviderConfig, error) {
	cfg.AccessKeyID = strings.TrimSpace(cfg.AccessKeyID)
	cfg.AccessKeySecret = strings.TrimSpace(cfg.AccessKeySecret)
	cfg.SignName = strings.TrimSpace(cfg.SignName)
	cfg.TemplateCode = strings.TrimSpace(cfg.TemplateCode)
	cfg.Endpoint = strings.TrimSpace(cfg.Endpoint)
	cfg.TemplateParamName = strings.TrimSpace(cfg.TemplateParamName)
	if cfg.Endpoint == "" {
		cfg.Endpoint = defaultAliyunEndpoint
	}
	if cfg.TemplateParamName == "" {
		cfg.TemplateParamName = defaultAliyunTemplateParamName
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = defaultAliyunTimeout
	}
	if cfg.Timeout < minAliyunTimeout {
		cfg.Timeout = minAliyunTimeout
	}
	var missing []string
	if cfg.AccessKeyID == "" {
		missing = append(missing, "ALIYUN_SMS_ACCESS_KEY_ID")
	}
	if cfg.AccessKeySecret == "" {
		missing = append(missing, "ALIYUN_SMS_ACCESS_KEY_SECRET")
	}
	if cfg.SignName == "" {
		missing = append(missing, "ALIYUN_SMS_SIGN_NAME")
	}
	if cfg.TemplateCode == "" {
		missing = append(missing, "ALIYUN_SMS_TEMPLATE_CODE")
	}
	if len(missing) > 0 {
		return AliyunProviderConfig{}, fmt.Errorf("missing aliyun sms config: %s", strings.Join(missing, ", "))
	}
	return cfg, nil
}

// stringValue safely unwraps SDK response strings.
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
