package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
)

func secretSources(t *testing.T) (string, map[string]string) {
	t.Helper()
	sourceDir := t.TempDir()
	values := map[string]string{}
	for _, spec := range activationSecretSpecs {
		path := filepath.Join(sourceDir, spec.target)
		if err := os.WriteFile(path, []byte(strings.Repeat("x", 32)), 0o400); err != nil {
			t.Fatal(err)
		}
		values[spec.environment] = path
	}
	return sourceDir, values
}

func assertTargetDirectoryEmpty(t *testing.T, targetDir string) {
	t.Helper()
	entries, err := os.ReadDir(targetDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("partial targets remain: %v", entries)
	}
	info, err := os.Stat(targetDir)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("retry directory info=%v err=%v", info, err)
	}
}

func TestPrepareSecretsCopiesSafelyAndRewritesEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file metadata required")
	}
	sourceDir, targetDir := t.TempDir(), filepath.Join(t.TempDir(), "prepared")
	values := map[string]string{}
	for index, spec := range activationSecretSpecs {
		path := filepath.Join(sourceDir, spec.target)
		contents := []byte("runtime-" + strings.Repeat(string(rune('a'+index)), 32))
		if err := os.WriteFile(path, contents, 0o400); err != nil {
			t.Fatal(err)
		}
		values[spec.environment] = path
	}
	updated, err := prepareSecrets(func(name string) string { return values[name] }, targetDir, os.Getuid(), os.Getgid())
	if err != nil {
		t.Fatal(err)
	}
	for _, spec := range activationSecretSpecs {
		target := filepath.Join(targetDir, spec.target)
		if updated[spec.environment] != target {
			t.Fatalf("%s=%q", spec.environment, updated[spec.environment])
		}
		info, statErr := os.Lstat(target)
		if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o400 {
			t.Fatalf("target info=%v err=%v", info, statErr)
		}
		stat := info.Sys().(*syscall.Stat_t)
		if stat.Nlink != 1 || int(stat.Uid) != os.Getuid() || int(stat.Gid) != os.Getgid() {
			t.Fatalf("target metadata=%+v", stat)
		}
	}
	dirInfo, _ := os.Stat(targetDir)
	if dirInfo.Mode().Perm() != 0o700 {
		t.Fatalf("directory mode=%o", dirInfo.Mode().Perm())
	}
}

func TestPrepareSecretsAcceptsExistingTmpfsMountpoint(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file metadata required")
	}
	sourceDir, targetDir := t.TempDir(), filepath.Join(t.TempDir(), "prepared")
	if err := os.Mkdir(targetDir, 0o700); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{}
	for _, spec := range activationSecretSpecs {
		path := filepath.Join(sourceDir, spec.target)
		if err := os.WriteFile(path, []byte(strings.Repeat("x", 32)), 0o400); err != nil {
			t.Fatal(err)
		}
		values[spec.environment] = path
	}
	if _, err := prepareSecrets(func(name string) string { return values[name] }, targetDir, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareSecretsCleansPartialTargetsAndCanRetry(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file metadata required")
	}
	sourceDir, values := secretSources(t)
	targetDir := filepath.Join(t.TempDir(), "prepared")
	values[activationSecretSpecs[2].environment] = filepath.Join(sourceDir, "missing-sensitive-source")

	if _, err := prepareSecrets(func(name string) string { return values[name] }, targetDir, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("expected partial initialization failure")
	}
	assertTargetDirectoryEmpty(t, targetDir)

	fixed := filepath.Join(sourceDir, "fixed")
	if err := os.WriteFile(fixed, []byte(strings.Repeat("f", 32)), 0o400); err != nil {
		t.Fatal(err)
	}
	values[activationSecretSpecs[2].environment] = fixed
	if _, err := prepareSecrets(func(name string) string { return values[name] }, targetDir, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareSecretsCleansTargetsAfterDirectoryFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file metadata required")
	}
	for _, test := range []struct {
		name   string
		mutate func(*secretInitOps)
	}{
		{"chown", func(ops *secretInitOps) {
			ops.chownDirectory = func(*os.File, int, int) error { return errors.New("injected chown failure") }
		}},
		{"sync", func(ops *secretInitOps) {
			ops.syncDirectory = func(*os.File) error { return errors.New("injected sync failure") }
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, values := secretSources(t)
			targetDir := filepath.Join(t.TempDir(), "prepared")
			ops := defaultSecretInitOps()
			test.mutate(&ops)
			_, err := prepareSecretsWithOps(func(name string) string { return values[name] }, targetDir, os.Getuid(), os.Getgid(), ops)
			if err == nil || err.Error() != secretInitializationError {
				t.Fatalf("error=%v", err)
			}
			assertTargetDirectoryEmpty(t, targetDir)
		})
	}
}

func TestPrepareSecretsCleanupFailureDoesNotLeakDetails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file metadata required")
	}
	sourceDir, values := secretSources(t)
	targetDir := filepath.Join(t.TempDir(), "prepared")
	values[activationSecretSpecs[2].environment] = filepath.Join(sourceDir, "sensitive-source-path")
	ops := defaultSecretInitOps()
	removed := []string{}
	ops.removeTarget = func(_ *os.Root, name string) error {
		removed = append(removed, name)
		return errors.New("sensitive cleanup path")
	}

	_, err := prepareSecretsWithOps(func(name string) string { return values[name] }, targetDir, os.Getuid(), os.Getgid(), ops)
	if err == nil || err.Error() != secretInitializationError {
		t.Fatalf("error=%v", err)
	}
	want := []string{activationSecretSpecs[1].target, activationSecretSpecs[0].target}
	if strings.Join(removed, ",") != strings.Join(want, ",") {
		t.Fatalf("cleanup order=%v want=%v", removed, want)
	}
}

func TestPrepareSecretsDoesNotDeletePreexistingTarget(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file metadata required")
	}
	_, values := secretSources(t)
	targetDir := filepath.Join(t.TempDir(), "prepared")
	if err := os.Mkdir(targetDir, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(targetDir, activationSecretSpecs[0].target)
	contents := []byte("preexisting-sensitive-value")
	if err := os.WriteFile(target, contents, 0o400); err != nil {
		t.Fatal(err)
	}

	if _, err := prepareSecrets(func(name string) string { return values[name] }, targetDir, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("expected exclusive create failure")
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != string(contents) {
		t.Fatalf("preexisting target changed: contents=%q err=%v", got, err)
	}
}

func TestPrepareSecretsRejectsUnsafeSourcesWithoutLeakingDetails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix file metadata required")
	}
	for _, test := range []struct {
		name    string
		prepare func(string) (string, string)
	}{
		{"symlink", func(dir string) (string, string) {
			target := filepath.Join(dir, "target")
			_ = os.WriteFile(target, []byte(strings.Repeat("s", 32)), 0o400)
			link := filepath.Join(dir, "link")
			_ = os.Symlink(target, link)
			return link, target
		}},
		{"hardlink", func(dir string) (string, string) {
			target := filepath.Join(dir, "target")
			_ = os.WriteFile(target, []byte(strings.Repeat("h", 32)), 0o400)
			link := filepath.Join(dir, "link")
			_ = os.Link(target, link)
			return link, target
		}},
		{"world writable", func(dir string) (string, string) {
			target := filepath.Join(dir, "target")
			_ = os.WriteFile(target, []byte(strings.Repeat("w", 32)), 0o600)
			_ = os.Chmod(target, 0o622)
			return target, target
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			sourceDir := t.TempDir()
			unsafePath, sensitive := test.prepare(sourceDir)
			values := map[string]string{}
			for _, spec := range activationSecretSpecs {
				path := filepath.Join(sourceDir, spec.target+"-safe")
				_ = os.WriteFile(path, []byte(strings.Repeat("x", 32)), 0o400)
				values[spec.environment] = path
			}
			values[activationSecretSpecs[0].environment] = unsafePath
			_, err := prepareSecrets(func(name string) string { return values[name] }, filepath.Join(t.TempDir(), "prepared"), os.Getuid(), os.Getgid())
			if err == nil || strings.Contains(err.Error(), sensitive) || strings.Contains(err.Error(), strings.Repeat("w", 32)) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestDockerfileRunsSecretInitAsRootBeforeServer(t *testing.T) {
	contents, err := os.ReadFile("../../Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	source := string(contents)
	for _, required := range []string{"go build -trimpath -ldflags=\"-s -w\" -o /out/secret-init ./cmd/secret-init", "COPY --from=build /out/secret-init /secret-init", "ENTRYPOINT [\"/secret-init\"]", "CMD [\"/activation-server\"]"} {
		if !strings.Contains(source, required) {
			t.Errorf("Dockerfile missing %q", required)
		}
	}
	if strings.Contains(source, "USER 65532:65532") {
		t.Fatal("Dockerfile starts before root secret preparation")
	}
}

func TestProductionComposeGrantsOnlySecretPreparationCapabilities(t *testing.T) {
	contents, err := os.ReadFile("../../deploy/compose.production.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	compose := string(contents)
	for _, required := range []string{
		"/run/uclaw-secrets:size=1m,mode=0700,uid=0,gid=0",
		"cap_drop: [ALL]",
		"cap_add: [CHOWN, SETUID, SETGID]",
	} {
		if !strings.Contains(compose, required) {
			t.Errorf("production compose missing %q", required)
		}
	}
	anchorEnd := strings.Index(compose, "\nservices:")
	if anchorEnd < 0 {
		t.Fatal("production compose activation anchor missing")
	}
	if strings.Contains(compose[:anchorEnd], "\n  user:") {
		t.Fatal("activation service overrides root secret initializer user")
	}
}
