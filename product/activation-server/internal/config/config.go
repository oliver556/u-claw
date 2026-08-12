package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const defaultListenAddress = ":8080"

const (
	minimumPepperBytes  = 32
	maximumPepperBytes  = 4 * 1024
	maximumKeyFileBytes = 256
)

var requiredVariables = []string{
	"DATABASE_URL",
	"ACTIVATION_PEPPER_FILE",
	"LICENSE_SIGNING_KEY_FILE",
}

type Config struct {
	ListenAddress         string
	DatabaseURL           string
	ActivationPepperFile  string
	LicenseSigningKeyFile string
	ActivationPepper      []byte
	LicenseSigningKey     ed25519.PrivateKey
}

func Load() (Config, error) {
	return LoadFrom(os.Getenv)
}

func LoadFrom(getenv func(string) string) (Config, error) {
	if getenv == nil {
		return Config{}, errors.New("configuration source is required")
	}

	values := make(map[string]string, len(requiredVariables))
	for _, name := range requiredVariables {
		value := getenv(name)
		if strings.TrimSpace(value) == "" {
			return Config{}, fmt.Errorf("required configuration %s is missing", name)
		}
		values[name] = value
	}

	listenAddress := getenv("LISTEN_ADDRESS")
	if strings.TrimSpace(listenAddress) == "" {
		listenAddress = defaultListenAddress
	}
	pepper, err := loadPepper(values["ACTIVATION_PEPPER_FILE"])
	if err != nil {
		return Config{}, errors.New("configuration ACTIVATION_PEPPER_FILE is invalid")
	}
	signingKey, err := loadSigningKey(values["LICENSE_SIGNING_KEY_FILE"])
	if err != nil {
		return Config{}, errors.New("configuration LICENSE_SIGNING_KEY_FILE is invalid")
	}

	return Config{
		ListenAddress:         listenAddress,
		DatabaseURL:           values["DATABASE_URL"],
		ActivationPepperFile:  values["ACTIVATION_PEPPER_FILE"],
		LicenseSigningKeyFile: values["LICENSE_SIGNING_KEY_FILE"],
		ActivationPepper:      pepper,
		LicenseSigningKey:     signingKey,
	}, nil
}

func loadPepper(path string) ([]byte, error) {
	return readRegularFile(path, minimumPepperBytes, maximumPepperBytes)
}

func loadSigningKey(path string) (ed25519.PrivateKey, error) {
	encoded, err := readRegularFile(path, 1, maximumKeyFileBytes)
	if err != nil {
		return nil, err
	}
	decoded, err := base64.RawStdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil || len(decoded) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid Ed25519 private key")
	}

	privateKey := ed25519.PrivateKey(decoded)
	message := make([]byte, 32)
	if _, err := rand.Read(message); err != nil {
		return nil, errors.New("signing key self-check failed")
	}
	signature := ed25519.Sign(privateKey, message)
	if !ed25519.Verify(privateKey.Public().(ed25519.PublicKey), message, signature) {
		return nil, errors.New("signing key self-check failed")
	}
	return privateKey, nil
}

func readRegularFile(path string, minimumBytes int64, maximumBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < minimumBytes || info.Size() > maximumBytes {
		return nil, errors.New("secret file is invalid")
	}
	contents, err := io.ReadAll(io.LimitReader(file, maximumBytes+1))
	if err != nil || int64(len(contents)) > maximumBytes {
		return nil, errors.New("secret file is invalid")
	}
	return contents, nil
}
