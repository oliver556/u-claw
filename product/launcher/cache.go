package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

const cacheMarkerName = ".uclaw-runtime.json"
const hostCacheMarkerName = ".uclaw-cache.json"

var (
	ErrCachePreparationFailed = errors.New("runtime cache preparation failed")
	ErrRuntimeAuditFailed     = errors.New("runtime integrity audit failed")
)

type CacheResult struct {
	Path         string
	Reused       bool
	Verification string
}

type hostCacheMarker struct {
	SchemaVersion int    `json:"schemaVersion"`
	Product       string `json:"product"`
	Purpose       string `json:"purpose"`
}

var expectedHostCacheMarker = hostCacheMarker{
	SchemaVersion: 1,
	Product:       "U-Claw",
	Purpose:       "rebuildable-cache",
}

func EnsureHostCacheOwnership(cacheRoot string) error {
	if !filepath.IsAbs(cacheRoot) || filepath.Clean(cacheRoot) == filepath.VolumeName(cacheRoot)+string(os.PathSeparator) {
		return ErrCachePreparationFailed
	}
	info, err := os.Lstat(cacheRoot)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(cacheRoot, 0o700); err != nil {
			return ErrCachePreparationFailed
		}
		info, err = os.Lstat(cacheRoot)
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrCachePreparationFailed
	}
	root, err := os.OpenRoot(cacheRoot)
	if err != nil {
		return ErrCachePreparationFailed
	}
	defer root.Close()

	markerInfo, markerErr := root.Lstat(hostCacheMarkerName)
	if markerErr == nil {
		if !markerInfo.Mode().IsRegular() || markerInfo.Mode()&os.ModeSymlink != 0 {
			return ErrCachePreparationFailed
		}
		file, openErr := root.Open(hostCacheMarkerName)
		if openErr != nil {
			return ErrCachePreparationFailed
		}
		defer file.Close()
		decoder := json.NewDecoder(file)
		decoder.DisallowUnknownFields()
		var marker hostCacheMarker
		if decoder.Decode(&marker) != nil || marker != expectedHostCacheMarker {
			return ErrCachePreparationFailed
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			return ErrCachePreparationFailed
		}
		return ensureOwnedCacheDirectories(root)
	}
	if !errors.Is(markerErr, os.ErrNotExist) {
		return ErrCachePreparationFailed
	}
	file, err := root.OpenFile(hostCacheMarkerName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return ErrCachePreparationFailed
	}
	encoder := json.NewEncoder(file)
	encodeErr := encoder.Encode(expectedHostCacheMarker)
	syncErr := file.Sync()
	closeErr := file.Close()
	if encodeErr != nil || syncErr != nil || closeErr != nil {
		_ = root.Remove(hostCacheMarkerName)
		return ErrCachePreparationFailed
	}
	return ensureOwnedCacheDirectories(root)
}

func ensureOwnedCacheDirectories(root *os.Root) error {
	for _, directory := range []string{"runtimes", filepath.Join("cache", "temp"), filepath.Join("cache", "node-compile")} {
		if err := root.MkdirAll(directory, 0o700); err != nil {
			return ErrCachePreparationFailed
		}
	}
	return ensureRuntimeAnchor(root)
}

func EnsureRuntimeCache(
	ctx context.Context,
	cacheRoot string,
	packageRoot string,
	manifest Manifest,
) (CacheResult, error) {
	if err := ctx.Err(); err != nil {
		return CacheResult{}, err
	}
	if err := ValidateManifest(manifest); err != nil {
		return CacheResult{}, err
	}
	if err := os.MkdirAll(cacheRoot, 0o700); err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	root, err := os.OpenRoot(cacheRoot)
	if err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	defer root.Close()

	installName := runtimeInstallName(manifest)
	cachePath := filepath.Join(cacheRoot, installName)
	cacheInfo, cacheInfoErr := root.Lstat(installName)
	cacheIsOwnedDirectory := cacheInfoErr == nil && cacheInfo.IsDir() && cacheInfo.Mode()&os.ModeSymlink == 0
	if cacheIsOwnedDirectory {
		if runtimeCacheUsable(cachePath, manifest) {
			return CacheResult{Path: cachePath, Reused: true, Verification: "fast"}, nil
		}
		_, _ = runtimeFullAudit(cachePath)
		return CacheResult{}, ErrRuntimeAuditFailed
	}
	if cacheInfoErr == nil {
		return CacheResult{}, ErrRuntimeAuditFailed
	} else if !errors.Is(cacheInfoErr, os.ErrNotExist) {
		return CacheResult{}, ErrCachePreparationFailed
	}

	packageDirectory, err := os.OpenRoot(packageRoot)
	if err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	defer packageDirectory.Close()
	archivePath := strings.ReplaceAll(manifest.RuntimeArchive, `\`, string(os.PathSeparator))
	archive, err := packageDirectory.Open(archivePath)
	if err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	defer archive.Close()
	if err := validatePackageFile(archive, manifest); err != nil {
		return CacheResult{}, err
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	requiredSpace := uint64(manifest.RuntimeBytes) + uint64(manifest.UnpackedBytes) + 64<<20
	if requiredSpace < uint64(manifest.RuntimeBytes) || !runtimeInstallSpaceAvailable(cacheRoot, requiredSpace) {
		return CacheResult{}, ErrCachePreparationFailed
	}

	temporaryPath, err := os.MkdirTemp(cacheRoot, installName+".partial-")
	if err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	temporaryName := filepath.Base(temporaryPath)
	committed := false
	defer func() {
		if !committed {
			_ = root.RemoveAll(temporaryName)
		}
	}()

	archiveHash := sha256.New()
	verifiedArchive := &countingReader{reader: io.TeeReader(archive, archiveHash)}
	extractErr := ExtractRuntime(ctx, verifiedArchive, temporaryPath, manifest)
	if extractErr != nil {
		return CacheResult{}, extractErr
	}
	if _, err := io.Copy(io.Discard, verifiedArchive); err != nil || verifiedArchive.bytes != manifest.RuntimeBytes || hex.EncodeToString(archiveHash.Sum(nil)) != strings.ToLower(manifest.RuntimeSHA256) {
		return CacheResult{}, ErrPackageInvalid
	}
	if !runtimeEntrypointUsable(temporaryPath, manifest.Entrypoint) {
		return CacheResult{}, ErrCachePreparationFailed
	}
	if digest, err := runtimeTreeDigestAt(temporaryPath); err != nil || digest != strings.ToLower(manifest.RuntimeTreeSHA256) {
		return CacheResult{}, ErrCachePreparationFailed
	}
	if err := writeCacheMarker(temporaryPath, manifest); err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	if err := root.Rename(temporaryName, installName); err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	committed = true
	return CacheResult{Path: cachePath, Reused: false, Verification: "full"}, nil
}

func runtimeInstallName(manifest Manifest) string {
	return fmt.Sprintf("%d-%s", manifest.ReleaseSequence, strings.ToLower(manifest.RuntimeTreeSHA256))
}

type countingReader struct {
	reader io.Reader
	bytes  int64
}

func (reader *countingReader) Read(buffer []byte) (int, error) {
	read, err := reader.reader.Read(buffer)
	reader.bytes += int64(read)
	return read, err
}

func runtimeCacheUsable(cachePath string, manifest Manifest) bool {
	if !runtimeDirectoryAuditable(cachePath) {
		return false
	}
	marker, err := readCacheMarker(cachePath)
	if err != nil || !reflect.DeepEqual(marker, manifest) {
		return false
	}
	return verifyCriticalRuntimeFiles(cachePath, manifest) == nil
}

func readCacheMarker(cachePath string) (Manifest, error) {
	root, err := os.OpenRoot(cachePath)
	if err != nil {
		return Manifest{}, ErrPackageInvalid
	}
	defer root.Close()
	entry, err := root.Lstat(cacheMarkerName)
	if err != nil || !entry.Mode().IsRegular() || entry.Mode()&os.ModeSymlink != 0 || entry.Size() > maxManifestBytes {
		return Manifest{}, ErrPackageInvalid
	}
	file, err := root.Open(cacheMarkerName)
	if err != nil {
		return Manifest{}, ErrPackageInvalid
	}
	info, statErr := file.Stat()
	if statErr != nil {
		file.Close()
		return Manifest{}, ErrPackageInvalid
	}
	links, linkErr := fileLinkCount(file, info)
	decoder := json.NewDecoder(io.LimitReader(file, maxManifestBytes+1))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	decodeErr := decoder.Decode(&manifest)
	trailingErr := ensureJSONEnd(decoder)
	closeErr := file.Close()
	if linkErr != nil || links != 1 || !os.SameFile(entry, info) || decodeErr != nil || trailingErr != nil || closeErr != nil || ValidateManifest(manifest) != nil {
		return Manifest{}, ErrPackageInvalid
	}
	return manifest, nil
}

func runtimeDirectoryAuditable(cachePath string) bool {
	info, err := os.Lstat(cachePath)
	return err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0
}

func verifyCriticalRuntimeFiles(cachePath string, manifest Manifest) error {
	root, err := os.OpenRoot(cachePath)
	if err != nil {
		return ErrPackageInvalid
	}
	defer root.Close()
	for _, expected := range manifest.CriticalFiles {
		name := strings.ReplaceAll(expected.Path, `\`, string(os.PathSeparator))
		if !runtimeRelativePathHasNoLinks(root, name) {
			return ErrPackageInvalid
		}
		info, err := root.Lstat(name)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != expected.Size {
			return ErrPackageInvalid
		}
		file, err := root.Open(name)
		if err != nil {
			return ErrPackageInvalid
		}
		links, linkErr := fileLinkCount(file, info)
		hash := sha256.New()
		_, copyErr := io.Copy(hash, file)
		after, statErr := file.Stat()
		closeErr := file.Close()
		actual := hex.EncodeToString(hash.Sum(nil))
		if linkErr != nil || links != 1 || copyErr != nil || statErr != nil || closeErr != nil ||
			!os.SameFile(info, after) || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) ||
			subtle.ConstantTimeCompare([]byte(strings.ToLower(expected.SHA256)), []byte(actual)) != 1 {
			return ErrPackageInvalid
		}
	}
	return nil
}

func runtimeRelativePathHasNoLinks(root *os.Root, name string) bool {
	parts := strings.Split(filepath.Clean(name), string(os.PathSeparator))
	for index := range parts {
		candidate := filepath.Join(parts[:index+1]...)
		info, err := root.Lstat(candidate)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || index < len(parts)-1 && !info.IsDir() {
			return false
		}
	}
	return true
}

type runtimeTreeFile struct {
	path   string
	size   int64
	digest [sha256.Size]byte
}

func runtimeTreeDigestAt(cachePath string) (string, error) {
	root, err := os.OpenRoot(cachePath)
	if err != nil {
		return "", err
	}
	defer root.Close()
	files := make([]runtimeTreeFile, 0)
	var visit func(string) error
	visit = func(directory string) error {
		file, err := root.Open(directory)
		if err != nil {
			return err
		}
		entries, readErr := file.ReadDir(-1)
		closeErr := file.Close()
		if readErr != nil {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		for _, entry := range entries {
			relative := entry.Name()
			if directory != "." {
				relative = filepath.Join(directory, entry.Name())
			}
			if directory == "." && entry.Name() == cacheMarkerName {
				continue
			}
			info, err := root.Lstat(relative)
			if err != nil || info.Mode()&os.ModeSymlink != 0 {
				return ErrCachePreparationFailed
			}
			if info.IsDir() {
				if err := visit(relative); err != nil {
					return err
				}
				continue
			}
			if !info.Mode().IsRegular() {
				return ErrCachePreparationFailed
			}
			content, err := root.Open(relative)
			if err != nil {
				return err
			}
			links, linkErr := fileLinkCount(content, info)
			if linkErr != nil || links != 1 {
				content.Close()
				return ErrCachePreparationFailed
			}
			hash := sha256.New()
			_, copyErr := io.Copy(hash, content)
			after, statErr := content.Stat()
			closeErr := content.Close()
			if copyErr != nil || statErr != nil || closeErr != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
				return ErrCachePreparationFailed
			}
			var digest [sha256.Size]byte
			copy(digest[:], hash.Sum(nil))
			files = append(files, runtimeTreeFile{path: filepath.ToSlash(relative), size: info.Size(), digest: digest})
		}
		return nil
	}
	if err := visit("."); err != nil {
		return "", err
	}
	return runtimeTreeDigest(files), nil
}

func runtimeTreeDigest(files []runtimeTreeFile) string {
	sort.Slice(files, func(left, right int) bool { return files[left].path < files[right].path })
	hash := sha256.New()
	var pathLength [4]byte
	var size [8]byte
	for _, file := range files {
		binary.BigEndian.PutUint32(pathLength[:], uint32(len([]byte(file.path))))
		binary.BigEndian.PutUint64(size[:], uint64(file.size))
		hash.Write(pathLength[:])
		hash.Write([]byte(file.path))
		hash.Write(size[:])
		hash.Write(file.digest[:])
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func runtimeEntrypointUsable(cachePath string, entrypoint string) bool {
	root, err := os.OpenRoot(cachePath)
	if err != nil {
		return false
	}
	defer root.Close()
	path := strings.ReplaceAll(entrypoint, `\`, string(os.PathSeparator))
	file, err := root.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	return err == nil && info.Mode().IsRegular()
}

func writeCacheMarker(cachePath string, manifest Manifest) error {
	root, err := os.OpenRoot(cachePath)
	if err != nil {
		return err
	}
	defer root.Close()
	file, err := root.OpenFile(cacheMarkerName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	encoder.SetEscapeHTML(false)
	encodeErr := encoder.Encode(manifest)
	syncErr := file.Sync()
	closeErr := file.Close()
	if encodeErr != nil {
		return encodeErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

var runtimeFullAudit = runtimeTreeDigestAt
var runtimeInstallSpaceAvailable = hostHasRuntimeInstallSpace
