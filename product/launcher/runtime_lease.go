package main

import (
	"path/filepath"
	"strings"
)

type RuntimeLease interface {
	RootPath() string
	VerifyEntrypoint(string) error
	Close() error
}

type runtimeFileIdentity struct {
	volumeSerialNumber uint32
	fileIndexHigh      uint32
	fileIndexLow       uint32
	fileSize           uint64
	lastWriteTime      uint64
}

func (identity runtimeFileIdentity) matches(other runtimeFileIdentity) bool {
	return identity == other
}

func runtimeLeaseEntrypointMatches(rootPath, manifestEntrypoint, candidate string, caseInsensitive bool) bool {
	if !filepath.IsAbs(rootPath) || filepath.Clean(rootPath) != rootPath ||
		!filepath.IsAbs(candidate) || filepath.Clean(candidate) != candidate {
		return false
	}
	entrypoint := strings.ReplaceAll(manifestEntrypoint, `\`, string(filepath.Separator))
	expected := filepath.Join(rootPath, entrypoint)
	relative, err := filepath.Rel(rootPath, expected)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false
	}
	if caseInsensitive {
		return strings.EqualFold(candidate, expected)
	}
	return candidate == expected
}
