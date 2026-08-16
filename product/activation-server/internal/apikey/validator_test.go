package apikey

import (
	"bytes"
	"testing"
)

func TestValidBoundariesAndWhitespaceBytes(t *testing.T) {
	for _, value := range [][]byte{bytes.Repeat([]byte{'k'}, 16), bytes.Repeat([]byte{'k'}, 16<<10), append(append([]byte("  "), bytes.Repeat([]byte{'k'}, 16)...), ' ', ' ')} {
		if !Valid(value) {
			t.Fatalf("rejected len=%d", len(value))
		}
	}
}

func TestValidRejectsLengthAndAllWhitespace(t *testing.T) {
	for _, value := range [][]byte{bytes.Repeat([]byte{'k'}, 15), bytes.Repeat([]byte{'k'}, (16<<10)+1), bytes.Repeat([]byte{' '}, 16)} {
		if Valid(value) {
			t.Fatalf("accepted len=%d", len(value))
		}
	}
}
