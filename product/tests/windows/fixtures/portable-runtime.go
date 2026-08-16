package main

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

func main() {
	os.Exit(runFixture())
}

func runFixture() int {
	dataDir := os.Getenv("UCLAW_DATA_DIR")
	if !filepath.IsAbs(dataDir) {
		return 2
	}
	if os.Getenv("UCLAW_FIXTURE_UPDATE_RESTART_ONCE") == "1" {
		restartMarker := filepath.Join(dataDir, ".fixture-update-restart-requested")
		if _, err := os.Stat(restartMarker); os.IsNotExist(err) {
			if err := os.WriteFile(restartMarker, []byte("restart"), 0o600); err != nil {
				return 3
			}
			return 42
		} else if err != nil {
			return 3
		}
	}
	marker := filepath.Join(dataDir, ".fixture-ready-"+strconv.Itoa(os.Getpid()))
	if err := os.WriteFile(marker, []byte("ready"), 0o600); err != nil {
		return 3
	}
	time.Sleep(holdDuration())
	return 0
}

func holdDuration() time.Duration {
	milliseconds, err := strconv.Atoi(os.Getenv("UCLAW_FIXTURE_HOLD_MS"))
	if err != nil || milliseconds < 1 || milliseconds > 30000 {
		return 100 * time.Millisecond
	}
	return time.Duration(milliseconds) * time.Millisecond
}
