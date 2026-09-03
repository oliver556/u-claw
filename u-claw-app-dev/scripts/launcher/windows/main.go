package main

import (
	"crypto/sha256"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	mbOK                      = 0x00000000
	mbIconError               = 0x00000010
	errorAlreadyExists        = 183
	activationRestartExitCode = 20
	detachedProcess           = 0x00000008
	createNewProcessGroup     = 0x00000200
	rootWindowsUpdaterName    = "Bavi-box Win Update.exe"
)

var (
	user32           = syscall.NewLazyDLL("user32.dll")
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	procMessageBoxW  = user32.NewProc("MessageBoxW")
	procCreateMutexW = kernel32.NewProc("CreateMutexW")
	procCloseHandle  = kernel32.NewProc("CloseHandle")
	procAllocConsole = kernel32.NewProc("AllocConsole")

	logPath         string
	startLogPath    string
	usbLogPath      string
	usbStartLogPath string
	consoleIn       *os.File
	consoleOut      *os.File
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	root := filepath.Dir(executable)
	script := filepath.Join(root, "app", "scripts", "Windows-Start-App.bat")
	hostLocalAppData := os.Getenv("LOCALAPPDATA")
	if hostLocalAppData == "" {
		hostLocalAppData = os.TempDir()
	}
	localLogDir := filepath.Join(hostLocalAppData, "Bavi-box", "launcher-logs")
	logPath = filepath.Join(localLogDir, "Bavi-box-Launcher.log")
	startLogPath = filepath.Join(localLogDir, "Windows-Start-App.log")
	usbLogPath = filepath.Join(root, "data", "logs", "Bavi-box-Launcher.log")
	usbStartLogPath = filepath.Join(root, "data", "logs", "Windows-Start-App.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0755)
	appendLauncherLog("Launcher process entered. root=" + root)
	syncLauncherLogs()
	if _, err := os.Stat(script); err != nil {
		appendLauncherLog("Missing Windows start script: " + script + " (" + err.Error() + ")")
		syncLauncherLogs()
		showStartupError()
		os.Exit(1)
	}
	syncRootWindowsUpdater(root)
	syncLauncherLogs()

	mutex, alreadyRunning := acquireSingleInstanceMutex(root)
	if alreadyRunning {
		appendLauncherLog("Another launcher instance is already running; queued relaunch request.")
		writeRelaunchRequest(root)
		syncLauncherLogs()
		os.Exit(0)
	}
	if mutex != 0 {
		defer procCloseHandle.Call(mutex)
	}
	if !openLauncherConsole() {
		appendLauncherLog("Failed to allocate startup console.")
		syncLauncherLogs()
		showStartupError()
		os.Exit(1)
	}
	defer consoleIn.Close()
	defer consoleOut.Close()
	fmt.Fprintln(consoleOut, "[Bavi-box] Launcher started; loading startup script...")

	exitCode := 0
	for {
		clearRelaunchRequest(root)
		appendLauncherLog("Launcher run started.")
		exitCode = runScript(root, script, startLogPath)
		syncLauncherLogs()
		if exitCode == activationRestartExitCode {
			appendLauncherLog("Activation completed; restarting through normal startup gate.")
			syncLauncherLogs()
			continue
		}
		if exitCode != 0 {
			break
		}
		if !hasFreshRelaunchRequest(root, 2*time.Minute) {
			break
		}
		appendLauncherLog("Relaunch requested while Bavi-box was closing; starting again.")
		syncLauncherLogs()
	}

	if exitCode == 0 {
		if err := launchPreparedApp(root); err != nil {
			appendLauncherLog("Failed to launch prepared app: " + err.Error())
			syncLauncherLogs()
			showStartupError()
			os.Exit(1)
		}
		syncLauncherLogs()
	}

	os.Exit(exitCode)
}

func acquireSingleInstanceMutex(root string) (uintptr, bool) {
	name := syscall.StringToUTF16Ptr("Local\\UClawPortableLauncher-" + stableRootID(root))
	handle, _, callErr := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		appendLauncherLog("CreateMutex failed: " + callErr.Error())
		return 0, false
	}
	return handle, callErr == syscall.Errno(errorAlreadyExists)
}

func stableRootID(root string) string {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(strings.ToLower(filepath.Clean(root))))
	return fmt.Sprintf("%016x", hash.Sum64())
}

func relaunchRequestPath(root string) string {
	return filepath.Join(root, "data", ".uclaw-launcher", "relaunch.request")
}

func writeRelaunchRequest(root string) {
	requestPath := relaunchRequestPath(root)
	_ = os.MkdirAll(filepath.Dir(requestPath), 0755)
	_ = os.WriteFile(requestPath, []byte(time.Now().Format(time.RFC3339Nano)), 0644)
}

func clearRelaunchRequest(root string) {
	_ = os.Remove(relaunchRequestPath(root))
}

func hasFreshRelaunchRequest(root string, maxAge time.Duration) bool {
	info, err := os.Stat(relaunchRequestPath(root))
	if err != nil {
		return false
	}
	if time.Since(info.ModTime()) > maxAge {
		clearRelaunchRequest(root)
		return false
	}
	clearRelaunchRequest(root)
	return true
}

func launchEnvPath(root string) string {
	return filepath.Join(root, "app", ".runtime", "windows-app-launch.env")
}

func parseLaunchEnv(root string) (map[string]string, error) {
	bytes, err := os.ReadFile(launchEnvPath(root))
	if err != nil {
		return nil, err
	}
	env := map[string]string{}
	for _, line := range strings.Split(string(bytes), "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		index := strings.Index(line, "=")
		if index <= 0 {
			continue
		}
		env[line[:index]] = line[index+1:]
	}
	return env, nil
}

func mergedEnv(extra map[string]string) []string {
	env := map[string]string{}
	for _, item := range os.Environ() {
		index := strings.Index(item, "=")
		if index <= 0 {
			continue
		}
		env[item[:index]] = item[index+1:]
	}
	for key, value := range extra {
		env[key] = value
	}
	result := make([]string, 0, len(env))
	for key, value := range env {
		result = append(result, key+"="+value)
	}
	return result
}

func launchPreparedApp(root string) error {
	env, err := parseLaunchEnv(root)
	if err != nil {
		return fmt.Errorf("read launch env: %w", err)
	}
	appBin := strings.TrimSpace(env["APP_BIN"])
	if appBin == "" && strings.TrimSpace(env["UCLAW_APP_CACHE_DIR"]) != "" {
		appBin = filepath.Join(strings.TrimSpace(env["UCLAW_APP_CACHE_DIR"]), "Bavi-box.exe")
	}
	if appBin == "" {
		return fmt.Errorf("APP_BIN missing in %s", launchEnvPath(root))
	}
	if _, err := os.Stat(appBin); err != nil {
		return fmt.Errorf("app binary unavailable %s: %w", appBin, err)
	}
	appendLauncherLog("Launching prepared app detached: " + appBin)
	cmd := exec.Command(appBin)
	cmd.Dir = filepath.Dir(appBin)
	cmd.Env = mergedEnv(env)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: detachedProcess | createNewProcessGroup,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	appendLauncherLog(fmt.Sprintf("Prepared app process started: %d", cmd.Process.Pid))
	return cmd.Process.Release()
}

func syncRootWindowsUpdater(root string) {
	source := filepath.Join(root, "app", "update-runtime", rootWindowsUpdaterName)
	destination := filepath.Join(root, rootWindowsUpdaterName)
	if _, err := os.Stat(source); err != nil {
		return
	}
	same, err := sameFileContents(source, destination)
	if err == nil && same {
		return
	}
	temporary := fmt.Sprintf("%s.tmp-%d", destination, os.Getpid())
	if err := copyFile(source, temporary, 0755); err != nil {
		appendLauncherLog("Root updater sync skipped: copy failed: " + err.Error())
		return
	}
	if err := os.Remove(destination); err != nil && !os.IsNotExist(err) {
		_ = os.Remove(temporary)
		appendLauncherLog("Root updater sync skipped: destination locked: " + err.Error())
		return
	}
	if err := os.Rename(temporary, destination); err != nil {
		_ = os.Remove(temporary)
		appendLauncherLog("Root updater sync skipped: rename failed: " + err.Error())
		return
	}
	appendLauncherLog("Root Windows updater synchronized from app/update-runtime.")
}

func sameFileContents(left string, right string) (bool, error) {
	leftInfo, err := os.Stat(left)
	if err != nil {
		return false, err
	}
	rightInfo, err := os.Stat(right)
	if err != nil {
		return false, err
	}
	if leftInfo.Size() != rightInfo.Size() {
		return false, nil
	}
	leftHash, err := sha256File(left)
	if err != nil {
		return false, err
	}
	rightHash, err := sha256File(right)
	if err != nil {
		return false, err
	}
	return leftHash == rightHash, nil
}

func sha256File(filePath string) ([32]byte, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return [32]byte{}, err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return [32]byte{}, err
	}
	var sum [32]byte
	copy(sum[:], hash.Sum(nil))
	return sum, nil
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

func appendLauncherLog(message string) {
	if logPath == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(logPath), 0755)
	line := "[" + time.Now().Format(time.RFC3339Nano) + "] [Bavi-box] " + message + "\r\n"
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(line)
}

func copyFileBestEffort(source string, destination string) {
	if source == "" || destination == "" {
		return
	}
	in, err := os.Open(source)
	if err != nil {
		return
	}
	defer in.Close()
	_ = os.MkdirAll(filepath.Dir(destination), 0755)
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return
	}
	defer out.Close()
	_, _ = io.Copy(out, in)
}

func syncLauncherLogs() {
	copyFileBestEffort(logPath, usbLogPath)
	if startLogPath != usbLogPath {
		copyFileBestEffort(startLogPath, usbStartLogPath)
	}
}

func showStartupError() {
	message := syscall.StringToUTF16Ptr("Bavi-box 启动失败。请查看 Bavi-box\\data\\logs\\Bavi-box-Launcher.log。")
	title := syscall.StringToUTF16Ptr("Bavi-box")
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), mbOK|mbIconError)
}

func openLauncherConsole() bool {
	if result, _, _ := procAllocConsole.Call(); result == 0 {
		return false
	}
	var err error
	consoleIn, err = os.OpenFile("CONIN$", os.O_RDONLY, 0)
	if err != nil {
		return false
	}
	consoleOut, err = os.OpenFile("CONOUT$", os.O_WRONLY, 0)
	if err != nil {
		consoleIn.Close()
		return false
	}
	return true
}

func runScript(root string, script string, logPath string) int {
	logFile, _ := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if logFile != nil {
		defer logFile.Close()
	}

	cmd := exec.Command("cmd.exe", "/c", script)
	cmd.Dir = os.TempDir()
	cmd.Stdin = consoleIn
	cmd.Stdout = io.MultiWriter(consoleOut, logFile)
	cmd.Stderr = io.MultiWriter(consoleOut, logFile)
	cmd.Env = append(os.Environ(),
		"UCLAW_LAUNCHER_GUI=1",
		"UCLAW_PREPARE_ONLY=1",
		fmt.Sprintf("UCLAW_LAUNCHER_PID=%d", os.Getpid()),
		"UCLAW_PORTABLE_ROOT="+root,
		"UCLAW_LAUNCHER_LOCAL_LOG="+logPath,
		"UCLAW_WINDOWS_START_LOCAL_LOG="+startLogPath,
		"UCLAW_USB_LAUNCHER_LOG="+usbLogPath,
		"UCLAW_USB_WINDOWS_START_LOG="+usbStartLogPath,
	)
	if err := cmd.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			return exitError.ExitCode()
		}
		return 1
	}
	return 0
}
