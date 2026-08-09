package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

const cacheMarkerName = ".uclaw-runtime.json"
const hostCacheMarkerName = ".uclaw-cache.json"

var ErrCachePreparationFailed = errors.New("runtime cache preparation failed")

type CacheResult struct {
	Path   string
	Reused bool
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
	for _, directory := range []string{filepath.Join("cache", "temp"), filepath.Join("cache", "node-compile")} {
		if err := root.MkdirAll(directory, 0o700); err != nil {
			return ErrCachePreparationFailed
		}
	}
	return nil
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
	if err := os.MkdirAll(cacheRoot, 0o700); err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	root, err := os.OpenRoot(cacheRoot)
	if err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	defer root.Close()
	if err := removeStalePartialCaches(root, manifest.RuntimeID); err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}

	cachePath := filepath.Join(cacheRoot, manifest.RuntimeID)
	cacheInfo, cacheInfoErr := root.Lstat(manifest.RuntimeID)
	cacheIsOwnedDirectory := cacheInfoErr == nil && cacheInfo.IsDir() && cacheInfo.Mode()&os.ModeSymlink == 0
	if cacheIsOwnedDirectory && runtimeCacheUsable(cachePath, manifest) {
		return CacheResult{Path: cachePath, Reused: true}, nil
	}
	if cacheInfoErr == nil {
		if err := root.RemoveAll(manifest.RuntimeID); err != nil {
			return CacheResult{}, ErrCachePreparationFailed
		}
	} else if !errors.Is(cacheInfoErr, os.ErrNotExist) {
		return CacheResult{}, ErrCachePreparationFailed
	}

	temporaryPath, err := os.MkdirTemp(cacheRoot, manifest.RuntimeID+".partial-")
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
	if err := root.Rename(temporaryName, manifest.RuntimeID); err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	committed = true
	return CacheResult{Path: cachePath, Reused: false}, nil
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
	marker, err := readManifestFile(filepath.Join(cachePath, cacheMarkerName))
	if err != nil || !reflect.DeepEqual(marker, manifest) {
		return false
	}
	if !runtimeEntrypointUsable(cachePath, manifest.Entrypoint) {
		return false
	}
	digest, err := runtimeTreeDigestAt(cachePath)
	return err == nil && digest == strings.ToLower(manifest.RuntimeTreeSHA256)
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

func removeStalePartialCaches(root *os.Root, runtimeID string) error {
	entries, err := os.ReadDir(root.Name())
	if err != nil {
		return err
	}
	prefix := runtimeID + ".partial-"
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) {
			if err := root.RemoveAll(entry.Name()); err != nil {
				return err
			}
		}
	}
	return nil
}
