package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func writePayload(t *testing.T, prefix, manifest, runtime []byte, magic string, manifestLength, runtimeLength uint32) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "U-Claw-Update.exe")
	var trailer bytes.Buffer
	trailer.WriteString(magic)
	if err := binary.Write(&trailer, binary.BigEndian, manifestLength); err != nil {
		t.Fatal(err)
	}
	if err := binary.Write(&trailer, binary.BigEndian, runtimeLength); err != nil {
		t.Fatal(err)
	}
	content := append(append(append(append([]byte{}, prefix...), manifest...), runtime...), trailer.Bytes()...)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestOpenPayloadReadsExactSections(t *testing.T) {
	manifest := []byte(`{"version":"1.2.3","notes":"Security update"}`)
	runtime := []byte("runtime-package")
	path := writePayload(t, []byte("exe"), manifest, runtime, payloadMagic, uint32(len(manifest)), uint32(len(runtime)))

	payload, err := openPayload(path)
	if err != nil {
		t.Fatal(err)
	}
	defer payload.Close()

	if !bytes.Equal(payload.Manifest, manifest) {
		t.Fatalf("manifest = %q, want %q", payload.Manifest, manifest)
	}
	gotRuntime, err := payload.RuntimeBytes()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotRuntime, runtime) {
		t.Fatalf("runtime = %q, want %q", gotRuntime, runtime)
	}
}

func TestOpenPayloadRejectsInvalidBoundaries(t *testing.T) {
	manifest := []byte(`{"version":"1.2.3"}`)
	runtime := []byte("runtime")
	tests := []struct {
		name           string
		magic          string
		manifest       []byte
		runtime        []byte
		manifestLength uint32
		runtimeLength  uint32
	}{
		{"wrong magic", "BADMAGIC", manifest, runtime, uint32(len(manifest)), uint32(len(runtime))},
		{"zero manifest", payloadMagic, nil, runtime, 0, uint32(len(runtime))},
		{"zero runtime", payloadMagic, manifest, nil, uint32(len(manifest)), 0},
		{"manifest length out of range", payloadMagic, manifest, runtime, uint32(len(manifest) + 100), uint32(len(runtime))},
		{"runtime length out of range", payloadMagic, manifest, runtime, uint32(len(manifest)), uint32(len(runtime) + 100)},
		{"manifest too large", payloadMagic, make([]byte, maxManifestSize+1), runtime, maxManifestSize + 1, uint32(len(runtime))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := writePayload(t, []byte("exe"), tt.manifest, tt.runtime, tt.magic, tt.manifestLength, tt.runtimeLength)
			if payload, err := openPayload(path); err == nil {
				payload.Close()
				t.Fatal("openPayload unexpectedly succeeded")
			}
		})
	}
}

func TestOpenPayloadRejectsTrailerOnlyAndSymlink(t *testing.T) {
	trailerOnly := writePayload(t, nil, []byte("{}"), []byte("x"), payloadMagic, 2, 1)
	if payload, err := openPayload(trailerOnly); err == nil {
		payload.Close()
		t.Fatal("trailer-only payload unexpectedly succeeded")
	}

	target := writePayload(t, []byte("exe"), []byte("{}"), []byte("x"), payloadMagic, 2, 1)
	link := filepath.Join(t.TempDir(), "linked.exe")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if payload, err := openPayload(link); err == nil {
		payload.Close()
		t.Fatal("symlink payload unexpectedly succeeded")
	}
}
