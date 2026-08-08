package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

const cacheMarkerName = ".uclaw-runtime.json"

var ErrCachePreparationFailed = errors.New("runtime cache preparation failed")

type CacheResult struct {
	Path   string
	Reused bool
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
	if err := ValidatePackage(packageRoot, manifest); err != nil {
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

	packageDirectory, err := os.OpenRoot(packageRoot)
	if err != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	archivePath := strings.ReplaceAll(manifest.RuntimeArchive, `\`, string(os.PathSeparator))
	archive, err := packageDirectory.Open(archivePath)
	if err != nil {
		packageDirectory.Close()
		return CacheResult{}, ErrCachePreparationFailed
	}
	extractErr := ExtractRuntime(ctx, archive, temporaryPath, manifest)
	closeArchiveErr := archive.Close()
	closePackageErr := packageDirectory.Close()
	if extractErr != nil {
		return CacheResult{}, extractErr
	}
	if closeArchiveErr != nil || closePackageErr != nil {
		return CacheResult{}, ErrCachePreparationFailed
	}
	if !runtimeEntrypointUsable(temporaryPath, manifest.Entrypoint) {
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

func runtimeCacheUsable(cachePath string, manifest Manifest) bool {
	marker, err := ReadManifest(filepath.Join(cachePath, cacheMarkerName))
	if err != nil || !reflect.DeepEqual(marker, manifest) {
		return false
	}
	return runtimeEntrypointUsable(cachePath, manifest.Entrypoint)
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
