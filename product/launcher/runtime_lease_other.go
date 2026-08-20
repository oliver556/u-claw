//go:build !windows

package main

type noopRuntimeLease struct {
	rootPath string
}

func AcquireRuntimeLease(rootPath string, manifest Manifest) (RuntimeLease, error) {
	if !runtimeCacheUsable(rootPath, manifest) {
		if runtimeDirectoryAuditable(rootPath) {
			_, _ = runtimeFullAudit(rootPath)
		}
		return nil, ErrPackageInvalid
	}
	return &noopRuntimeLease{rootPath: rootPath}, nil
}

func (lease *noopRuntimeLease) RootPath() string {
	return lease.rootPath
}

func (*noopRuntimeLease) VerifyEntrypoint(string) error {
	return nil
}

func (*noopRuntimeLease) Close() error {
	return nil
}
