package apikey

import "bytes"

const MinBytes = 16
const MaxBytes = 16 << 10

func Valid(value []byte) bool {
	return len(value) >= MinBytes && len(value) <= MaxBytes && len(bytes.TrimSpace(value)) > 0
}
