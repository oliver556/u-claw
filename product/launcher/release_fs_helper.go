package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type secureInstallRequest struct {
	SchemaVersion int      `json:"schemaVersion"`
	Manifest      Manifest `json:"manifest"`
}

var releaseFSAfterOpenRoot func()
var releaseFSBeforeQuarantine func()

func runReleaseFSHelper(args []string, input io.Reader, output io.Writer) error {
	if len(args) == 0 {
		return ErrProcessInvalid
	}
	flags := flag.NewFlagSet("release-fs-helper", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	rootPath := flags.String("root", "", "")
	child := flags.String("child", "", "")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || !filepath.IsAbs(*rootPath) || filepath.Clean(*rootPath) != *rootPath {
		return ErrProcessInvalid
	}
	switch args[0] {
	case "secure-install":
		if *child != "" {
			return ErrProcessInvalid
		}
		return secureInstallAtRoot(*rootPath, input, output)
	case "cleanup-cache":
		if *child != "runtime" && *child != "cache" && *child != "updates" {
			return ErrProcessInvalid
		}
		return cleanupCacheChildAtRoot(*rootPath, *child)
	default:
		return ErrProcessInvalid
	}
}

func openReleaseFSRoot(path string) (*os.Root, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, ErrCachePreparationFailed
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, ErrCachePreparationFailed
	}
	after, err := root.Stat(".")
	if err != nil || !after.IsDir() || !os.SameFile(before, after) {
		root.Close()
		return nil, ErrCachePreparationFailed
	}
	if releaseFSAfterOpenRoot != nil {
		releaseFSAfterOpenRoot()
	}
	return root, nil
}

func secureInstallAtRoot(rootPath string, input io.Reader, output io.Writer) error {
	root, err := openReleaseFSRoot(rootPath)
	if err != nil {
		return err
	}
	defer root.Close()
	request, err := readSecureInstallRequest(input)
	if err != nil || request.SchemaVersion != 1 || ValidateManifest(request.Manifest) != nil || VerifyManifestSignature(request.Manifest, time.Now()) != nil {
		return ErrManifestInvalid
	}
	manifest := request.Manifest
	if manifest.RuntimeArchive != "runtime.pkg" {
		return ErrManifestInvalid
	}
	randomID, err := releaseFSRandomID()
	if err != nil {
		return ErrCachePreparationFailed
	}
	staging := ".update-staging-" + randomID
	if err := root.Mkdir(staging, 0o700); err != nil {
		return ErrCachePreparationFailed
	}
	committed := false
	defer func() {
		if !committed {
			_ = root.RemoveAll(staging)
		}
	}()
	if err := writeStagedRuntime(root, staging, input, manifest); err != nil {
		return err
	}
	if err := writeRootJSON(root, filepath.Join(staging, "version.json"), manifest, true); err != nil {
		return ErrCachePreparationFailed
	}
	for _, name := range []string{updateTransactionName, "runtime.pkg.rollback", "version.json.rollback"} {
		if exists, err := rootEntryExists(root, name); err != nil || exists {
			return ErrCachePreparationFailed
		}
	}
	runtimeExists, err := rootEntryExists(root, "runtime.pkg")
	if err != nil {
		return ErrCachePreparationFailed
	}
	versionExists, err := rootEntryExists(root, "version.json")
	if err != nil || runtimeExists != versionExists {
		return ErrCachePreparationFailed
	}
	var previous *updateIdentity
	if runtimeExists {
		previousManifest, err := installedPairAtRoot(root, "runtime.pkg", "version.json")
		if err != nil {
			return ErrPackageInvalid
		}
		if previousManifest.Signature == nil || manifest.Signature == nil || manifest.Signature.Sequence <= previousManifest.Signature.Sequence {
			return ErrManifestInvalid
		}
		identity := updateIdentityForManifest(previousManifest)
		previous = &identity
	}
	record := updateTransaction{
		SchemaVersion: 1,
		State:         "switching",
		Target:        updateIdentityForManifest(manifest),
		Previous:      previous,
	}
	if err := writeRootJSON(root, updateTransactionName, record, true); err != nil || syncReleaseFSRoot(root) != nil {
		return ErrCachePreparationFailed
	}
	if previous != nil {
		if err := root.Rename("runtime.pkg", "runtime.pkg.rollback"); err != nil || syncReleaseFSRoot(root) != nil {
			return ErrCachePreparationFailed
		}
		if err := root.Rename("version.json", "version.json.rollback"); err != nil || syncReleaseFSRoot(root) != nil {
			return ErrCachePreparationFailed
		}
	}
	if err := root.Rename(filepath.Join(staging, "runtime.pkg"), "runtime.pkg"); err != nil || syncReleaseFSRoot(root) != nil {
		return ErrCachePreparationFailed
	}
	if err := root.Rename(filepath.Join(staging, "version.json"), "version.json"); err != nil || syncReleaseFSRoot(root) != nil {
		return ErrCachePreparationFailed
	}
	installed, err := installedPairAtRoot(root, "runtime.pkg", "version.json")
	if err != nil || !sameUpdateManifestIdentity(installed, manifest) {
		return ErrPackageInvalid
	}
	record.State = "complete"
	if err := replaceRootJSON(root, updateTransactionName, record); err != nil {
		return ErrCachePreparationFailed
	}
	if err := root.Remove(staging); err != nil || syncReleaseFSRoot(root) != nil {
		return ErrCachePreparationFailed
	}
	committed = true
	_, _ = io.WriteString(output, "{\"state\":\"complete\"}\n")
	return nil
}

func readSecureInstallRequest(input io.Reader) (secureInstallRequest, error) {
	var length [4]byte
	if _, err := io.ReadFull(input, length[:]); err != nil {
		return secureInstallRequest{}, err
	}
	size := binary.BigEndian.Uint32(length[:])
	if size == 0 || size > maxManifestBytes {
		return secureInstallRequest{}, ErrManifestInvalid
	}
	header := make([]byte, size)
	if _, err := io.ReadFull(input, header); err != nil {
		return secureInstallRequest{}, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(header)))
	decoder.DisallowUnknownFields()
	var request secureInstallRequest
	if err := decoder.Decode(&request); err != nil || ensureJSONEnd(decoder) != nil {
		return secureInstallRequest{}, ErrManifestInvalid
	}
	return request, nil
}

func writeStagedRuntime(root *os.Root, staging string, input io.Reader, manifest Manifest) error {
	name := filepath.Join(staging, "runtime.pkg")
	file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrCachePreparationFailed
	}
	hash := sha256.New()
	written, copyErr := io.CopyN(io.MultiWriter(file, hash), input, manifest.RuntimeBytes)
	var trailing [1]byte
	trailingBytes, trailingErr := input.Read(trailing[:])
	syncErr := file.Sync()
	closeErr := file.Close()
	expected := strings.ToLower(manifest.RuntimeSHA256)
	actual := hex.EncodeToString(hash.Sum(nil))
	if copyErr != nil || written != manifest.RuntimeBytes || trailingBytes != 0 || !errors.Is(trailingErr, io.EOF) || syncErr != nil || closeErr != nil || subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) != 1 {
		return ErrPackageInvalid
	}
	return nil
}

func installedPairAtRoot(root *os.Root, runtimeName, versionName string) (Manifest, error) {
	manifest, err := readManifestAtRoot(root, versionName)
	if err != nil || VerifyManifestSignature(manifest, time.Now()) != nil {
		return Manifest{}, ErrManifestInvalid
	}
	file, err := openRegularRootFile(root, runtimeName)
	if err != nil {
		return Manifest{}, ErrPackageInvalid
	}
	defer file.Close()
	if err := validatePackageFile(file, manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func readManifestAtRoot(root *os.Root, name string) (Manifest, error) {
	file, err := openRegularRootFile(root, name)
	if err != nil {
		return Manifest{}, ErrManifestInvalid
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, maxManifestBytes+1))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil || ensureJSONEnd(decoder) != nil || ValidateManifest(manifest) != nil {
		return Manifest{}, ErrManifestInvalid
	}
	return manifest, nil
}

func openRegularRootFile(root *os.Root, name string) (*os.File, error) {
	before, err := root.Lstat(name)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return nil, ErrCachePreparationFailed
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, ErrCachePreparationFailed
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		file.Close()
		return nil, ErrCachePreparationFailed
	}
	return file, nil
}

func cleanupCacheChildAtRoot(rootPath, child string) error {
	root, err := openReleaseFSRoot(rootPath)
	if err != nil {
		return err
	}
	defer root.Close()
	if !readOwnedCacheMarkerAtRoot(root) {
		return ErrCachePreparationFailed
	}
	info, err := root.Lstat(child)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrCachePreparationFailed
	}
	if releaseFSBeforeQuarantine != nil {
		releaseFSBeforeQuarantine()
	}
	randomID, err := releaseFSRandomID()
	if err != nil {
		return ErrCachePreparationFailed
	}
	quarantine := ".uclaw-cleanup-" + randomID + "-" + child
	if err := root.Rename(child, quarantine); err != nil {
		return ErrCachePreparationFailed
	}
	if err := validateRemovalTree(root, quarantine); err != nil {
		return ErrCachePreparationFailed
	}
	if err := root.RemoveAll(quarantine); err != nil || syncReleaseFSRoot(root) != nil {
		return ErrCachePreparationFailed
	}
	return nil
}

func validateRemovalTree(root *os.Root, directory string) error {
	info, err := root.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrCachePreparationFailed
	}
	file, err := root.Open(directory)
	if err != nil {
		return ErrCachePreparationFailed
	}
	entries, readErr := file.ReadDir(-1)
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return ErrCachePreparationFailed
	}
	for _, entry := range entries {
		name := filepath.Join(directory, entry.Name())
		child, err := root.Lstat(name)
		if err != nil || child.Mode()&os.ModeSymlink != 0 {
			return ErrCachePreparationFailed
		}
		if child.IsDir() {
			if err := validateRemovalTree(root, name); err != nil {
				return err
			}
		} else if !child.Mode().IsRegular() {
			return ErrCachePreparationFailed
		}
	}
	return nil
}

func readOwnedCacheMarkerAtRoot(root *os.Root) bool {
	file, err := openRegularRootFile(root, hostCacheMarkerName)
	if err != nil {
		return false
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	decoder.DisallowUnknownFields()
	var marker hostCacheMarker
	return decoder.Decode(&marker) == nil && errors.Is(decoder.Decode(&struct{}{}), io.EOF) && marker == expectedHostCacheMarker
}

func writeRootJSON(root *os.Root, name string, value any, exclusive bool) error {
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if exclusive {
		flags = os.O_WRONLY | os.O_CREATE | os.O_EXCL
	}
	file, err := root.OpenFile(name, flags, 0o600)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	encoder.SetEscapeHTML(false)
	encodeErr := encoder.Encode(value)
	syncErr := file.Sync()
	closeErr := file.Close()
	return errors.Join(encodeErr, syncErr, closeErr)
}

func replaceRootJSON(root *os.Root, name string, value any) error {
	randomID, err := releaseFSRandomID()
	if err != nil {
		return err
	}
	temporary := name + ".new-" + randomID
	if err := writeRootJSON(root, temporary, value, true); err != nil {
		return err
	}
	if err := root.Rename(temporary, name); err != nil {
		_ = root.Remove(temporary)
		return err
	}
	return syncReleaseFSRoot(root)
}

func rootEntryExists(root *os.Root, name string) (bool, error) {
	info, err := root.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		return false, ErrCachePreparationFailed
	}
	return true, nil
}

func syncReleaseFSRoot(root *os.Root) error {
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	syncErr := directory.Sync()
	return errors.Join(syncErr, directory.Close())
}

func updateIdentityForManifest(manifest Manifest) updateIdentity {
	return updateIdentity{Sequence: manifest.Signature.Sequence, RuntimeSHA256: strings.ToLower(manifest.RuntimeSHA256), SignatureValue: manifest.Signature.Value}
}

func sameUpdateManifestIdentity(left, right Manifest) bool {
	if left.Signature == nil || right.Signature == nil {
		return false
	}
	return left.Signature.Sequence == right.Signature.Sequence && strings.EqualFold(left.RuntimeSHA256, right.RuntimeSHA256) && left.Signature.Value == right.Signature.Value
}

func releaseFSRandomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}
