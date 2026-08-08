package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type manifest struct {
	RuntimeID string `json:"runtimeId"`
	Archive   string `json:"archive"`
	SHA256    string `json:"sha256"`
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--fake-child-worker" {
		time.Sleep(60 * time.Second)
		return
	}
	candidate := "go"
	if strings.Contains(strings.ToLower(filepath.Base(os.Args[0])), "dotnet") {
		candidate = "dotnet"
	}
	maybeDelay(candidate)
	newline := "\n"
	if candidate == "dotnet" {
		newline = "\r\n"
	}
	if len(os.Args) != 3 || os.Args[1] != "--manifest" || os.Args[2] == "" {
		fail("E_ARGUMENTS", newline)
	}
	maybeSpawnChild()

	file, err := os.Open(os.Args[2])
	if err != nil {
		fail("E_MANIFEST_READ", newline)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var value manifest
	if decoder.Decode(&value) != nil || decoder.Decode(new(any)) != io.EOF {
		fail("E_MANIFEST_JSON", newline)
	}
	if !validArchive(value.Archive) || value.RuntimeID == "" || len(value.SHA256) != 64 {
		fail("E_MANIFEST_INVALID", newline)
	}
	payload, err := os.ReadFile(filepath.Join(filepath.Dir(os.Args[2]), value.Archive))
	if err != nil {
		fail("E_PACKAGE_INVALID", newline)
	}
	digest := sha256.Sum256(payload)
	if hex.EncodeToString(digest[:]) != value.SHA256 {
		fail("E_PACKAGE_INVALID", newline)
	}
	fmt.Fprintf(os.Stdout, "{\"status\":\"ready\",\"candidate\":\"%s\"}%s", candidate, newline)
}

func maybeDelay(candidate string) {
	root := os.Getenv("LAUNCHER_BENCHMARK_FAKE_TIMING_ROOT")
	if root == "" {
		return
	}
	counterPath := filepath.Join(root, candidate+".timing-count")
	invocation := 0
	if raw, err := os.ReadFile(counterPath); err == nil {
		invocation, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
	}
	invocation++
	if err := os.WriteFile(counterPath, []byte(strconv.Itoa(invocation)), 0o600); err != nil {
		return
	}
	time.Sleep(timingDelay(invocation))
}

func timingDelay(invocation int) time.Duration {
	samples := [...]time.Duration{
		0,
		0,
		0,
		300 * time.Millisecond,
		900 * time.Millisecond,
		900 * time.Millisecond,
		2 * time.Second,
	}
	if invocation < 10 || invocation > 16 {
		return 0
	}
	return samples[invocation-10]
}

func validArchive(value string) bool {
	if value == "" || filepath.IsAbs(value) || filepath.VolumeName(value) != "" {
		return false
	}
	cleaned := filepath.Clean(value)
	return cleaned != ".." && !strings.HasPrefix(cleaned, ".."+string(filepath.Separator))
}

func maybeSpawnChild() {
	counterPath := os.Getenv("LAUNCHER_BENCHMARK_FAKE_COUNTER")
	pidPath := os.Getenv("LAUNCHER_BENCHMARK_FAKE_CHILD_PID_FILE")
	if counterPath == "" || pidPath == "" {
		return
	}
	count := 0
	if raw, err := os.ReadFile(counterPath); err == nil {
		count, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
	}
	count++
	if err := os.WriteFile(counterPath, []byte(strconv.Itoa(count)), 0o600); err != nil || count != 19 {
		return
	}
	child := exec.Command(os.Args[0], "--fake-child-worker")
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if child.Start() == nil {
		_ = os.WriteFile(pidPath, []byte(strconv.Itoa(child.Process.Pid)), 0o600)
	}
}

func fail(code, newline string) {
	fmt.Fprint(os.Stderr, code, newline)
	os.Exit(1)
}
