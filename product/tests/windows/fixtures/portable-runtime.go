package main

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

func main() {
	dataDir := os.Getenv("UCLAW_DATA_DIR")
	if !filepath.IsAbs(dataDir) {
		os.Exit(2)
	}
	marker := filepath.Join(dataDir, ".fixture-ready-"+strconv.Itoa(os.Getpid()))
	if err := os.WriteFile(marker, []byte("ready"), 0o600); err != nil {
		os.Exit(3)
	}
	time.Sleep(holdDuration())
}

func holdDuration() time.Duration {
	milliseconds, err := strconv.Atoi(os.Getenv("UCLAW_FIXTURE_HOLD_MS"))
	if err != nil || milliseconds < 1 || milliseconds > 30000 {
		return 100 * time.Millisecond
	}
	return time.Duration(milliseconds) * time.Millisecond
}
