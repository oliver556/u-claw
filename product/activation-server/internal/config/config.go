package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"u-claw-activation-server/internal/admin"
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
	"STATUS_SIGNING_KEY_FILE",
	"LICENSE_KEY_ID",
	"STATUS_KEY_ID",
	"KMS_PROVIDER",
	"KMS_KEY_VERSION",
	"KMS_KEK_FILE",
	"TOKEN_SIGNING_KEY_FILE",
	"ADMIN_OPERATORS_FILE",
}

type Config struct {
	ListenAddress         string
	DatabaseURL           string
	ActivationPepperFile  string
	LicenseSigningKeyFile string
	ActivationPepper      []byte
	LicenseSigningKey     ed25519.PrivateKey
	StatusSigningKey      ed25519.PrivateKey
	LicenseKeyID          string
	StatusKeyID           string
	KMSProvider           string
	KMSKeyVersion         string
	KMSKEKFile            string
	KMSKEK                []byte
	TokenSigningKeyFile   string
	TokenSigningKey       []byte
	AdminOperatorsFile    string
	AdminOperators        admin.OperatorRegistry
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
	statusSigningKey, err := loadSigningKey(values["STATUS_SIGNING_KEY_FILE"])
	if err != nil {
		return Config{}, errors.New("configuration STATUS_SIGNING_KEY_FILE is invalid")
	}
	kek, err := loadKEK(values["KMS_KEK_FILE"])
	if err != nil {
		return Config{}, errors.New("configuration KMS_KEK_FILE is invalid")
	}
	tokenSigningKey, err := readRegularFile(values["TOKEN_SIGNING_KEY_FILE"], 32, maximumPepperBytes)
	if err != nil {
		return Config{}, errors.New("configuration TOKEN_SIGNING_KEY_FILE is invalid")
	}
	adminOperators, err := loadAdminOperators(values["ADMIN_OPERATORS_FILE"])
	if err != nil {
		return Config{}, errors.New("configuration ADMIN_OPERATORS_FILE is invalid")
	}

	return Config{
		ListenAddress:         listenAddress,
		DatabaseURL:           values["DATABASE_URL"],
		ActivationPepperFile:  values["ACTIVATION_PEPPER_FILE"],
		LicenseSigningKeyFile: values["LICENSE_SIGNING_KEY_FILE"],
		ActivationPepper:      pepper,
		LicenseSigningKey:     signingKey,
		StatusSigningKey:      statusSigningKey,
		LicenseKeyID:          values["LICENSE_KEY_ID"],
		StatusKeyID:           values["STATUS_KEY_ID"],
		KMSProvider:           values["KMS_PROVIDER"],
		KMSKeyVersion:         values["KMS_KEY_VERSION"],
		KMSKEKFile:            values["KMS_KEK_FILE"],
		KMSKEK:                kek,
		TokenSigningKeyFile:   values["TOKEN_SIGNING_KEY_FILE"],
		TokenSigningKey:       tokenSigningKey,
		AdminOperatorsFile:    values["ADMIN_OPERATORS_FILE"],
		AdminOperators:        adminOperators,
	}, nil
}

func loadAdminOperators(path string) (admin.OperatorRegistry, error) {
	contents, err := readRegularFile(path, 2, maximumPepperBytes)
	if err != nil {
		return nil, err
	}
	var encoded map[string]string
	decoder := json.NewDecoder(strings.NewReader(string(contents)))
	if err = decoder.Decode(&encoded); err != nil || decoder.Decode(&struct{}{}) != io.EOF || len(encoded) == 0 {
		return nil, errors.New("operator registry invalid")
	}
	result := make(admin.OperatorRegistry, len(encoded))
	seenDigests := make(map[[32]byte]struct{}, len(encoded))
	for operatorID, value := range encoded {
		decoded, decodeErr := hex.DecodeString(value)
		if decodeErr != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != value || len(operatorID) < 3 || len(operatorID) > 128 {
			return nil, errors.New("operator registry invalid")
		}
		var digest [32]byte
		copy(digest[:], decoded)
		if _, exists := seenDigests[digest]; exists {
			return nil, errors.New("operator registry invalid")
		}
		seenDigests[digest] = struct{}{}
		result[operatorID] = digest
	}
	return result, nil
}

func loadKEK(path string) ([]byte, error) {
	encoded, err := readRegularFile(path, 32, maximumKeyFileBytes)
	if err != nil {
		return nil, err
	}
	if len(encoded) == 32 {
		return append([]byte(nil), encoded...), nil
	}
	const prefix = "base64:"
	if !strings.HasPrefix(string(encoded), prefix) {
		return nil, errors.New("KEK format invalid")
	}
	decoded, err := base64.RawStdEncoding.Strict().DecodeString(strings.TrimPrefix(string(encoded), prefix))
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("KEK format invalid")
	}
	return decoded, nil
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
