//go:build !windows

package main

import "errors"

func candidateRoots() ([]string, error) {
	return nil, errors.New("offline updater is supported only on Windows")
}

func confirmUpdate([]Candidate, ReleaseSummary) (Candidate, bool, error) {
	return Candidate{}, false, errors.New("offline updater is supported only on Windows")
}

func showError(error) {}

func launchAfterUpdate(path string) error {
	return defaultLaunch(path)
}
