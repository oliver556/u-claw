package inventory

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
	"math/big"
	"strings"
)

const (
	activationCodeLength      = 26
	activationCodeRandomBytes = 17
	maxActivationCodeRawBytes = 64
	crockfordAlphabet         = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
)

var errInvalidActivationCode = errors.New("invalid activation code")

func GenerateActivationCode(random io.Reader) (string, error) {
	if random == nil {
		random = rand.Reader
	}
	entropy := make([]byte, activationCodeRandomBytes)
	if _, err := io.ReadFull(random, entropy); err != nil {
		return "", errors.New("activation code entropy unavailable")
	}
	entropy[0] &= 0x03

	value := new(big.Int).SetBytes(entropy)
	encoded := make([]byte, activationCodeLength)
	base := big.NewInt(int64(len(crockfordAlphabet)))
	remainder := new(big.Int)
	for index := activationCodeLength - 1; index >= 0; index-- {
		value.QuoRem(value, base, remainder)
		encoded[index] = crockfordAlphabet[remainder.Int64()]
	}
	return string(encoded), nil
}

func NormalizeActivationCode(value string) (string, error) {
	if len(value) > maxActivationCodeRawBytes {
		return "", errInvalidActivationCode
	}
	normalized := strings.ToUpper(strings.ReplaceAll(value, "-", ""))
	if len(normalized) != activationCodeLength {
		return "", errInvalidActivationCode
	}
	for _, character := range normalized {
		if !strings.ContainsRune(crockfordAlphabet, character) {
			return "", errInvalidActivationCode
		}
	}
	return normalized, nil
}

func ActivationCodeDigest(pepper []byte, code string) ([]byte, error) {
	if len(pepper) < sha256.Size {
		return nil, errors.New("activation pepper unavailable")
	}
	normalized, err := NormalizeActivationCode(code)
	if err != nil {
		return nil, err
	}
	digest := hmac.New(sha256.New, pepper)
	_, _ = digest.Write([]byte(normalized))
	return digest.Sum(nil), nil
}
