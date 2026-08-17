package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
)

const updateTransactionName = ".update-transaction.json"

type updateIdentity struct {
	Sequence       uint64 `json:"sequence"`
	RuntimeSHA256  string `json:"runtimeSha256"`
	SignatureValue string `json:"signatureValue"`
}

type updateTransaction struct {
	SchemaVersion int             `json:"schemaVersion"`
	State         string          `json:"state"`
	Target        updateIdentity  `json:"target"`
	Previous      *updateIdentity `json:"previous"`
}

func FinalizeUpdateTransaction(packageRoot string, manifest Manifest) error {
	root, err := os.OpenRoot(packageRoot)
	if err != nil {
		return ErrManifestInvalid
	}
	defer root.Close()

	file, err := root.Open(updateTransactionName)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return ErrManifestInvalid
	}
	info, statErr := file.Stat()
	if statErr != nil {
		file.Close()
		return ErrManifestInvalid
	}
	links, linkErr := fileLinkCount(file, info)
	if linkErr != nil || !info.Mode().IsRegular() || links != 1 || info.Size() > 4096 {
		file.Close()
		return ErrManifestInvalid
	}
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	decoder.DisallowUnknownFields()
	var record updateTransaction
	decodeErr := decoder.Decode(&record)
	trailingErr := decoder.Decode(&struct{}{})
	closeErr := file.Close()
	if decodeErr != nil || !errors.Is(trailingErr, io.EOF) || closeErr != nil ||
		record.SchemaVersion != 1 || (record.State != "switching" && record.State != "complete") || manifest.Signature == nil ||
		record.Target.Sequence != manifest.Signature.Sequence ||
		!strings.EqualFold(record.Target.RuntimeSHA256, manifest.RuntimeSHA256) ||
		record.Target.SignatureValue != manifest.Signature.Value {
		return ErrManifestInvalid
	}

	for _, name := range []string{"runtime.pkg.rollback", "version.json.rollback"} {
		if err := root.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			return ErrManifestInvalid
		}
	}
	if err := root.Remove(updateTransactionName); err != nil {
		return ErrManifestInvalid
	}
	directory, err := root.Open(".")
	if err != nil {
		return ErrManifestInvalid
	}
	syncErr := syncDirectory(directory)
	closeErr = directory.Close()
	if syncErr != nil || closeErr != nil {
		return ErrManifestInvalid
	}
	return nil
}
