package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

var defaultProductionURL = "https://oss-download.yiyong.me/bavi-box/releases/production.json"

func main() {
	root := portableRoot()
	runtimeArchive := filepath.Join(root, "app", "update-runtime", "node-win32-x64.zip")
	clientSource := filepath.Join(root, "app", "scripts", "hard-update-client.js")
	clientLibSource := filepath.Join(root, "app", "scripts", "lib")
	launchAfter := filepath.Join(root, "Bavi-box.exe")

	fmt.Println("[Bavi-box] USB root: " + root)
	fmt.Println("[Bavi-box] Checking updater runtime...")

	if !isFile(runtimeArchive) {
		fail("Missing updater Node runtime:\n" + runtimeArchive)
	}
	if !isFile(clientSource) {
		fail("Missing updater client:\n" + clientSource)
	}
	if !isDir(clientLibSource) {
		fail("Missing updater client lib:\n" + clientLibSource)
	}

	node, client, err := prepareLocalUpdater(runtimeArchive, clientSource, clientLibSource)
	if err != nil {
		fail("Failed to prepare local updater: " + err.Error())
	}

	fmt.Println("[Bavi-box] Starting independent update...")
	productionURL := strings.TrimSpace(os.Getenv("UCLAW_UPDATE_PRODUCTION_URL"))
	if productionURL == "" {
		productionURL = defaultProductionURL
	}
	cmd := exec.Command(node, client, "independent-update", "--usb", root, "--platform", "win32-x64", "--production-url", productionURL, "--launch-after", launchAfter)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.Dir = root
	if err := cmd.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			fmt.Printf("[Bavi-box] Update failed with status %d.\n", exitError.ExitCode())
			pause()
			os.Exit(exitError.ExitCode())
		}
		fail("Update failed: " + err.Error())
	}

	fmt.Println("[Bavi-box] Update finished.")
	pause()
}

func portableRoot() string {
	if value := strings.TrimSpace(os.Getenv("UCLAW_PORTABLE_ROOT")); value != "" {
		if abs, err := filepath.Abs(value); err == nil {
			return abs
		}
		return value
	}
	executable, err := os.Executable()
	if err != nil {
		fail(err.Error())
	}
	root := filepath.Dir(executable)
	if !isDir(filepath.Join(root, "app")) && isDir(filepath.Join(root, "..", "app")) {
		root = filepath.Join(root, "..")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return root
	}
	return abs
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func prepareLocalUpdater(runtimeArchive string, clientSource string, clientLibSource string) (string, string, error) {
	cacheRoot, err := os.UserCacheDir()
	if err != nil || cacheRoot == "" {
		cacheRoot = os.TempDir()
	}
	destination := filepath.Join(cacheRoot, "Bavi-box", "updater")
	temporary := destination + ".tmp"
	_ = os.RemoveAll(temporary)
	if err := extractWindowsRuntime(runtimeArchive, filepath.Join(temporary, "node")); err != nil {
		_ = os.RemoveAll(temporary)
		return "", "", err
	}
	if err := os.MkdirAll(filepath.Join(temporary, "client"), 0755); err != nil {
		_ = os.RemoveAll(temporary)
		return "", "", err
	}
	if err := copyFile(clientSource, filepath.Join(temporary, "client", "hard-update-client.js"), 0644); err != nil {
		_ = os.RemoveAll(temporary)
		return "", "", err
	}
	if err := copyDir(clientLibSource, filepath.Join(temporary, "client", "lib")); err != nil {
		_ = os.RemoveAll(temporary)
		return "", "", err
	}
	_ = os.RemoveAll(destination)
	if err := os.Rename(temporary, destination); err != nil {
		_ = os.RemoveAll(destination)
		if err := copyDir(temporary, destination); err != nil {
			return "", "", err
		}
		_ = os.RemoveAll(temporary)
	}
	return filepath.Join(destination, "node", "node.exe"), filepath.Join(destination, "client", "hard-update-client.js"), nil
}

func extractWindowsRuntime(archive string, destination string) error {
	if err := os.MkdirAll(destination, 0755); err != nil {
		return err
	}
	if err := exec.Command("tar.exe", "-xf", archive, "-C", destination).Run(); err == nil {
		return nil
	}
	powershell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if powershell == "" || !isFile(powershell) {
		powershell = "powershell.exe"
	}
	command := "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:UCLAW_RUNTIME_ARCHIVE -DestinationPath $env:UCLAW_RUNTIME_DEST -Force"
	cmd := exec.Command(powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command)
	cmd.Env = append(os.Environ(),
		"UCLAW_RUNTIME_ARCHIVE="+archive,
		"UCLAW_RUNTIME_DEST="+destination,
	)
	return cmd.Run()
}

func copyDir(source string, destination string) error {
	return filepath.Walk(source, func(current string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, relative)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		return copyFile(current, target, info.Mode())
	})
}

func copyFile(source string, destination string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
		return err
	}
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer output.Close()
	_, err = io.Copy(output, input)
	return err
}

func fail(message string) {
	fmt.Println("[Bavi-box] " + message)
	pause()
	os.Exit(1)
}

func pause() {
	if runtime.GOOS != "windows" {
		return
	}
	fmt.Print("按回车退出...")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}
