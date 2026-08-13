package deviceaccess

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

func TestIssueCreatesLongLivedTokenAndPepperedDigest(t *testing.T) {
	pepper := []byte("0123456789abcdef0123456789abcdef")
	service, err := NewService(pepper, bytes.NewReader(make([]byte, 48)))
	if err != nil {
		t.Fatal(err)
	}
	credential, err := service.Issue()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(credential.Token, "uclaw_dt_") || len(strings.TrimPrefix(credential.Token, "uclaw_dt_")) != base64.RawURLEncoding.EncodedLen(32) {
		t.Fatalf("token=%q", credential.Token)
	}
	if credential.ID != "00000000-0000-4000-8000-000000000000" {
		t.Fatalf("id=%q", credential.ID)
	}
	mac := hmac.New(sha256.New, pepper)
	mac.Write([]byte(credential.Token))
	if !hmac.Equal(credential.Digest, mac.Sum(nil)) {
		t.Fatal("digest mismatch")
	}
}

func TestDigestRecomputesCredentialDigest(t *testing.T) {
	service, err := NewService([]byte("0123456789abcdef0123456789abcdef"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(service.Digest("uclaw_dt_"+strings.Repeat("A", 43))) != sha256.Size {
		t.Fatal("digest length mismatch")
	}
}
