package main

import (
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	cwUseDefault       = ^uintptr(0x7fffffff)
	csHRedraw          = 0x0002
	csVRedraw          = 0x0001
	wsOverlappedWindow = 0x00cf0000
	wsVisible          = 0x10000000
	wsChild            = 0x40000000
	wsVScroll          = 0x00200000
	ssLeft             = 0x00000000
	wmClose            = 0x0010
	wmDestroy          = 0x0002
	wmTimer            = 0x0113
	swHide             = 0
	swShow             = 5
	mbOK               = 0x00000000
	mbIconError        = 0x00000010
	errorAlreadyExists = 183
	errorClassExists   = 1410
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	procRegisterClassExW = user32.NewProc("RegisterClassExW")
	procCreateWindowExW  = user32.NewProc("CreateWindowExW")
	procDefWindowProcW   = user32.NewProc("DefWindowProcW")
	procShowWindow       = user32.NewProc("ShowWindow")
	procUpdateWindow     = user32.NewProc("UpdateWindow")
	procGetMessageW      = user32.NewProc("GetMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessageW = user32.NewProc("DispatchMessageW")
	procPostQuitMessage  = user32.NewProc("PostQuitMessage")
	procSetWindowTextW   = user32.NewProc("SetWindowTextW")
	procSetTimer         = user32.NewProc("SetTimer")
	procKillTimer        = user32.NewProc("KillTimer")
	procMessageBoxW      = user32.NewProc("MessageBoxW")
	procCreateMutexW     = kernel32.NewProc("CreateMutexW")
	procCloseHandle      = kernel32.NewProc("CloseHandle")
	procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")

	windowHandle        uintptr
	textHandle          uintptr
	logPath             string
	startLogPath        string
	usbLogPath          string
	usbStartLogPath     string
	mainLogPath         string
	processDone         int32
	processExitCode     int32
	windowHidden        int32
	logStartOffset      int64
	startLogStartOffset int64
	launcherStarted     = time.Now()
)

type wndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   syscall.Handle
	icon       syscall.Handle
	cursor     syscall.Handle
	background syscall.Handle
	menuName   *uint16
	className  *uint16
	iconSm     syscall.Handle
}

type point struct {
	x int32
	y int32
}

type msg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	root := filepath.Dir(executable)
	script := filepath.Join(root, "Windows-Start-App.bat")
	hostLocalAppData := os.Getenv("LOCALAPPDATA")
	if hostLocalAppData == "" {
		hostLocalAppData = os.TempDir()
	}
	localLogDir := filepath.Join(hostLocalAppData, "U-Claw", "launcher-logs")
	logPath = filepath.Join(localLogDir, "U-Claw-Launcher.log")
	startLogPath = filepath.Join(localLogDir, "Windows-Start-App.log")
	usbLogPath = filepath.Join(root, "data", "logs", "U-Claw-Launcher.log")
	usbStartLogPath = filepath.Join(root, "data", "logs", "Windows-Start-App.log")
	mainLogPath = filepath.Join(root, "data", "logs", "main.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0755)

	mutex, alreadyRunning := acquireSingleInstanceMutex(root)
	if alreadyRunning {
		writeRelaunchRequest(root)
		os.Exit(0)
	}
	if mutex != 0 {
		defer procCloseHandle.Call(mutex)
	}

	exitCode := 0
	for {
		clearRelaunchRequest(root)
		launcherStarted = time.Now()
		logStartOffset = fileSize(logPath)
		startLogStartOffset = fileSize(startLogPath)
		appendLauncherLog("Launcher run started.")
		atomic.StoreInt32(&processDone, 0)
		atomic.StoreInt32(&processExitCode, 0)
		atomic.StoreInt32(&windowHidden, 1)
		go func() {
			code := runScript(root, script, startLogPath)
			syncLauncherLogs()
			atomic.StoreInt32(&processExitCode, int32(code))
			atomic.StoreInt32(&processDone, 1)
		}()
		if err := runStatusWindow(); err != nil {
			appendLauncherLog("Status window failed: " + err.Error())
			for atomic.LoadInt32(&processDone) == 0 {
				time.Sleep(200 * time.Millisecond)
			}
		}
		exitCode = int(atomic.LoadInt32(&processExitCode))
		if exitCode != 0 {
			break
		}
		if !hasFreshRelaunchRequest(root, 2*time.Minute) {
			break
		}
		appendLauncherLog("Relaunch requested while U-Claw was closing; starting again.")
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

func existingLaunchIsClosing() bool {
	lines := tailLinesSince(mainLogPath, 40, time.Now().Add(-10*time.Minute))
	if len(lines) == 0 {
		return false
	}
	closing := false
	for _, line := range lines {
		if strings.Contains(line, "Shutdown started") ||
			strings.Contains(line, "Shutdown requested") ||
			strings.Contains(line, "Stopping gateway") ||
			strings.Contains(line, "Stopping video adapter") ||
			strings.Contains(line, "Stopping config server") {
			closing = true
		}
		if strings.Contains(line, "Shutdown complete") ||
			strings.Contains(line, " starting...") ||
			strings.Contains(line, "Gateway ready on port") {
			closing = false
		}
	}
	return closing
}

func appendLauncherLog(message string) {
	if logPath == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(logPath), 0755)
	line := "[" + time.Now().Format(time.RFC3339Nano) + "] [U-Claw] " + message + "\r\n"
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
	copyFileBestEffort(startLogPath, usbStartLogPath)
}

func showStartupError() {
	message := syscall.StringToUTF16Ptr("U-Claw 启动失败。请查看 U-Claw\\data\\logs\\U-Claw-Launcher.log。")
	title := syscall.StringToUTF16Ptr("U-Claw Launcher")
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), mbOK|mbIconError)
}

func runScript(root string, script string, logPath string) int {
	logFile, _ := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if logFile != nil {
		defer logFile.Close()
	}

	cmd := exec.Command("cmd.exe", "/c", script)
	cmd.Dir = os.TempDir()
	cmd.Env = append(os.Environ(),
		"UCLAW_LAUNCHER_GUI=1",
		"UCLAW_LAUNCHER_LOCAL_LOG="+logPath,
		"UCLAW_WINDOWS_START_LOCAL_LOG="+startLogPath,
		"UCLAW_USB_LAUNCHER_LOG="+usbLogPath,
		"UCLAW_USB_WINDOWS_START_LOG="+usbStartLogPath,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if logFile != nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}

	if err := cmd.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			return exitError.ExitCode()
		}
		return 1
	}
	return 0
}

func runStatusWindow() error {
	className := syscall.StringToUTF16Ptr("UClawPortableLauncherWindow")
	title := syscall.StringToUTF16Ptr("U-Claw Launcher")
	instance, _, err := procGetModuleHandleW.Call(0)
	if instance == 0 {
		return err
	}

	class := wndClassEx{
		size:      uint32(unsafe.Sizeof(wndClassEx{})),
		style:     csHRedraw | csVRedraw,
		wndProc:   syscall.NewCallback(windowProc),
		instance:  syscall.Handle(instance),
		className: className,
	}
	if result, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class))); result == 0 && err != syscall.Errno(errorClassExists) {
		return err
	}

	windowHandle, _, err = procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		wsOverlappedWindow,
		cwUseDefault,
		cwUseDefault,
		680,
		430,
		0,
		0,
		instance,
		0,
	)
	if windowHandle == 0 {
		return err
	}

	staticClass := syscall.StringToUTF16Ptr("STATIC")
	initial := syscall.StringToUTF16Ptr(initialStatusText())
	textHandle, _, _ = procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(staticClass)),
		uintptr(unsafe.Pointer(initial)),
		wsChild|wsVisible|wsVScroll|ssLeft,
		18,
		18,
		630,
		350,
		windowHandle,
		0,
		instance,
		0,
	)
	procSetTimer.Call(windowHandle, 1, 500, 0)
	procShowWindow.Call(windowHandle, swShow)
	atomic.StoreInt32(&windowHidden, 0)
	procUpdateWindow.Call(windowHandle)
	updateStatusWindow()

	var message msg
	for {
		ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(ret) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
	return nil
}

func windowProc(hwnd uintptr, message uint32, wParam uintptr, lParam uintptr) uintptr {
	switch message {
	case wmTimer:
		updateStatusWindow()
		return 0
	case wmClose:
		procShowWindow.Call(hwnd, swHide)
		atomic.StoreInt32(&windowHidden, 1)
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	default:
		ret, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
		return ret
	}
}

func updateStatusWindow() {
	rawStatus := rawStatusText()
	status := displayStatusText(rawStatus)
	if textHandle != 0 {
		text := syscall.StringToUTF16Ptr(status)
		procSetWindowTextW.Call(textHandle, uintptr(unsafe.Pointer(text)))
	}

	if atomic.LoadInt32(&windowHidden) == 1 && isShutdownStatus(rawStatus) {
		procShowWindow.Call(windowHandle, swShow)
		atomic.StoreInt32(&windowHidden, 0)
	}

	if atomic.LoadInt32(&processDone) == 1 {
		procKillTimer.Call(windowHandle, 1)
		if atomic.LoadInt32(&processExitCode) != 0 {
			procShowWindow.Call(windowHandle, swShow)
			atomic.StoreInt32(&windowHidden, 0)
			message := syscall.StringToUTF16Ptr("U-Claw 启动失败。请查看 U-Claw\\data\\logs\\U-Claw-Launcher.log。")
			title := syscall.StringToUTF16Ptr("U-Claw Launcher")
			procMessageBoxW.Call(windowHandle, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), mbOK|mbIconError)
		}
		procPostQuitMessage.Call(0)
		return
	}

	if atomic.LoadInt32(&windowHidden) == 1 && shouldShowStatusWindow(rawStatus) {
		procShowWindow.Call(windowHandle, swShow)
		atomic.StoreInt32(&windowHidden, 0)
	}

	if atomic.LoadInt32(&windowHidden) == 0 && strings.Contains(rawStatus, "Starting Windows desktop app") && !isShutdownStatus(rawStatus) {
		procShowWindow.Call(windowHandle, swHide)
		atomic.StoreInt32(&windowHidden, 1)
	}
}

func shouldShowStatusWindow(status string) bool {
	if isShutdownStatus(status) {
		return true
	}
	if time.Since(launcherStarted) < 1200*time.Millisecond {
		return false
	}
	if strings.Contains(status, "Starting Windows desktop app") {
		return false
	}
	return strings.Contains(status, "Installing updated app cache") ||
		strings.Contains(status, "Copying Windows archive") ||
		strings.Contains(status, "Verifying cached Windows archive") ||
		strings.Contains(status, "Extracting") ||
		strings.Contains(status, "Another U-Claw startup") ||
		strings.Contains(status, "Syncing USB data to computer cache") ||
		strings.Contains(status, "Runtime data has unsynced changes")
}

func initialStatusText() string {
	return "U-Claw 正在启动...\r\n\r\n首次启动需要准备程序缓存，可能需要几分钟。\r\n后续同版本启动会更快。"
}

func rawStatusText() string {
	lines := tailLinesFromOffset(logPath, logStartOffset, 6)
	lines = append(lines, tailLinesFromOffset(startLogPath, startLogStartOffset, 14)...)
	lines = append(lines, tailLinesSince(mainLogPath, 8, launcherStarted.Add(-2*time.Second))...)
	if len(lines) > 18 {
		lines = lines[len(lines)-18:]
	}
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n")
}

func displayStatusText(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return initialStatusText()
	}

	title := "U-Claw 正在启动..."
	stage := "正在准备运行环境。"
	detail := "请稍候。首次启动可能需要几分钟。"

	if isShutdownStatus(raw) {
		title = "U-Claw 正在关闭..."
		stage = "正在停止服务并同步数据。"
		detail = "完成后会自动退出。"
	}
	if strings.Contains(raw, "Another U-Claw startup") {
		stage = "已有启动任务正在准备程序缓存。"
		detail = "正在等待它完成，避免双进程。"
	}
	if strings.Contains(raw, "Installing updated app cache") {
		stage = "正在安装程序缓存。"
		detail = "同版本只需要执行一次。"
	}
	if strings.Contains(raw, "Copying Windows archive") {
		stage = "正在复制程序到电脑缓存。"
		detail = progressDetail(raw, `Copying Windows archive\.\.\. ([0-9,]+)/([0-9,]+) MB \(([^)]+)\), ([0-9]+)s elapsed\.`, "复制进度")
	}
	if strings.Contains(raw, "Verifying cached Windows archive") {
		stage = "正在校验程序缓存。"
		detail = "正在确认文件完整性。"
	}
	if strings.Contains(raw, "Extracting Windows app") || strings.Contains(raw, "Extracting with Windows tar") || strings.Contains(raw, "Windows tar unavailable") {
		stage = "正在解压程序。"
		detail = progressDetail(raw, `Extracting Windows app\.\.\. ([0-9]+)s elapsed, ([0-9]+) files, ([0-9.]+) MB`, "解压进度")
	}
	if strings.Contains(raw, "Preparing runtime data cache") {
		stage = "正在准备数据缓存。"
		detail = "聊天、skills、memory、license 会保留在 U 盘 data 里。"
	}
	if strings.Contains(raw, "Syncing USB data to runtime cache") {
		stage = "正在同步 U 盘数据到电脑缓存。"
		detail = progressDetail(raw, `Syncing USB data to runtime cache\.\.\. ([0-9]+)s elapsed, ([0-9]+) files, ([0-9.]+) MB\.`, "同步进度")
	}
	if strings.Contains(raw, "Syncing runtime cache back to USB") || strings.Contains(raw, "Syncing runtime data back to USB") {
		stage = "正在同步数据回 U 盘。"
		detail = progressDetail(raw, `Syncing runtime (?:cache|data) back to USB\.\.\. ([0-9]+)s elapsed, ([0-9]+) files, ([0-9.]+) MB\.`, "同步进度")
	}
	if strings.Contains(raw, "Runtime data has unsynced changes") {
		stage = "检测到上次数据未同步完成。"
		detail = "正在先回写 U 盘，避免数据丢失。"
	}
	if strings.Contains(raw, "Shutdown complete") {
		stage = "关闭完成。"
		detail = "所有本次启动的服务已停止。"
	}

	return title + "\r\n\r\n" + stage + "\r\n\r\n" + detail
}

func progressDetail(raw string, pattern string, label string) string {
	re := regexp.MustCompile(pattern)
	matches := re.FindAllStringSubmatch(raw, -1)
	if len(matches) == 0 {
		return "请稍候。首次启动可能需要几分钟。"
	}
	last := matches[len(matches)-1]
	switch len(last) {
	case 5:
		return fmt.Sprintf("%s：%s / %s MB，%s，已用 %s 秒。", label, last[1], last[2], last[3], last[4])
	case 4:
		return fmt.Sprintf("%s：已用 %s 秒，%s 个文件，%s MB。", label, last[1], last[2], last[3])
	default:
		return "请稍候。"
	}
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

func isShutdownStatus(status string) bool {
	return strings.Contains(status, "Shutdown started") ||
		strings.Contains(status, "Shutdown requested") ||
		strings.Contains(status, "Stopping gateway") ||
		strings.Contains(status, "Stopping video adapter") ||
		strings.Contains(status, "Stopping config server") ||
		strings.Contains(status, "Shutdown complete") ||
		strings.Contains(status, "Syncing runtime data back to USB") ||
		strings.Contains(status, "launcher-final-sync")
}

func tailLines(path string, maxLines int) []string {
	data, err := readTailBytes(path, 16384)
	if err != nil || len(data) == 0 {
		return nil
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	lines := strings.Split(text, "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return lines
}

func tailLinesFromOffset(path string, offset int64, maxLines int) []string {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || info.Size() <= offset {
		return nil
	}
	if info.Size()-offset > 16384 {
		offset = info.Size() - 16384
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil
	}
	data, err := io.ReadAll(file)
	if err != nil || len(data) == 0 {
		return nil
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	lines := strings.Split(text, "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return lines
}

func tailLinesSince(path string, maxLines int, since time.Time) []string {
	lines := tailLines(path, maxLines*4)
	if len(lines) == 0 {
		return nil
	}
	filtered := make([]string, 0, len(lines))
	for _, line := range lines {
		if logLineTime(line).Before(since) {
			continue
		}
		filtered = append(filtered, line)
	}
	if len(filtered) > maxLines {
		filtered = filtered[len(filtered)-maxLines:]
	}
	return filtered
}

func logLineTime(line string) time.Time {
	if !strings.HasPrefix(line, "[") {
		return time.Time{}
	}
	end := strings.Index(line, "]")
	if end <= 1 {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339Nano, line[1:end])
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func readTailBytes(path string, maxBytes int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	offset := info.Size() - maxBytes
	if offset < 0 {
		offset = 0
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(file)
}
