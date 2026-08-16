package security

import (
	"bytes"
	"context"
	"testing"
)

func TestKEKWrapRoundTripBindsKeyVersionAndAAD(t *testing.T) {
	kms, err := NewKEK(bytes.Repeat([]byte{0x41}, 32), bytes.NewReader(bytes.Repeat([]byte{0x22}, 64)))
	if err != nil {
		t.Fatal(err)
	}
	wrapped, err := kms.WrapKey(context.Background(), "kms-v1", []byte("01234567890123456789012345678901"), []byte("binding"))
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := kms.UnwrapKey(context.Background(), "kms-v1", wrapped, []byte("binding"))
	if err != nil || string(plaintext) != "01234567890123456789012345678901" {
		t.Fatalf("unwrap=%q err=%v", plaintext, err)
	}
	if _, err := kms.UnwrapKey(context.Background(), "kms-v2", wrapped, []byte("binding")); err == nil {
		t.Fatal("wrong key version accepted")
	}
	if _, err := kms.UnwrapKey(context.Background(), "kms-v1", wrapped, []byte("other")); err == nil {
		t.Fatal("wrong AAD accepted")
	}
}

func TestKEKRejectsInvalidKeyAndProbes(t *testing.T) {
	if _, err := NewKEK(make([]byte, 31), nil); err == nil {
		t.Fatal("invalid KEK accepted")
	}
	kms, err := NewKEK(bytes.Repeat([]byte{0x41}, 32), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := kms.Probe(context.Background(), "kms-v1"); err != nil {
		t.Fatal(err)
	}
}
