package main

import (
	"flag"
	"fmt"
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
	mbOK        = 0x00000000
	mbIconError = 0x00000010
)

var (
	user32         = syscall.NewLazyDLL("user32.dll")
	procMessageBox = user32.NewProc("MessageBoxW")
	logPath        string
)

func main() {
	root := flag.String("usb", "", "Bavi-box root")
	transaction := flag.String("transaction", "", "update transaction path")
	node := flag.String("node", "", "updater node.exe")
	client := flag.String("client", "", "hard-update-client.js")
	waitPid := flag.String("wait-pid", "", "process id to wait before applying")
	launchAfter := flag.String("launch-after", "", "entrypoint to launch after update")
	flag.Parse()

	if *root != "" {
		logPath = filepath.Join(*root, "data", "logs", "Bavi-box-Win-Update-Helper.log")
	}
	appendLog("helper entered")
	if err := runApply(*root, *transaction, *node, *client, *waitPid, *launchAfter); err != nil {
		appendLog("update apply failed: " + err.Error())
		showError(*root, err)
		os.Exit(1)
	}
	appendLog("update apply complete")
}

func runApply(root, transaction, node, client, waitPid, launchAfter string) error {
	for _, item := range []struct {
		label string
		value string
	}{
		{"--usb", root},
		{"--transaction", transaction},
		{"--node", node},
		{"--client", client},
	} {
		if strings.TrimSpace(item.value) == "" {
			return fmt.Errorf("%s is required", item.label)
		}
	}
	if !isFile(node) {
		return fmt.Errorf("missing updater node: %s", node)
	}
	if !isFile(client) {
		return fmt.Errorf("missing updater client: %s", client)
	}

	args := []string{
		client,
		"apply-startup-update",
		"--usb", root,
		"--transaction", transaction,
	}
	if waitPid != "" {
		args = append(args, "--wait-pid", waitPid)
	}
	if launchAfter != "" {
		args = append(args, "--launch-after", launchAfter)
	}

	appendLog("running apply-startup-update")
	cmd := exec.Command(node, args...)
	cmd.Dir = root
	if file := openLogFile(); file != nil {
		defer file.Close()
		cmd.Stdout = file
		cmd.Stderr = file
	} else {
		cmd.Stdout = io.Discard
		cmd.Stderr = io.Discard
	}
	return cmd.Run()
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func openLogFile() *os.File {
	if logPath == "" {
		return nil
	}
	_ = os.MkdirAll(filepath.Dir(logPath), 0755)
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil
	}
	return file
}

func appendLog(message string) {
	file := openLogFile()
	if file == nil {
		return
	}
	defer file.Close()
	line := "[" + time.Now().Format(time.RFC3339Nano) + "] [Bavi-box] " + message + "\r\n"
	_, _ = file.WriteString(line)
}

func showError(root string, err error) {
	logHint := "Bavi-box\\data\\logs\\Bavi-box-Win-Update-Helper.log"
	if root != "" {
		logHint = filepath.Join(root, "data", "logs", "Bavi-box-Win-Update-Helper.log")
	}
	message := syscall.StringToUTF16Ptr("Bavi-box 更新失败。\n请查看日志：\n" + logHint + "\n\n" + err.Error())
	title := syscall.StringToUTF16Ptr("Bavi-box")
	procMessageBox.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), mbOK|mbIconError)
}
