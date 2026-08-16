//go:build windows && updaterfixture

package main

import (
	"errors"
	"os"
	"path/filepath"
)

func candidateRoots() ([]string, error) {
	roots := filepath.SplitList(os.Getenv("UCLAW_UPDATER_CANDIDATE_ROOTS"))
	if len(roots) == 0 {
		return nil, errors.New("fixture candidate roots are required")
	}
	return roots, nil
}

func confirmUpdate(candidates []Candidate, _ ReleaseSummary) (Candidate, bool, error) {
	if len(candidates) == 1 {
		return candidates[0], true, nil
	}
	selected := os.Getenv("UCLAW_UPDATER_SELECTED_ROOT")
	if selected == "" {
		return Candidate{}, false, errors.New("multiple fixture drives require explicit selection")
	}
	absolute, err := filepath.Abs(selected)
	if err != nil {
		return Candidate{}, false, err
	}
	for _, candidate := range candidates {
		if candidate.Root == absolute {
			return candidate, true, nil
		}
	}
	return Candidate{}, false, errors.New("selected fixture drive is not eligible")
}

func showError(error) {}

func launchAfterUpdate(path string) error {
	if os.Getenv("UCLAW_UPDATER_SKIP_LAUNCH") == "1" {
		return nil
	}
	return defaultLaunch(path)
}
