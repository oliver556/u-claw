package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestManagedProcessPassesExplicitArgumentsAndEnvironment(t *testing.T) {
	output := filepath.Join(t.TempDir(), "child output.txt")
	process, err := StartManagedProcess(ProcessSpec{
		Path: os.Args[0],
		Args: []string{"-test.run=TestLauncherProcessHelper", "--", output, "argument with spaces"},
		Env:  []string{"UCLAW_HELPER_MODE=write", "UCLAW_DATA_DIR=U盘数据"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Wait(); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "U盘数据|argument with spaces" {
		t.Fatalf("content = %q", content)
	}
}

func TestManagedProcessStopTerminatesProcessGroup(t *testing.T) {
	process, err := StartManagedProcess(ProcessSpec{
		Path: os.Args[0],
		Args: []string{"-test.run=TestLauncherProcessHelper", "--"},
		Env:  []string{"UCLAW_HELPER_MODE=sleep"},
	})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if err := process.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := process.Wait(); err == nil {
		t.Fatal("stopped process exited successfully")
	}
}

func TestStartManagedProcessRejectsUnsafeSpec(t *testing.T) {
	for name, spec := range map[string]ProcessSpec{
		"relative": {Path: "electron.exe"},
		"nul-arg":  {Path: os.Args[0], Args: []string{"bad\x00arg"}},
		"nul-env":  {Path: os.Args[0], Env: []string{"TOKEN=bad\x00value"}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := StartManagedProcess(spec); !errors.Is(err, ErrProcessInvalid) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestMergeEnvironmentWindowsOverridesKeysCaseInsensitively(t *testing.T) {
	merged := mergeEnvironmentForPlatform(
		[]string{"Path=C:\\Windows", "Uclaw_Data_Dir=C:\\Users\\host", "temp=C:\\host-temp"},
		[]string{"UCLAW_DATA_DIR=E:\\.uclaw\\data", "TEMP=C:\\U-Claw\\cache\\temp"},
		true,
	)
	want := []string{"Path=C:\\Windows", "TEMP=C:\\U-Claw\\cache\\temp", "UCLAW_DATA_DIR=E:\\.uclaw\\data"}
	if !reflect.DeepEqual(merged, want) {
		t.Fatalf("merged = %v", merged)
	}
}

func TestLauncherProcessHelper(t *testing.T) {
	mode := os.Getenv("UCLAW_HELPER_MODE")
	if mode == "" {
		return
	}
	separator := -1
	for index, argument := range os.Args {
		if argument == "--" {
			separator = index
			break
		}
	}
	switch mode {
	case "write":
		if separator < 0 || len(os.Args) < separator+3 {
			os.Exit(2)
		}
		content := strings.Join([]string{os.Getenv("UCLAW_DATA_DIR"), os.Args[separator+2]}, "|")
		if err := os.WriteFile(os.Args[separator+1], []byte(content), 0o600); err != nil {
			os.Exit(3)
		}
		os.Exit(0)
	case "sleep":
		for {
			time.Sleep(time.Second)
		}
	default:
		os.Exit(4)
	}
}
