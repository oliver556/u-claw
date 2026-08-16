//go:build windows && !updaterfixture

package main

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"
)

const (
	driveRemovable     = 2
	messageYesNoCancel = 0x00000003
	messageYesNo       = 0x00000004
	messageError       = 0x00000010
	messageInformation = 0x00000040
	buttonYes          = 6
	buttonCancel       = 2
)

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	getLogicalDrives = kernel32.NewProc("GetLogicalDrives")
	getDriveType     = kernel32.NewProc("GetDriveTypeW")
	user32           = syscall.NewLazyDLL("user32.dll")
	messageBox       = user32.NewProc("MessageBoxW")
)

func candidateRoots() ([]string, error) {
	mask, _, callErr := getLogicalDrives.Call()
	if mask == 0 {
		return nil, callErr
	}
	var roots []string
	for index := 0; index < 26; index++ {
		if mask&(1<<index) == 0 {
			continue
		}
		root := string(rune('A'+index)) + `:\`
		rootPointer, err := syscall.UTF16PtrFromString(root)
		if err != nil {
			return nil, err
		}
		driveType, _, _ := getDriveType.Call(uintptr(unsafe.Pointer(rootPointer)))
		if driveType == driveRemovable {
			roots = append(roots, root)
		}
	}
	return roots, nil
}

func confirmUpdate(candidates []Candidate, summary ReleaseSummary) (Candidate, bool, error) {
	for _, candidate := range candidates {
		text := fmt.Sprintf("目标盘：%s\n当前版本：%s\n更新版本：%s\n\n%s\n\n是：更新此盘\n否：查看下一个盘\n取消：退出", candidate.Root, candidate.CurrentVersion, summary.Version, strings.Join(summary.Notes, "\n"))
		result := showMessage(text, "U-Claw 离线更新", messageYesNoCancel|messageInformation)
		if result == buttonYes {
			return candidate, true, nil
		}
		if result == buttonCancel {
			return Candidate{}, false, nil
		}
	}
	return Candidate{}, false, nil
}

func showError(err error) {
	showMessage(err.Error(), "U-Claw 离线更新失败", messageError)
}

func launchAfterUpdate(path string) error {
	if showMessage("更新成功。\n\n是否现在启动 U-Claw？", "U-Claw 离线更新", messageYesNo|messageInformation) != buttonYes {
		return nil
	}
	return defaultLaunch(path)
}

func showMessage(text, title string, flags uintptr) uintptr {
	textPointer, _ := syscall.UTF16PtrFromString(text)
	titlePointer, _ := syscall.UTF16PtrFromString(title)
	result, _, _ := messageBox.Call(0, uintptr(unsafe.Pointer(textPointer)), uintptr(unsafe.Pointer(titlePointer)), flags)
	return result
}
