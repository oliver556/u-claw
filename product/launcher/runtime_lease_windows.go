package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

type windowsRuntimeLease struct {
	rootPath           string
	manifestEntrypoint string
	entrypointIdentity runtimeFileIdentity
	handles            []*os.File
	closeOnce          sync.Once
	closeErr           error
}

func AcquireRuntimeLease(rootPath string, manifest Manifest) (RuntimeLease, error) {
	rootPath = filepath.Clean(rootPath)
	if !filepath.IsAbs(rootPath) || !runtimeCacheUsable(rootPath, manifest) {
		if runtimeDirectoryAuditable(rootPath) {
			_, _ = runtimeFullAudit(rootPath)
		}
		return nil, ErrPackageInvalid
	}
	lease := &windowsRuntimeLease{rootPath: rootPath, manifestEntrypoint: manifest.Entrypoint}
	root, rootInformation, err := openRuntimeLeasePath(rootPath)
	if err != nil || !runtimeLeaseDirectoryValid(rootInformation) {
		if root != nil {
			_ = root.Close()
		}
		return nil, ErrPackageInvalid
	}
	lease.handles = append(lease.handles, root)

	entrypointFound := false
	for _, expected := range manifest.CriticalFiles {
		relative := strings.ReplaceAll(expected.Path, `\`, string(filepath.Separator))
		absolute := filepath.Join(rootPath, relative)
		child, information, err := openRuntimeLeasePath(absolute)
		if err != nil || !runtimeLeaseFileValid(information) {
			_ = lease.Close()
			return nil, ErrPackageInvalid
		}
		lease.handles = append(lease.handles, child)
		record, identity, err := hashRuntimeLeaseFile(child, filepath.ToSlash(relative), information)
		if err != nil || record.size != expected.Size || hex.EncodeToString(record.digest[:]) != strings.ToLower(expected.SHA256) {
			_ = lease.Close()
			return nil, ErrPackageInvalid
		}
		if runtimeLeaseEntrypointMatches(rootPath, manifest.Entrypoint, absolute, true) {
			lease.entrypointIdentity = identity
			entrypointFound = true
		}
	}
	if !entrypointFound {
		_ = lease.Close()
		return nil, ErrPackageInvalid
	}
	return lease, nil
}

func (lease *windowsRuntimeLease) RootPath() string {
	return lease.rootPath
}

func (lease *windowsRuntimeLease) VerifyEntrypoint(path string) error {
	if !runtimeLeaseEntrypointMatches(lease.rootPath, lease.manifestEntrypoint, path, true) {
		return ErrCachePreparationFailed
	}
	file, information, err := openRuntimeLeasePath(path)
	if err != nil {
		return ErrCachePreparationFailed
	}
	identity := runtimeFileIdentityFromInformation(information)
	valid := runtimeLeaseFileValid(information) && lease.entrypointIdentity.matches(identity)
	if closeErr := file.Close(); closeErr != nil || !valid {
		return ErrCachePreparationFailed
	}
	return nil
}

func (lease *windowsRuntimeLease) Close() error {
	lease.closeOnce.Do(func() {
		for index := len(lease.handles) - 1; index >= 0; index-- {
			if err := lease.handles[index].Close(); err != nil {
				lease.closeErr = ErrCachePreparationFailed
			}
		}
		lease.handles = nil
	})
	return lease.closeErr
}

func openRuntimeLeasePath(path string) (*os.File, syscall.ByHandleFileInformation, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, syscall.ByHandleFileInformation{}, err
	}
	handle, err := syscall.CreateFile(
		name,
		syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_OPEN_REPARSE_POINT|syscall.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return nil, syscall.ByHandleFileInformation{}, err
	}
	file := os.NewFile(uintptr(handle), path)
	if file == nil {
		_ = syscall.CloseHandle(handle)
		return nil, syscall.ByHandleFileInformation{}, syscall.EINVAL
	}
	var information syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &information); err != nil {
		_ = file.Close()
		return nil, syscall.ByHandleFileInformation{}, err
	}
	return file, information, nil
}

func runtimeLeaseDirectoryValid(information syscall.ByHandleFileInformation) bool {
	return information.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT == 0 &&
		information.FileAttributes&syscall.FILE_ATTRIBUTE_DIRECTORY != 0
}

func runtimeLeaseFileValid(information syscall.ByHandleFileInformation) bool {
	return information.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) == 0 &&
		information.NumberOfLinks == 1
}

func hashRuntimeLeaseFile(file *os.File, path string, before syscall.ByHandleFileInformation) (runtimeTreeFile, runtimeFileIdentity, error) {
	if !runtimeLeaseFileValid(before) {
		return runtimeTreeFile{}, runtimeFileIdentity{}, ErrPackageInvalid
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return runtimeTreeFile{}, runtimeFileIdentity{}, err
	}
	var after syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &after); err != nil {
		return runtimeTreeFile{}, runtimeFileIdentity{}, err
	}
	beforeIdentity := runtimeFileIdentityFromInformation(before)
	if !beforeIdentity.matches(runtimeFileIdentityFromInformation(after)) {
		return runtimeTreeFile{}, runtimeFileIdentity{}, ErrPackageInvalid
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return runtimeTreeFile{path: path, size: int64(beforeIdentity.fileSize), digest: digest}, beforeIdentity, nil
}

func runtimeFileIdentityFromInformation(information syscall.ByHandleFileInformation) runtimeFileIdentity {
	return runtimeFileIdentity{
		volumeSerialNumber: information.VolumeSerialNumber,
		fileIndexHigh:      information.FileIndexHigh,
		fileIndexLow:       information.FileIndexLow,
		fileSize:           uint64(information.FileSizeHigh)<<32 | uint64(information.FileSizeLow),
		lastWriteTime:      uint64(information.LastWriteTime.HighDateTime)<<32 | uint64(information.LastWriteTime.LowDateTime),
	}
}
