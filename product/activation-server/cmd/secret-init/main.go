package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

const serviceUID = 65532
const serviceGID = 65532

type secretSpec struct{ environment, target string }

var activationSecretSpecs = []secretSpec{
	{"ACTIVATION_PEPPER_FILE", "activation_pepper"}, {"LICENSE_SIGNING_KEY_FILE", "license_signing_key"}, {"STATUS_SIGNING_KEY_FILE", "status_signing_key"}, {"KMS_KEK_FILE", "kms_kek"}, {"TOKEN_SIGNING_KEY_FILE", "token_signing_key"}, {"ADMIN_OPERATORS_FILE", "admin_operators"}, {"ADMIN_SECRET_FINGERPRINT_KEY_FILE", "admin_secret_fingerprint_key"},
}

func main() {
	if os.Geteuid() != 0 {
		fatal()
	}
	environment, err := prepareSecrets(os.Getenv, "/run/uclaw-secrets", serviceUID, serviceGID)
	if err != nil {
		fatal()
	}
	if err = syscall.Setgroups([]int{}); err != nil {
		fatal()
	}
	if err = syscall.Setgid(serviceGID); err != nil {
		fatal()
	}
	if err = syscall.Setuid(serviceUID); err != nil {
		fatal()
	}
	arguments := os.Args[1:]
	if len(arguments) == 0 {
		arguments = []string{"/activation-server"}
	}
	executable, err := filepath.Abs(arguments[0])
	if err != nil {
		fatal()
	}
	env := os.Environ()
	for name, value := range environment {
		env = replaceEnvironment(env, name, value)
	}
	if err = syscall.Exec(executable, arguments, env); err != nil {
		fatal()
	}
}

func fatal() { _, _ = fmt.Fprintln(os.Stderr, "secret initialization failed"); os.Exit(1) }

func prepareSecrets(getenv func(string) string, targetDir string, uid, gid int) (map[string]string, error) {
	if getenv == nil || targetDir == "" {
		return nil, errors.New("secret initialization invalid")
	}
	if err := ensureTargetDirectory(targetDir); err != nil {
		return nil, errors.New("secret initialization invalid")
	}
	directoryFD, err := syscall.Open(targetDir, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("secret initialization invalid")
	}
	directory := os.NewFile(uintptr(directoryFD), targetDir)
	defer directory.Close()
	result := make(map[string]string, len(activationSecretSpecs))
	for _, spec := range activationSecretSpecs {
		target := filepath.Join(targetDir, spec.target)
		if err := copySecret(getenv(spec.environment), target, uid, gid); err != nil {
			return nil, err
		}
		result[spec.environment] = target
	}
	if err := directory.Chown(uid, gid); err != nil {
		return nil, errors.New("secret initialization invalid")
	}
	if err = directory.Sync(); err != nil {
		return nil, errors.New("secret initialization invalid")
	}
	return result, nil
}

func ensureTargetDirectory(path string) error {
	if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		return errors.New("secret initialization invalid")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() || int(stat.Gid) != os.Getegid() {
		return errors.New("secret initialization invalid")
	}
	return nil
}

func copySecret(source, target string, uid, gid int) error {
	if source == "" || !filepath.IsAbs(source) {
		return errors.New("secret initialization invalid")
	}
	sourceFD, err := syscall.Open(source, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return errors.New("secret initialization invalid")
	}
	sourceFile := os.NewFile(uintptr(sourceFD), source)
	defer sourceFile.Close()
	sourceInfo, err := sourceFile.Stat()
	if !safeSource(sourceInfo, err) {
		return errors.New("secret initialization invalid")
	}
	targetFD, err := syscall.Open(target, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o400)
	if err != nil {
		return errors.New("secret initialization invalid")
	}
	targetFile := os.NewFile(uintptr(targetFD), target)
	cleanup := func() { _ = targetFile.Close(); _ = os.Remove(target) }
	if err = targetFile.Chown(uid, gid); err != nil {
		cleanup()
		return errors.New("secret initialization invalid")
	}
	if _, err = io.Copy(targetFile, sourceFile); err != nil {
		cleanup()
		return errors.New("secret initialization invalid")
	}
	if err = targetFile.Sync(); err != nil {
		cleanup()
		return errors.New("secret initialization invalid")
	}
	targetInfo, err := targetFile.Stat()
	if err != nil || !targetInfo.Mode().IsRegular() || targetInfo.Mode().Perm() != 0o400 {
		cleanup()
		return errors.New("secret initialization invalid")
	}
	stat, ok := targetInfo.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 || int(stat.Uid) != uid || int(stat.Gid) != gid {
		cleanup()
		return errors.New("secret initialization invalid")
	}
	if err = targetFile.Close(); err != nil {
		_ = os.Remove(target)
		return errors.New("secret initialization invalid")
	}
	return nil
}

func safeSource(info os.FileInfo, err error) bool {
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}
func replaceEnvironment(values []string, name, value string) []string {
	prefix := name + "="
	for index, item := range values {
		if len(item) >= len(prefix) && item[:len(prefix)] == prefix {
			values[index] = prefix + value
			return values
		}
	}
	return append(values, prefix+value)
}
