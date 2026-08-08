package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
)

var ErrInstanceRunning = errors.New("u-claw instance already running")

type InstanceLock interface {
	Close() error
}

func instanceLockID(dataDir string) (string, error) {
	absolute, err := filepath.Abs(dataDir)
	if err != nil {
		return "", err
	}
	normalized := strings.ToLower(filepath.Clean(absolute))
	digest := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(digest[:]), nil
}
