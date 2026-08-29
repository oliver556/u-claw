package admin

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"crypto/pbkdf2"
)

const (
	maxGenerateCount      = 50
	passwordHashVersion   = "pbkdf2_sha256"
	passwordHashIteration = 210000
	sessionTokenBytes     = 32
)

// Store defines the operational surface needed by the admin console.
type Store interface {
	CountAdminUsers(ctx context.Context) (int64, error)
	CreateAdminUser(ctx context.Context, username string, passwordHash string, at time.Time) (AdminUser, error)
	GetAdminUserByUsername(ctx context.Context, username string) (AdminUser, error)
	CreateAdminSession(ctx context.Context, userID int64, tokenHash string, expiresAt time.Time, at time.Time) error
	GetAdminSession(ctx context.Context, tokenHash string, at time.Time) (AdminSession, error)
	CreateActivationBatch(ctx context.Context, name string, note string, createdBy string) (int64, error)
	CreateActivationCode(ctx context.Context, code ActivationCodeSecret, batchID sql.NullInt64, at time.Time) (ActivationCode, error)
	ListActivationCodes(ctx context.Context, filter ActivationCodeFilter) ([]ActivationCode, error)
	GetActivationCode(ctx context.Context, id int64) (ActivationCode, error)
	DisableActivationCode(ctx context.Context, id int64, reason string, at time.Time) error
	ReissueActivationCode(ctx context.Context, id int64, replacementCode ActivationCodeSecret, at time.Time) (ActivationCode, error)
}

// Config carries admin console security settings.
type Config struct {
	SessionTTL    time.Duration
	EncryptionKey string
}

// AdminUser is an operator account.
type AdminUser struct {
	ID           int64
	Username     string
	PasswordHash string
	Status       string
	CreatedAt    time.Time
}

// AdminSession is a verified operator session.
type AdminSession struct {
	UserID    int64
	Username  string
	ExpiresAt time.Time
}

// SetupStatus tells the UI whether first-admin registration is still open.
type SetupStatus struct {
	RegistrationOpen bool `json:"registrationOpen"`
}

// AuthResult is returned after register or login.
type AuthResult struct {
	Token     string    `json:"token"`
	Username  string    `json:"username"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// ActivationCodeFilter limits list queries for the admin console.
type ActivationCodeFilter struct {
	Status string
	Limit  int
}

// ActivationCodeSecret carries plaintext plus encrypted display material.
type ActivationCodeSecret struct {
	Code        string
	Ciphertext  string
	DisplayHint string
}

// ActivationCode is a redacted operational view of one inventory row.
type ActivationCode struct {
	ID                     int64      `json:"id"`
	BatchID                *int64     `json:"batchId,omitempty"`
	BatchName              string     `json:"batchName,omitempty"`
	Status                 string     `json:"status"`
	BoundUserID            *int64     `json:"boundUserId,omitempty"`
	BoundPhone             string     `json:"boundPhone,omitempty"`
	BoundAt                *time.Time `json:"boundAt,omitempty"`
	CreatedAt              time.Time  `json:"createdAt"`
	ExpiresAt              *time.Time `json:"expiresAt,omitempty"`
	CodeDisplayHint        string     `json:"codeHint,omitempty"`
	CodeCiphertext         string     `json:"-"`
	CodeVisible            bool       `json:"codeVisible"`
	NewAPIUserID           *int64     `json:"newapiUserId,omitempty"`
	NewAPIUsername         string     `json:"newapiUsername,omitempty"`
	NewAPIBaseURL          string     `json:"newapiBaseUrl,omitempty"`
	NewAPITokenRotatedAt   *time.Time `json:"newapiTokenRotatedAt,omitempty"`
	LatestActivationID     string     `json:"latestActivationId,omitempty"`
	LatestActivationStage  string     `json:"latestActivationStage,omitempty"`
	LatestActivationCommit *time.Time `json:"latestActivationCommit,omitempty"`
	PlainCode              string     `json:"code,omitempty"`
}

// GenerateRequest describes a batch of codes to create and show.
type GenerateRequest struct {
	Count     int    `json:"count"`
	BatchName string `json:"batchName"`
	Note      string `json:"note"`
	CreatedBy string `json:"createdBy"`
}

// Service owns admin auth and activation inventory workflows.
type Service struct {
	store      Store
	now        func() time.Time
	sessionTTL time.Duration
	cipherKey  []byte
}

// NewService returns an admin service backed by inventory storage.
func NewService(store Store, cfg Config) (*Service, error) {
	if store == nil {
		return nil, fmt.Errorf("admin store is required")
	}
	ttl := cfg.SessionTTL
	if ttl <= 0 {
		ttl = 12 * time.Hour
	}
	var key []byte
	if strings.TrimSpace(cfg.EncryptionKey) != "" {
		sum := sha256.Sum256([]byte(strings.TrimSpace(cfg.EncryptionKey)))
		key = sum[:]
	}
	return &Service{store: store, now: time.Now, sessionTTL: ttl, cipherKey: key}, nil
}

// SetupStatus reports whether the first operator account can be registered.
func (s *Service) SetupStatus(ctx context.Context) (SetupStatus, error) {
	count, err := s.store.CountAdminUsers(ctx)
	if err != nil {
		return SetupStatus{}, err
	}
	return SetupStatus{RegistrationOpen: count == 0}, nil
}

// Register creates the first operator account.
func (s *Service) Register(ctx context.Context, username string, password string) (AuthResult, error) {
	username = normalizeUsername(username)
	if err := validateUsername(username); err != nil {
		return AuthResult{}, err
	}
	count, err := s.store.CountAdminUsers(ctx)
	if err != nil {
		return AuthResult{}, err
	}
	if count != 0 {
		return AuthResult{}, fmt.Errorf("admin registration is closed")
	}
	hash, err := hashPassword(password)
	if err != nil {
		return AuthResult{}, err
	}
	user, err := s.store.CreateAdminUser(ctx, username, hash, s.now().UTC())
	if err != nil {
		return AuthResult{}, err
	}
	return s.createSession(ctx, user)
}

// Login verifies an operator password and returns a session token.
func (s *Service) Login(ctx context.Context, username string, password string) (AuthResult, error) {
	user, err := s.store.GetAdminUserByUsername(ctx, normalizeUsername(username))
	if err != nil {
		return AuthResult{}, fmt.Errorf("admin username or password is invalid")
	}
	if user.Status != "active" || !verifyPassword(password, user.PasswordHash) {
		return AuthResult{}, fmt.Errorf("admin username or password is invalid")
	}
	return s.createSession(ctx, user)
}

// VerifySession validates a bearer session token.
func (s *Service) VerifySession(ctx context.Context, token string) (AdminSession, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return AdminSession{}, fmt.Errorf("authorization bearer token is required")
	}
	return s.store.GetAdminSession(ctx, hashSessionToken(token), s.now().UTC())
}

// GenerateActivationCodes creates printable codes and persists encrypted display copies.
func (s *Service) GenerateActivationCodes(ctx context.Context, req GenerateRequest) ([]ActivationCode, error) {
	count := req.Count
	if count == 0 {
		count = 1
	}
	if count < 0 || count > maxGenerateCount {
		return nil, fmt.Errorf("count must be between 1 and %d", maxGenerateCount)
	}
	var batchID sql.NullInt64
	if strings.TrimSpace(req.BatchName) != "" || strings.TrimSpace(req.Note) != "" {
		id, err := s.store.CreateActivationBatch(ctx, strings.TrimSpace(req.BatchName), strings.TrimSpace(req.Note), strings.TrimSpace(req.CreatedBy))
		if err != nil {
			return nil, err
		}
		batchID = sql.NullInt64{Int64: id, Valid: true}
	}
	codes := make([]ActivationCode, 0, count)
	for len(codes) < count {
		secret, err := s.newActivationCodeSecret()
		if err != nil {
			return nil, err
		}
		record, err := s.store.CreateActivationCode(ctx, secret, batchID, s.now().UTC())
		if err != nil {
			return nil, err
		}
		record.PlainCode = secret.Code
		record.CodeVisible = true
		codes = append(codes, record)
	}
	return codes, nil
}

// ListActivationCodes returns recent inventory with user and New API mapping.
func (s *Service) ListActivationCodes(ctx context.Context, filter ActivationCodeFilter) ([]ActivationCode, error) {
	if filter.Limit <= 0 || filter.Limit > 200 {
		filter.Limit = 50
	}
	filter.Status = strings.ToLower(strings.TrimSpace(filter.Status))
	records, err := s.store.ListActivationCodes(ctx, filter)
	if err != nil {
		return nil, err
	}
	for i := range records {
		s.attachPlainCode(&records[i])
	}
	return records, nil
}

// GetActivationCode returns one inventory row and its current mapping.
func (s *Service) GetActivationCode(ctx context.Context, id int64) (ActivationCode, error) {
	if id <= 0 {
		return ActivationCode{}, fmt.Errorf("activation code id is required")
	}
	record, err := s.store.GetActivationCode(ctx, id)
	if err != nil {
		return ActivationCode{}, err
	}
	s.attachPlainCode(&record)
	return record, nil
}

// DisableActivationCode prevents a code from being used again.
func (s *Service) DisableActivationCode(ctx context.Context, id int64, reason string) error {
	if id <= 0 {
		return fmt.Errorf("activation code id is required")
	}
	return s.store.DisableActivationCode(ctx, id, strings.TrimSpace(reason), s.now().UTC())
}

// ReissueActivationCode replaces an unused or disabled code and returns the new plaintext.
func (s *Service) ReissueActivationCode(ctx context.Context, id int64) (ActivationCode, error) {
	if id <= 0 {
		return ActivationCode{}, fmt.Errorf("activation code id is required")
	}
	secret, err := s.newActivationCodeSecret()
	if err != nil {
		return ActivationCode{}, err
	}
	record, err := s.store.ReissueActivationCode(ctx, id, secret, s.now().UTC())
	if err != nil {
		return ActivationCode{}, err
	}
	record.PlainCode = secret.Code
	record.CodeVisible = true
	return record, nil
}

// GenerateActivationCode creates a human-readable one-time code for USB card printing.
func GenerateActivationCode() (string, error) {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	return encoded[:4] + "-" + encoded[4:8] + "-" + encoded[8:12] + "-" + encoded[12:16], nil
}

func (s *Service) createSession(ctx context.Context, user AdminUser) (AuthResult, error) {
	token, err := randomToken(sessionTokenBytes)
	if err != nil {
		return AuthResult{}, err
	}
	expiresAt := s.now().UTC().Add(s.sessionTTL)
	if err := s.store.CreateAdminSession(ctx, user.ID, hashSessionToken(token), expiresAt, s.now().UTC()); err != nil {
		return AuthResult{}, err
	}
	return AuthResult{Token: token, Username: user.Username, ExpiresAt: expiresAt}, nil
}

func (s *Service) newActivationCodeSecret() (ActivationCodeSecret, error) {
	code, err := GenerateActivationCode()
	if err != nil {
		return ActivationCodeSecret{}, fmt.Errorf("generate activation code: %w", err)
	}
	ciphertext, err := s.encryptCode(code)
	if err != nil {
		return ActivationCodeSecret{}, err
	}
	return ActivationCodeSecret{
		Code:        code,
		Ciphertext:  ciphertext,
		DisplayHint: code[len(code)-4:],
	}, nil
}

func (s *Service) attachPlainCode(record *ActivationCode) {
	if strings.TrimSpace(record.CodeCiphertext) == "" {
		return
	}
	code, err := s.decryptCode(record.CodeCiphertext)
	if err != nil {
		return
	}
	record.PlainCode = code
	record.CodeVisible = true
}

func (s *Service) encryptCode(code string) (string, error) {
	if len(s.cipherKey) == 0 {
		return "", nil
	}
	block, err := aes.NewCipher(s.cipherKey)
	if err != nil {
		return "", fmt.Errorf("build activation code cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("build activation code gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate activation code nonce: %w", err)
	}
	blob := append(nonce, gcm.Seal(nil, nonce, []byte(code), nil)...)
	return "v1:" + base64.RawURLEncoding.EncodeToString(blob), nil
}

func (s *Service) decryptCode(value string) (string, error) {
	if len(s.cipherKey) == 0 || !strings.HasPrefix(value, "v1:") {
		return "", fmt.Errorf("activation code display is unavailable")
	}
	blob, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, "v1:"))
	if err != nil {
		return "", fmt.Errorf("decode activation code ciphertext: %w", err)
	}
	block, err := aes.NewCipher(s.cipherKey)
	if err != nil {
		return "", fmt.Errorf("build activation code cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("build activation code gcm: %w", err)
	}
	if len(blob) < gcm.NonceSize() {
		return "", fmt.Errorf("activation code ciphertext is invalid")
	}
	nonce, ciphertext := blob[:gcm.NonceSize()], blob[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt activation code: %w", err)
	}
	return string(plain), nil
}

func hashPassword(password string) (string, error) {
	password = strings.TrimSpace(password)
	if len(password) < 8 {
		return "", fmt.Errorf("password must be at least 8 characters")
	}
	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	hash, err := pbkdf2.Key(sha256.New, password, salt, passwordHashIteration, 32)
	if err != nil {
		return "", fmt.Errorf("hash password: %w", err)
	}
	return strings.Join([]string{
		passwordHashVersion,
		fmt.Sprintf("%d", passwordHashIteration),
		base64.RawURLEncoding.EncodeToString(salt),
		base64.RawURLEncoding.EncodeToString(hash),
	}, "$"), nil
}

func verifyPassword(password string, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != passwordHashVersion {
		return false
	}
	iterations := passwordHashIteration
	var parsed int
	if n, err := fmt.Sscanf(parts[1], "%d", &parsed); err == nil && n == 1 && parsed > 0 {
		iterations = parsed
	}
	salt, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	expected, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	actual, err := pbkdf2.Key(sha256.New, strings.TrimSpace(password), salt, iterations, len(expected))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func hashSessionToken(token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func randomToken(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func normalizeUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

func validateUsername(username string) error {
	if len(username) < 3 || len(username) > 64 {
		return fmt.Errorf("admin username must be 3-64 characters")
	}
	for _, ch := range username {
		if ch >= 'a' && ch <= 'z' {
			continue
		}
		if ch >= '0' && ch <= '9' {
			continue
		}
		if ch == '.' || ch == '_' || ch == '-' {
			continue
		}
		return fmt.Errorf("admin username can only contain letters, numbers, dot, underscore, or hyphen")
	}
	return nil
}

// MemoryStore gives local tests and dev servers a small admin inventory.
type MemoryStore struct {
	mu       sync.Mutex
	nextID   int64
	batches  map[int64]string
	codes    map[int64]ActivationCode
	users    map[string]AdminUser
	sessions map[string]AdminSession
}

// NewMemoryStore returns an in-memory admin store for tests only.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		nextID:   1,
		batches:  make(map[int64]string),
		codes:    make(map[int64]ActivationCode),
		users:    make(map[string]AdminUser),
		sessions: make(map[string]AdminSession),
	}
}

// CountAdminUsers returns local operator count.
func (s *MemoryStore) CountAdminUsers(_ context.Context) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return int64(len(s.users)), nil
}

// CreateAdminUser inserts a local operator.
func (s *MemoryStore) CreateAdminUser(_ context.Context, username string, passwordHash string, at time.Time) (AdminUser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if username == "" {
		return AdminUser{}, fmt.Errorf("admin username is required")
	}
	if _, ok := s.users[username]; ok {
		return AdminUser{}, fmt.Errorf("admin username already exists")
	}
	user := AdminUser{ID: s.nextID, Username: username, PasswordHash: passwordHash, Status: "active", CreatedAt: at}
	s.nextID++
	s.users[username] = user
	return user, nil
}

// GetAdminUserByUsername returns a local operator by username.
func (s *MemoryStore) GetAdminUserByUsername(_ context.Context, username string) (AdminUser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	user, ok := s.users[username]
	if !ok {
		return AdminUser{}, fmt.Errorf("admin user not found")
	}
	return user, nil
}

// CreateAdminSession stores a local session.
func (s *MemoryStore) CreateAdminSession(_ context.Context, userID int64, tokenHash string, expiresAt time.Time, _ time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	username := ""
	for _, user := range s.users {
		if user.ID == userID {
			username = user.Username
			break
		}
	}
	s.sessions[tokenHash] = AdminSession{UserID: userID, Username: username, ExpiresAt: expiresAt}
	return nil
}

// GetAdminSession verifies a local session.
func (s *MemoryStore) GetAdminSession(_ context.Context, tokenHash string, at time.Time) (AdminSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[tokenHash]
	if !ok || !session.ExpiresAt.After(at) {
		return AdminSession{}, fmt.Errorf("admin session is invalid")
	}
	return session, nil
}

// CreateActivationBatch records a local batch label.
func (s *MemoryStore) CreateActivationBatch(_ context.Context, name string, _ string, _ string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.nextID
	s.nextID++
	s.batches[id] = strings.TrimSpace(name)
	return id, nil
}

// CreateActivationCode inserts a local activation code row.
func (s *MemoryStore) CreateActivationCode(_ context.Context, secret ActivationCodeSecret, batchID sql.NullInt64, at time.Time) (ActivationCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.nextID
	s.nextID++
	record := ActivationCode{ID: id, Status: "unused", CreatedAt: at, CodeCiphertext: secret.Ciphertext, CodeDisplayHint: secret.DisplayHint}
	if batchID.Valid {
		record.BatchID = &batchID.Int64
		record.BatchName = s.batches[batchID.Int64]
	}
	s.codes[id] = record
	return record, nil
}

// ListActivationCodes returns local activation inventory.
func (s *MemoryStore) ListActivationCodes(_ context.Context, filter ActivationCodeFilter) ([]ActivationCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	records := make([]ActivationCode, 0, len(s.codes))
	for _, record := range s.codes {
		if filter.Status != "" && record.Status != filter.Status {
			continue
		}
		records = append(records, record)
		if len(records) >= filter.Limit {
			break
		}
	}
	return records, nil
}

// GetActivationCode returns a local activation code by id.
func (s *MemoryStore) GetActivationCode(_ context.Context, id int64) (ActivationCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.codes[id]
	if !ok {
		return ActivationCode{}, fmt.Errorf("activation code not found")
	}
	return record, nil
}

// DisableActivationCode marks a local code disabled.
func (s *MemoryStore) DisableActivationCode(_ context.Context, id int64, _ string, _ time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.codes[id]
	if !ok {
		return fmt.Errorf("activation code not found")
	}
	record.Status = "disabled"
	s.codes[id] = record
	return nil
}

// ReissueActivationCode replaces a local unused or disabled code.
func (s *MemoryStore) ReissueActivationCode(_ context.Context, id int64, secret ActivationCodeSecret, at time.Time) (ActivationCode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, ok := s.codes[id]
	if !ok {
		return ActivationCode{}, fmt.Errorf("activation code not found")
	}
	if old.Status != "unused" && old.Status != "disabled" {
		return ActivationCode{}, fmt.Errorf("activation code is not reissueable")
	}
	old.Status = "reissued"
	s.codes[id] = old
	newID := s.nextID
	s.nextID++
	record := ActivationCode{ID: newID, Status: "unused", CreatedAt: at, BatchID: old.BatchID, BatchName: old.BatchName, CodeCiphertext: secret.Ciphertext, CodeDisplayHint: secret.DisplayHint}
	s.codes[newID] = record
	return record, nil
}
