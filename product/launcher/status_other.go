//go:build !windows

package main

type discardStatusReporter struct{}

func NewStatusReporter() Reporter {
	return discardStatusReporter{}
}

func (discardStatusReporter) State(State) {}

func (discardStatusReporter) Fail(string, string) {}

func (discardStatusReporter) Close() {}
