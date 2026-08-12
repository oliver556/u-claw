package inventory

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"strings"
	"testing"
)

func TestGenerateActivationCodeUsesExactly130RandomBits(t *testing.T) {
	code, err := GenerateActivationCode(bytes.NewReader(bytes.Repeat([]byte{0xff}, activationCodeRandomBytes)))
	if err != nil {
		t.Fatal(err)
	}
	if code != strings.Repeat("Z", activationCodeLength) {
		t.Fatalf("code = %q", code)
	}
	if len(code) != activationCodeLength {
		t.Fatalf("length = %d", len(code))
	}

	decoded := new(big.Int)
	for _, character := range code {
		index := strings.IndexRune(crockfordAlphabet, character)
		if index < 0 {
			t.Fatalf("code contains non-Crockford character %q", character)
		}
		decoded.Lsh(decoded, 5)
		decoded.Or(decoded, big.NewInt(int64(index)))
	}
	if decoded.BitLen() != 130 {
		t.Fatalf("bit length = %d, want 130", decoded.BitLen())
	}
}

func TestGenerateActivationCodeRejectsShortEntropy(t *testing.T) {
	if _, err := GenerateActivationCode(bytes.NewReader(make([]byte, activationCodeRandomBytes-1))); err == nil {
		t.Fatal("expected short entropy to fail")
	}
}

func TestActivationCodeDigestNormalizesAndUsesHMACSHA256(t *testing.T) {
	pepper := []byte("fixture-pepper-with-enough-entropy")
	formatted := "01234-56789-abcde-fghjk-mnpqrs"
	normalized := "0123456789ABCDEFGHJKMNPQRS"

	digest, err := ActivationCodeDigest(pepper, formatted)
	if err != nil {
		t.Fatal(err)
	}
	want := hmac.New(sha256.New, pepper)
	_, _ = want.Write([]byte(normalized))
	if hex.EncodeToString(digest) != hex.EncodeToString(want.Sum(nil)) {
		t.Fatalf("digest = %x, want %x", digest, want.Sum(nil))
	}
	if _, err := ActivationCodeDigest(pepper, "01234-56789-ABCDE-FGHIJ-KLMNOP"); err == nil {
		t.Fatal("expected ambiguous Crockford characters to fail")
	}
	if _, err := ActivationCodeDigest(nil, normalized); err == nil {
		t.Fatal("expected missing pepper to fail")
	}
	if _, err := ActivationCodeDigest(make([]byte, 31), normalized); err == nil {
		t.Fatal("expected pepper shorter than 32 bytes to fail")
	}
}

func TestNormalizeActivationCodeBoundsRawInput(t *testing.T) {
	if _, err := NormalizeActivationCode(strings.Repeat("-", 1<<20) + "0123456789ABCDEFGHJKMNPQRS"); err == nil {
		t.Fatal("expected oversized raw activation code to fail")
	}
}
