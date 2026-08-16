package main

import "errors"

const updateRestartExitCode = 42

type exitCoder interface {
	ExitCode() int
}

func isUpdateRestartExit(err error) bool {
	var coded exitCoder
	return errors.As(err, &coded) && coded.ExitCode() == updateRestartExitCode
}
