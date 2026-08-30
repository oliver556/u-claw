package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var allowedRoots = map[string]bool{
	"app":                     true,
	"bootstrap":               true,
	"U-Claw.exe":              true,
	"U-Claw.app":              true,
	"U-Claw Launcher.exe":     true,
	"U-Claw Launcher.app":     true,
	"UCLAW-PACKAGE-NOTES.txt": true,
}

var forbiddenRoots = map[string]bool{
	"data":               true,
	".openclaw":          true,
	"openclaw.json":      true,
	"auth_profile_store": true,
	"auth-profile-store": true,
}

type Transaction struct {
	SchemaVersion int    `json:"schemaVersion"`
	ID            string `json:"id"`
	TargetVersion string `json:"targetVersion"`
	ReleaseID     string `json:"releaseId"`
	State         string `json:"state"`
	StagingDir    string `json:"stagingDir"`
	BackupDir     string `json:"backupDir"`
	UpdatedAt     string `json:"updatedAt"`
	Error         any    `json:"error"`
}

type RunState struct {
	SchemaVersion   int    `json:"schemaVersion"`
	LauncherPID     int    `json:"launcherPid"`
	AppPID          int    `json:"appPid"`
	GatewayPID      int    `json:"gatewayPid"`
	ConfigServerPID int    `json:"configServerPid"`
	VideoAdapterPID int    `json:"videoAdapterPid"`
	StampFile       string `json:"stampFile"`
}

func usage() {
	fmt.Fprintf(os.Stderr, "Usage: uclaw-updater --root <U-Claw root> --transaction <app/update-transaction.json> [--dry-run]\n")
}

func main() {
	root := flag.String("root", "", "U-Claw root")
	transactionPath := flag.String("transaction", "", "update transaction path")
	dryRun := flag.Bool("dry-run", false, "validate only")
	flag.Usage = usage
	flag.Parse()
	if *root == "" || *transactionPath == "" {
		usage()
		os.Exit(2)
	}
	if err := Run(*root, *transactionPath, *dryRun); err != nil {
		fmt.Fprintf(os.Stderr, "uclaw-updater: %v\n", err)
		os.Exit(1)
	}
}

func Run(root string, transactionPath string, dryRun bool) error {
	resolvedRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	tx, err := readTransaction(transactionPath)
	if err != nil {
		return err
	}
	staging, err := safeJoin(resolvedRoot, tx.StagingDir)
	if err != nil {
		return err
	}
	if err := validateStaging(staging); err != nil {
		return err
	}
	if dryRun {
		return nil
	}
	runStatePath := filepath.Join(resolvedRoot, "app", ".runtime", "run-state.json")
	_ = terminateRecordedPIDs(runStatePath)
	if err := replaceProgramLayer(resolvedRoot, staging); err != nil {
		_ = writeTransactionState(transactionPath, tx, "failed", err.Error())
		return err
	}
	if err := invalidateCacheStamp(runStatePath); err != nil {
		return err
	}
	if err := writeVersion(resolvedRoot, tx); err != nil {
		return err
	}
	return writeTransactionState(transactionPath, tx, "complete", "")
}

func readTransaction(filePath string) (Transaction, error) {
	var tx Transaction
	bytes, err := os.ReadFile(filePath)
	if err != nil {
		return tx, err
	}
	if err := json.Unmarshal(bytes, &tx); err != nil {
		return tx, err
	}
	if tx.SchemaVersion != 1 {
		return tx, fmt.Errorf("unsupported transaction schemaVersion %d", tx.SchemaVersion)
	}
	if tx.StagingDir == "" {
		return tx, errors.New("transaction stagingDir missing")
	}
	return tx, nil
}

func safeJoin(root string, relative string) (string, error) {
	if filepath.IsAbs(relative) {
		return "", fmt.Errorf("absolute transaction path rejected: %s", relative)
	}
	clean := filepath.Clean(relative)
	if clean == "." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == ".." {
		return "", fmt.Errorf("path traversal rejected: %s", relative)
	}
	joined := filepath.Join(root, clean)
	resolvedRoot, _ := filepath.Abs(root)
	resolvedJoined, _ := filepath.Abs(joined)
	if resolvedJoined != resolvedRoot && !strings.HasPrefix(resolvedJoined, resolvedRoot+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes root: %s", relative)
	}
	return joined, nil
}

func validateStaging(staging string) error {
	entries, err := os.ReadDir(staging)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if forbiddenRoots[name] {
			return fmt.Errorf("forbidden root in staging: %s", name)
		}
		if !allowedRoots[name] {
			return fmt.Errorf("unexpected root in staging: %s", name)
		}
	}
	return filepath.WalkDir(staging, func(filePath string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(staging, filePath)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		for _, part := range parts {
			if part == ".." || forbiddenRoots[part] || strings.EqualFold(part, "openclaw.json") {
				return fmt.Errorf("forbidden path in staging: %s", rel)
			}
			lower := strings.ToLower(part)
			if strings.HasSuffix(lower, ".env") || strings.Contains(lower, ".env.") || strings.HasSuffix(lower, ".key") {
				return fmt.Errorf("forbidden secret-like file in staging: %s", rel)
			}
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink rejected: %s", rel)
		}
		if !entry.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("non-regular file rejected: %s", rel)
		}
		return nil
	})
}

func replaceProgramLayer(root string, staging string) error {
	entries, err := os.ReadDir(staging)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if forbiddenRoots[name] || !allowedRoots[name] {
			return fmt.Errorf("refusing to replace %s", name)
		}
		src := filepath.Join(staging, name)
		dst := filepath.Join(root, name)
		if name == "app" {
			if err := replaceAppSubtree(dst, src); err != nil {
				return err
			}
			continue
		}
		if err := os.RemoveAll(dst); err != nil {
			return err
		}
		if err := copyAny(src, dst); err != nil {
			return err
		}
	}
	return nil
}

func replaceAppSubtree(destinationApp string, sourceApp string) error {
	entries, err := os.ReadDir(sourceApp)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(destinationApp, 0755); err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".update-") || name == ".runtime" {
			return fmt.Errorf("refusing runtime app subtree: app/%s", name)
		}
		src := filepath.Join(sourceApp, name)
		dst := filepath.Join(destinationApp, name)
		if err := os.RemoveAll(dst); err != nil {
			return err
		}
		if err := copyAny(src, dst); err != nil {
			return err
		}
	}
	return nil
}

func copyAny(src string, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("symlink rejected: %s", src)
	}
	if info.IsDir() {
		return copyDir(src, dst)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("non-regular file rejected: %s", src)
	}
	return copyFile(src, dst, info.Mode())
}

func copyDir(src string, dst string) error {
	return filepath.WalkDir(src, func(filePath string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, filePath)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink rejected: %s", filePath)
		}
		if entry.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		return copyFile(filePath, target, info.Mode())
	})
}

func copyFile(src string, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func terminateRecordedPIDs(runStatePath string) error {
	bytes, err := os.ReadFile(runStatePath)
	if err != nil {
		return nil
	}
	var state RunState
	if err := json.Unmarshal(bytes, &state); err != nil {
		return err
	}
	for _, pid := range []int{state.AppPID, state.GatewayPID, state.ConfigServerPID, state.VideoAdapterPID} {
		if pid <= 0 || pid == os.Getpid() {
			continue
		}
		_ = signalPID(pid)
	}
	return nil
}

func signalPID(pid int) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return process.Kill()
	}
	return process.Signal(os.Interrupt)
}

func invalidateCacheStamp(runStatePath string) error {
	bytes, err := os.ReadFile(runStatePath)
	if err != nil {
		return nil
	}
	var state RunState
	if err := json.Unmarshal(bytes, &state); err != nil {
		return err
	}
	if state.StampFile == "" {
		return nil
	}
	err = os.Remove(state.StampFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func writeVersion(root string, tx Transaction) error {
	payload := map[string]any{
		"schemaVersion": 1,
		"version":       tx.TargetVersion,
		"releaseId":     tx.ReleaseID,
		"installedAt":   time.Now().UTC().Format(time.RFC3339),
	}
	return writeJSON(filepath.Join(root, "app", "version.json"), payload)
}

func writeTransactionState(filePath string, tx Transaction, state string, message string) error {
	tx.State = state
	tx.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if message != "" {
		tx.Error = message
	} else {
		tx.Error = nil
	}
	return writeJSON(filePath, tx)
}

func writeJSON(filePath string, value any) error {
	if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		return err
	}
	bytes, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	bytes = append(bytes, '\n')
	tmp := filePath + ".tmp"
	if err := os.WriteFile(tmp, bytes, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, filePath)
}
