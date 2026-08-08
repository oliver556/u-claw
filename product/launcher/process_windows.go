//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"
)

const (
	createSuspended                   = 0x00000004
	createNewProcessGroup             = 0x00000200
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x00002000
	processTerminate                  = 0x0001
	processSetQuota                   = 0x0100
	processSuspendResume              = 0x0800
)

var (
	kernel32Process    = syscall.NewLazyDLL("kernel32.dll")
	ntdllProcess       = syscall.NewLazyDLL("ntdll.dll")
	createJobObjectW   = kernel32Process.NewProc("CreateJobObjectW")
	setInformationJob  = kernel32Process.NewProc("SetInformationJobObject")
	openProcess        = kernel32Process.NewProc("OpenProcess")
	assignProcessToJob = kernel32Process.NewProc("AssignProcessToJobObject")
	terminateJobObject = kernel32Process.NewProc("TerminateJobObject")
	closeHandleProcess = kernel32Process.NewProc("CloseHandle")
	ntResumeProcess    = ntdllProcess.NewProc("NtResumeProcess")
)

type jobBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobExtendedLimitInformation struct {
	BasicLimitInformation jobBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type jobObject struct {
	handle syscall.Handle
}

func prepareProcessContainer(command *exec.Cmd) (processContainer, error) {
	handle, _, callErr := createJobObjectW.Call(0, 0)
	if handle == 0 {
		return nil, fmt.Errorf("create process job: %w", callErr)
	}
	job := &jobObject{handle: syscall.Handle(handle)}
	limits := jobExtendedLimitInformation{}
	limits.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	result, _, callErr := setInformationJob.Call(
		uintptr(job.handle),
		jobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		unsafe.Sizeof(limits),
	)
	if result == 0 {
		job.close()
		return nil, fmt.Errorf("configure process job: %w", callErr)
	}
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createSuspended | createNewProcessGroup}
	return job, nil
}

func (job *jobObject) attach(command *exec.Cmd) error {
	processHandle, _, callErr := openProcess.Call(
		processTerminate|processSetQuota|processSuspendResume,
		0,
		uintptr(command.Process.Pid),
	)
	if processHandle == 0 {
		return fmt.Errorf("open suspended process: %w", callErr)
	}
	defer closeHandleProcess.Call(processHandle)
	assigned, _, callErr := assignProcessToJob.Call(uintptr(job.handle), processHandle)
	if assigned == 0 {
		return fmt.Errorf("assign process job: %w", callErr)
	}
	status, _, _ := ntResumeProcess.Call(processHandle)
	if status != 0 {
		return fmt.Errorf("resume process: ntstatus 0x%x", status)
	}
	return nil
}

func (job *jobObject) terminate(_ *exec.Cmd) error {
	result, _, callErr := terminateJobObject.Call(uintptr(job.handle), 1)
	if result == 0 {
		return callErr
	}
	return nil
}

func (job *jobObject) close() error {
	if job.handle == 0 {
		return nil
	}
	result, _, callErr := closeHandleProcess.Call(uintptr(job.handle))
	job.handle = 0
	if result == 0 {
		return callErr
	}
	return nil
}
