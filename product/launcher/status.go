package main

import "os"

type headlessStatusReporter struct{}

func NewStatusReporter() Reporter {
	if statusReporterHeadless() {
		return headlessStatusReporter{}
	}
	return newPlatformStatusReporter()
}

func statusReporterHeadless() bool {
	return os.Getenv("UCLAW_LAUNCHER_HEADLESS") == "1"
}

func (headlessStatusReporter) State(State) {}

func (headlessStatusReporter) Fail(string, string) {}

func (headlessStatusReporter) Close() {}
