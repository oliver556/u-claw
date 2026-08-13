package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
)

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
