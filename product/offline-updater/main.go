package main

import (
	"context"
	"fmt"
	"os"
)

func main() {
	deps := Dependencies{
		ExecutablePath: os.Executable,
		CandidateRoots: candidateRoots,
		RunHelper:      defaultRunHelper,
		Confirm:        confirmUpdate,
		Launch:         launchAfterUpdate,
	}
	if err := run(context.Background(), deps); err != nil {
		showError(err)
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
