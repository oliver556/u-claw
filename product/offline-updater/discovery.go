package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Candidate struct {
	Root           string
	LauncherPath   string
	DataRoot       string
	CurrentVersion string
}

var candidateRequiredFiles = []string{
	"U-Claw.exe",
	filepath.Join(".uclaw", "version.json"),
	filepath.Join(".uclaw", "data", "license", "license.json"),
	filepath.Join(".uclaw", "data", "license", ".startup-credential.json"),
}

func discoverCandidates(roots []string) []Candidate {
	candidates := make([]Candidate, 0, len(roots))
	for _, root := range roots {
		absoluteRoot, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		valid := true
		for _, relative := range candidateRequiredFiles {
			info, err := os.Lstat(filepath.Join(absoluteRoot, relative))
			if err != nil || !info.Mode().IsRegular() {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		candidates = append(candidates, Candidate{
			Root:           absoluteRoot,
			LauncherPath:   filepath.Join(absoluteRoot, "U-Claw.exe"),
			DataRoot:       filepath.Join(absoluteRoot, ".uclaw"),
			CurrentVersion: readInstalledVersion(filepath.Join(absoluteRoot, ".uclaw", "version.json")),
		})
	}
	return candidates
}

func readInstalledVersion(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return "unknown"
	}
	var version struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(content, &version) != nil || version.Version == "" {
		return "unknown"
	}
	return version.Version
}
