//go:build windows

package main

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

const (
	statusWindowClass = "UClawLauncherStatusWindow"
	statusWindowTitle = "U-Claw"

	wmDestroy      = 0x0002
	wmClose        = 0x0010
	wmStatusUpdate = 0x8001

	wsCaption     = 0x00C00000
	wsSysMenu     = 0x00080000
	wsMinimizeBox = 0x00020000
	wsChild       = 0x40000000
	wsVisible     = 0x10000000

	swHide = 0
	swShow = 5

	colorWindow  = 5
	mbOK         = 0x00000000
	mbIconError  = 0x00000010
	mbTopmost    = 0x00040000
	cwUseDefault = 0x80000000
)

var (
	user32Status          = syscall.NewLazyDLL("user32.dll")
	kernel32Status        = syscall.NewLazyDLL("kernel32.dll")
	registerClassExW      = user32Status.NewProc("RegisterClassExW")
	createWindowExW       = user32Status.NewProc("CreateWindowExW")
	defWindowProcW        = user32Status.NewProc("DefWindowProcW")
	showWindow            = user32Status.NewProc("ShowWindow")
	updateWindow          = user32Status.NewProc("UpdateWindow")
	getMessageW           = user32Status.NewProc("GetMessageW")
	translateMessage      = user32Status.NewProc("TranslateMessage")
	dispatchMessageW      = user32Status.NewProc("DispatchMessageW")
	postMessageW          = user32Status.NewProc("PostMessageW")
	destroyWindow         = user32Status.NewProc("DestroyWindow")
	postQuitMessage       = user32Status.NewProc("PostQuitMessage")
	setWindowTextW        = user32Status.NewProc("SetWindowTextW")
	messageBoxW           = user32Status.NewProc("MessageBoxW")
	getModuleHandleW      = kernel32Status.NewProc("GetModuleHandleW")
	statusWindowProcedure = syscall.NewCallback(statusWindowProc)
	statusWindows         sync.Map
)

type windowClassEx struct {
	Size        uint32
	Style       uint32
	WindowProc  uintptr
	ClassExtra  int32
	WindowExtra int32
	Instance    syscall.Handle
	Icon        syscall.Handle
	Cursor      syscall.Handle
	Background  syscall.Handle
	MenuName    *uint16
	ClassName   *uint16
	IconSmall   syscall.Handle
}

type windowPoint struct {
	X int32
	Y int32
}

type windowMessage struct {
	Window  syscall.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Point   windowPoint
	Private uint32
}

type nativeStatusReporter struct {
	mu          sync.Mutex
	window      syscall.Handle
	label       syscall.Handle
	text        string
	state       State
	failed      bool
	creationErr error
	ready       chan struct{}
	done        chan struct{}
	closeOnce   sync.Once
}

func NewStatusReporter() Reporter {
	reporter := &nativeStatusReporter{
		text:  stateText(StateStarting),
		state: StateStarting,
		ready: make(chan struct{}),
		done:  make(chan struct{}),
	}
	go reporter.runWindow()
	<-reporter.ready
	return reporter
}

func (reporter *nativeStatusReporter) State(state State) {
	reporter.mu.Lock()
	reporter.state = state
	reporter.text = stateText(state)
	reporter.failed = false
	window := reporter.window
	reporter.mu.Unlock()
	if window != 0 {
		postMessageW.Call(uintptr(window), wmStatusUpdate, 0, 0)
	}
}

func (reporter *nativeStatusReporter) Fail(code string, message string) {
	reporter.mu.Lock()
	reporter.text = fmt.Sprintf("启动失败\r\n%s\r\n%s", code, message)
	reporter.failed = true
	window := reporter.window
	creationErr := reporter.creationErr
	text := reporter.text
	reporter.mu.Unlock()
	if window != 0 {
		postMessageW.Call(uintptr(window), wmStatusUpdate, 0, 0)
		showStatusMessageBox(window, text)
		return
	}
	if creationErr != nil {
		showStatusMessageBox(0, text)
	}
}

func (reporter *nativeStatusReporter) Close() {
	reporter.closeOnce.Do(func() {
		<-reporter.ready
		reporter.mu.Lock()
		window := reporter.window
		reporter.mu.Unlock()
		if window != 0 {
			postMessageW.Call(uintptr(window), wmClose, 0, 0)
		}
		<-reporter.done
	})
}

func (reporter *nativeStatusReporter) runWindow() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(reporter.done)

	window, label, err := createStatusWindow()
	reporter.mu.Lock()
	reporter.window = window
	reporter.label = label
	reporter.creationErr = err
	reporter.mu.Unlock()
	if err != nil {
		close(reporter.ready)
		return
	}
	statusWindows.Store(uintptr(window), reporter)
	close(reporter.ready)
	reporter.applyUpdate()

	var message windowMessage
	for {
		result, _, _ := getMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			break
		}
		translateMessage.Call(uintptr(unsafe.Pointer(&message)))
		dispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func createStatusWindow() (syscall.Handle, syscall.Handle, error) {
	instance, _, instanceErr := getModuleHandleW.Call(0)
	if instance == 0 {
		return 0, 0, fmt.Errorf("get module handle: %w", instanceErr)
	}
	className, _ := syscall.UTF16PtrFromString(statusWindowClass)
	class := windowClassEx{
		Size:       uint32(unsafe.Sizeof(windowClassEx{})),
		WindowProc: statusWindowProcedure,
		Instance:   syscall.Handle(instance),
		Background: syscall.Handle(colorWindow + 1),
		ClassName:  className,
	}
	if atom, _, callErr := registerClassExW.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return 0, 0, fmt.Errorf("register status window: %w", callErr)
	}
	title, _ := syscall.UTF16PtrFromString(statusWindowTitle)
	window, _, callErr := createWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		wsCaption|wsSysMenu|wsMinimizeBox,
		cwUseDefault,
		cwUseDefault,
		440,
		180,
		0,
		0,
		instance,
		0,
	)
	if window == 0 {
		return 0, 0, fmt.Errorf("create status window: %w", callErr)
	}
	staticClass, _ := syscall.UTF16PtrFromString("STATIC")
	initialText, _ := syscall.UTF16PtrFromString(stateText(StateStarting))
	label, _, labelErr := createWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(staticClass)),
		uintptr(unsafe.Pointer(initialText)),
		wsChild|wsVisible,
		24,
		32,
		380,
		88,
		window,
		0,
		instance,
		0,
	)
	if label == 0 {
		destroyWindow.Call(window)
		return 0, 0, fmt.Errorf("create status label: %w", labelErr)
	}
	showWindow.Call(window, swShow)
	updateWindow.Call(window)
	return syscall.Handle(window), syscall.Handle(label), nil
}

func statusWindowProc(window uintptr, message uint32, wParam uintptr, lParam uintptr) uintptr {
	switch message {
	case wmStatusUpdate:
		if value, ok := statusWindows.Load(window); ok {
			value.(*nativeStatusReporter).applyUpdate()
		}
		return 0
	case wmClose:
		destroyWindow.Call(window)
		return 0
	case wmDestroy:
		if value, ok := statusWindows.LoadAndDelete(window); ok {
			reporter := value.(*nativeStatusReporter)
			reporter.mu.Lock()
			reporter.window = 0
			reporter.mu.Unlock()
		}
		postQuitMessage.Call(0)
		return 0
	default:
		result, _, _ := defWindowProcW.Call(window, uintptr(message), wParam, lParam)
		return result
	}
}

func (reporter *nativeStatusReporter) applyUpdate() {
	reporter.mu.Lock()
	text := reporter.text
	state := reporter.state
	failed := reporter.failed
	window := reporter.window
	label := reporter.label
	reporter.mu.Unlock()
	if window == 0 || label == 0 {
		return
	}
	encoded, _ := syscall.UTF16PtrFromString(text)
	setWindowTextW.Call(uintptr(label), uintptr(unsafe.Pointer(encoded)))
	if state == StateReady && !failed {
		showWindow.Call(uintptr(window), swHide)
	} else {
		showWindow.Call(uintptr(window), swShow)
		updateWindow.Call(uintptr(window))
	}
}

func showStatusMessageBox(owner syscall.Handle, text string) {
	encodedText, _ := syscall.UTF16PtrFromString(text)
	encodedTitle, _ := syscall.UTF16PtrFromString(statusWindowTitle)
	messageBoxW.Call(
		uintptr(owner),
		uintptr(unsafe.Pointer(encodedText)),
		uintptr(unsafe.Pointer(encodedTitle)),
		mbOK|mbIconError|mbTopmost,
	)
}
