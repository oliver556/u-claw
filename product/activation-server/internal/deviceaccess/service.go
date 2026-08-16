package deviceaccess

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
)

const tokenPrefix = "uclaw_dt_"

type Credential struct {
	ID     string
	Token  string
	Digest []byte
}

type Service struct {
	pepper []byte
	random io.Reader
}

func NewService(pepper []byte, randomSource io.Reader) (*Service, error) {
	if len(pepper) < sha256.Size {
		return nil, errors.New("device access service configuration invalid")
	}
	if randomSource == nil {
		randomSource = rand.Reader
	}
	return &Service{pepper: append([]byte(nil), pepper...), random: randomSource}, nil
}

func (service *Service) Issue() (Credential, error) {
	raw := make([]byte, 32)
	if _, err := io.ReadFull(service.random, raw); err != nil {
		return Credential{}, errors.New("device access credential unavailable")
	}
	token := tokenPrefix + base64.RawURLEncoding.EncodeToString(raw)
	idBytes := make([]byte, 16)
	if _, err := io.ReadFull(service.random, idBytes); err != nil {
		return Credential{}, errors.New("device access credential unavailable")
	}
	idBytes[6] = idBytes[6]&0x0f | 0x40
	idBytes[8] = idBytes[8]&0x3f | 0x80
	encodedID := hex.EncodeToString(idBytes)
	id := encodedID[0:8] + "-" + encodedID[8:12] + "-" + encodedID[12:16] + "-" + encodedID[16:20] + "-" + encodedID[20:32]
	return Credential{ID: id, Token: token, Digest: service.Digest(token)}, nil
}

func (service *Service) Digest(token string) []byte {
	mac := hmac.New(sha256.New, service.pepper)
	_, _ = mac.Write([]byte(token))
	return mac.Sum(nil)
}
