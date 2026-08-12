package main

import (
	"errors"
	"os"
	"path/filepath"
)

type ActivationState string

const (
	ActivationRequired  ActivationState = "ACTIVATION_REQUIRED"
	LicenseLocalInvalid ActivationState = "LICENSE_LOCAL_INVALID"
	LicenseGateRequired ActivationState = "LICENSE_GATE_REQUIRED"
)

func DetectActivationState(packageRoot string) (ActivationState, error) {
	root, err := os.OpenRoot(packageRoot)
	if err != nil {
		return LicenseLocalInvalid, ErrLicenseFileUnsafe
	}
	defer root.Close()

	licenseDir, err := root.Lstat("license")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ActivationRequired, nil
		}
		return LicenseLocalInvalid, ErrLicenseFileUnsafe
	}
	if !licenseDir.IsDir() || licenseDir.Mode()&os.ModeSymlink != 0 {
		return LicenseLocalInvalid, ErrLicenseFileUnsafe
	}

	credentialExists, err := activationArtifactExists(root, startupCredentialFilename)
	if err != nil {
		return LicenseLocalInvalid, err
	}
	licenseExists, err := activationArtifactExists(root, licenseFilename)
	if err != nil {
		return LicenseLocalInvalid, err
	}
	if !credentialExists && !licenseExists {
		return ActivationRequired, nil
	}
	if credentialExists != licenseExists {
		return LicenseLocalInvalid, nil
	}
	return LicenseGateRequired, nil
}

func activationArtifactExists(root *os.Root, filename string) (bool, error) {
	_, err := root.Lstat(filepath.Join("license", filename))
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, ErrLicenseFileUnsafe
}
