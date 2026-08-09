package main

import "strings"

type noopRuntimeLease struct {
	rootPath string
}

func AcquireRuntimeLease(rootPath string, manifest Manifest) (RuntimeLease, error) {
	digest, err := runtimeTreeDigestAt(rootPath)
	if err != nil {
		return nil, ErrPackageInvalid
	}
	if digest != strings.ToLower(manifest.RuntimeTreeSHA256) {
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
