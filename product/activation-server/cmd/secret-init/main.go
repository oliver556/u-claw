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
const secretInitializationError = "secret initialization invalid"

type secretSpec struct{ environment, target string }

type secretInitOps struct {
	chownDirectory func(*os.File, int, int) error
	syncDirectory  func(*os.File) error
	removeTarget   func(*os.Root, string) error
}

var activationSecretSpecs = []secretSpec{
	{"ACTIVATION_PEPPER_FILE", "activation_pepper"}, {"LICENSE_SIGNING_KEY_FILE", "license_signing_key"}, {"STATUS_SIGNING_KEY_FILE", "status_signing_key"}, {"KMS_KEK_FILE", "kms_kek"}, {"ADMIN_OPERATORS_FILE", "admin_operators"}, {"ADMIN_SECRET_FINGERPRINT_KEY_FILE", "admin_secret_fingerprint_key"},
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
	return prepareSecretsWithOps(getenv, targetDir, uid, gid, defaultSecretInitOps())
}

func defaultSecretInitOps() secretInitOps {
	return secretInitOps{
		chownDirectory: func(directory *os.File, uid, gid int) error { return directory.Chown(uid, gid) },
		syncDirectory:  func(directory *os.File) error { return directory.Sync() },
		removeTarget:   func(root *os.Root, name string) error { return root.Remove(name) },
	}
}

func prepareSecretsWithOps(getenv func(string) string, targetDir string, uid, gid int, ops secretInitOps) (map[string]string, error) {
	if getenv == nil || targetDir == "" {
		return nil, initializationError()
	}
	if err := ensureTargetDirectory(targetDir); err != nil {
		return nil, initializationError()
	}
	directoryFD, err := syscall.Open(targetDir, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, initializationError()
	}
	directory := os.NewFile(uintptr(directoryFD), targetDir)
	defer directory.Close()
	targetRoot, err := os.OpenRoot(targetDir)
	if err != nil {
		return nil, initializationError()
	}
	defer targetRoot.Close()
	created := make([]string, 0, len(activationSecretSpecs))
	cleanup := func() {
		for index := len(created) - 1; index >= 0; index-- {
			_ = ops.removeTarget(targetRoot, created[index])
		}
		_ = ops.syncDirectory(directory)
	}
	fail := func() (map[string]string, error) {
		cleanup()
		return nil, initializationError()
	}
	result := make(map[string]string, len(activationSecretSpecs))
	for _, spec := range activationSecretSpecs {
		target := filepath.Join(targetDir, spec.target)
		wasCreated, copyErr := copySecret(getenv(spec.environment), target, uid, gid)
		if wasCreated {
			created = append(created, spec.target)
		}
		if copyErr != nil {
			return fail()
		}
		result[spec.environment] = target
	}
	if err = ops.syncDirectory(directory); err != nil {
		return fail()
	}
	if err = ops.chownDirectory(directory, uid, gid); err != nil {
		return fail()
	}
	return result, nil
}

func initializationError() error { return errors.New(secretInitializationError) }

func ensureTargetDirectory(path string) error {
	if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
		return initializationError()
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Geteuid() || int(stat.Gid) != os.Getegid() {
		return initializationError()
	}
	return nil
}

func copySecret(source, target string, uid, gid int) (bool, error) {
	if source == "" || !filepath.IsAbs(source) {
		return false, initializationError()
	}
	sourceFD, err := syscall.Open(source, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return false, initializationError()
	}
	sourceFile := os.NewFile(uintptr(sourceFD), source)
	defer sourceFile.Close()
	sourceInfo, err := sourceFile.Stat()
	if !safeSource(sourceInfo, err) {
		return false, initializationError()
	}
	targetFD, err := syscall.Open(target, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o400)
	if err != nil {
		return false, initializationError()
	}
	targetFile := os.NewFile(uintptr(targetFD), target)
	closeTarget := func() { _ = targetFile.Close() }
	if err = targetFile.Chmod(0o400); err != nil {
		closeTarget()
		return true, initializationError()
	}
	if err = targetFile.Chown(uid, gid); err != nil {
		closeTarget()
		return true, initializationError()
	}
	if _, err = io.Copy(targetFile, sourceFile); err != nil {
		closeTarget()
		return true, initializationError()
	}
	if err = targetFile.Sync(); err != nil {
		closeTarget()
		return true, initializationError()
	}
	targetInfo, err := targetFile.Stat()
	if err != nil || !targetInfo.Mode().IsRegular() || targetInfo.Mode().Perm() != 0o400 {
		closeTarget()
		return true, initializationError()
	}
	stat, ok := targetInfo.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 1 || int(stat.Uid) != uid || int(stat.Gid) != gid {
		closeTarget()
		return true, initializationError()
	}
	if err = targetFile.Close(); err != nil {
		return true, initializationError()
	}
	return true, nil
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
