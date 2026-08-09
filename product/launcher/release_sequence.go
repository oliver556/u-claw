package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
)

const releaseSequenceName = ".uclaw-release-sequence.json"

type releaseSequenceRecord struct {
	SchemaVersion int    `json:"schemaVersion"`
	Sequence      uint64 `json:"sequence"`
}

func AcceptRuntimeSequence(cacheRoot string, manifest Manifest) error {
	if manifest.Signature == nil || manifest.Signature.Sequence == 0 {
		return ErrManifestInvalid
	}
	current, root, err := readRuntimeSequence(cacheRoot)
	if err != nil {
		return err
	}
	defer root.Close()
	if manifest.Signature.Sequence < current {
		return ErrManifestInvalid
	}
	if manifest.Signature.Sequence == current {
		return nil
	}
	temporary := releaseSequenceName + ".new"
	_ = root.Remove(temporary)
	out, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrManifestInvalid
	}
	encodeErr := json.NewEncoder(out).Encode(releaseSequenceRecord{SchemaVersion: 1, Sequence: manifest.Signature.Sequence})
	syncErr := out.Sync()
	closeErr := out.Close()
	if encodeErr != nil || syncErr != nil || closeErr != nil {
		_ = root.Remove(temporary)
		return ErrManifestInvalid
	}
	if err := root.Rename(temporary, releaseSequenceName); err != nil {
		_ = root.Remove(temporary)
		return ErrManifestInvalid
	}
	directory, err := root.Open(".")
	if err != nil {
		return ErrManifestInvalid
	}
	syncErr = directory.Sync()
	closeErr = directory.Close()
	if syncErr != nil || closeErr != nil {
		return ErrManifestInvalid
	}
	return nil
}

func CheckRuntimeSequence(cacheRoot string, manifest Manifest) error {
	if manifest.Signature == nil || manifest.Signature.Sequence == 0 {
		return ErrManifestInvalid
	}
	current, root, err := readRuntimeSequence(cacheRoot)
	if root != nil {
		root.Close()
	}
	if err != nil || manifest.Signature.Sequence < current {
		return ErrManifestInvalid
	}
	return nil
}

func readRuntimeSequence(cacheRoot string) (uint64, *os.Root, error) {
	root, err := os.OpenRoot(cacheRoot)
	if err != nil {
		return 0, nil, ErrManifestInvalid
	}
	current := uint64(0)
	file, openErr := root.Open(releaseSequenceName)
	if openErr == nil {
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() {
			file.Close()
			root.Close()
			return 0, nil, ErrManifestInvalid
		}
		decoder := json.NewDecoder(io.LimitReader(file, 4097))
		decoder.DisallowUnknownFields()
		var record releaseSequenceRecord
		decodeErr := decoder.Decode(&record)
		trailingErr := decoder.Decode(&struct{}{})
		closeErr := file.Close()
		if decodeErr != nil || !errors.Is(trailingErr, io.EOF) || closeErr != nil || record.SchemaVersion != 1 || record.Sequence == 0 {
			root.Close()
			return 0, nil, ErrManifestInvalid
		}
		current = record.Sequence
	} else if !errors.Is(openErr, os.ErrNotExist) {
		root.Close()
		return 0, nil, ErrManifestInvalid
	}
	return current, root, nil
}
