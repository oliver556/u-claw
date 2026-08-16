package main

import "testing"

type exitCodeError int

func (err exitCodeError) Error() string { return "process exited" }
func (err exitCodeError) ExitCode() int { return int(err) }

func TestUpdateRestartExitCode(t *testing.T) {
	if !isUpdateRestartExit(exitCodeError(42)) {
		t.Fatal("exit code 42 must trigger an update restart")
	}
	if isUpdateRestartExit(exitCodeError(1)) {
		t.Fatal("exit code 1 must remain an application failure")
	}
	if isUpdateRestartExit(nil) {
		t.Fatal("successful exit must not trigger an update restart")
	}
}
