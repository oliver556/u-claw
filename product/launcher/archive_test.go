package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

type archiveEntry struct {
	name     string
	body     []byte
	typeflag byte
	linkname string
}

func buildRuntimeArchive(t *testing.T, entries []archiveEntry) []byte {
	t.Helper()
	var output bytes.Buffer
	gzipWriter := gzip.NewWriter(&output)
	tarWriter := tar.NewWriter(gzipWriter)
	for _, entry := range entries {
		typeflag := entry.typeflag
		if typeflag == 0 {
			typeflag = tar.TypeReg
		}
		header := &tar.Header{
			Name:     entry.name,
			Mode:     0o755,
			Size:     int64(len(entry.body)),
			Typeflag: typeflag,
			Linkname: entry.linkname,
		}
		if typeflag == tar.TypeDir {
			header.Size = 0
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Size > 0 {
			if _, err := tarWriter.Write(entry.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func manifestForArchive(archive []byte, entries []archiveEntry) Manifest {
	manifest := validRuntimeManifest()
	digest := sha256.Sum256(archive)
	manifest.RuntimeSHA256 = hex.EncodeToString(digest[:])
	manifest.RuntimeBytes = int64(len(archive))
	manifest.UnpackedBytes = 0
	manifest.FileCount = 0
	for _, entry := range entries {
		typeflag := entry.typeflag
		if typeflag == 0 || typeflag == tar.TypeReg || typeflag == tar.TypeRegA {
			manifest.FileCount++
			manifest.UnpackedBytes += int64(len(entry.body))
		}
	}
	return manifest
}

func TestExtractRuntimeWritesOnlyDeclaredFiles(t *testing.T) {
	entries := []archiveEntry{
		{name: "electron", typeflag: tar.TypeDir},
		{name: "electron/electron.exe", body: []byte("executable")},
		{name: "resources/app.asar", body: []byte("application")},
	}
	archive := buildRuntimeArchive(t, entries)
	manifest := manifestForArchive(archive, entries)
	target := t.TempDir()
	if err := ExtractRuntime(context.Background(), bytes.NewReader(archive), target, manifest); err != nil {
		t.Fatal(err)
	}
	for path, expected := range map[string]string{
		"electron/electron.exe": "executable",
		"resources/app.asar":    "application",
	} {
		content, err := os.ReadFile(filepath.Join(target, filepath.FromSlash(path)))
		if err != nil {
			t.Fatal(err)
		}
		if string(content) != expected {
			t.Fatalf("%s = %q", path, content)
		}
	}
}

func TestExtractRuntimeRejectsUnsafeEntries(t *testing.T) {
	tests := map[string][]archiveEntry{
		"parent":    {{name: "../escape", body: []byte("x")}},
		"absolute":  {{name: "/escape", body: []byte("x")}},
		"symlink":   {{name: "link", typeflag: tar.TypeSymlink, linkname: "target"}},
		"hardlink":  {{name: "link", typeflag: tar.TypeLink, linkname: "target"}},
		"duplicate": {{name: "same", body: []byte("one")}, {name: "same", body: []byte("two")}},
		"marker":    {{name: cacheMarkerName, body: []byte("forged")}},
	}
	for name, entries := range tests {
		t.Run(name, func(t *testing.T) {
			archive := buildRuntimeArchive(t, entries)
			manifest := manifestForArchive(archive, entries)
			if err := ExtractRuntime(context.Background(), bytes.NewReader(archive), t.TempDir(), manifest); !errors.Is(err, ErrExtractionFailed) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestExtractRuntimeEnforcesDeclaredBounds(t *testing.T) {
	entries := []archiveEntry{{name: "electron.exe", body: []byte("payload")}}
	archive := buildRuntimeArchive(t, entries)
	for name, mutate := range map[string]func(*Manifest){
		"file-count":     func(value *Manifest) { value.FileCount-- },
		"unpacked-bytes": func(value *Manifest) { value.UnpackedBytes-- },
	} {
		t.Run(name, func(t *testing.T) {
			manifest := manifestForArchive(archive, entries)
			mutate(&manifest)
			if err := ExtractRuntime(context.Background(), bytes.NewReader(archive), t.TempDir(), manifest); !errors.Is(err, ErrExtractionFailed) {
				t.Fatalf("returned %v", err)
			}
		})
	}
}

func TestExtractRuntimeRejectsTruncatedArchive(t *testing.T) {
	entries := []archiveEntry{{name: "electron.exe", body: bytes.Repeat([]byte("payload"), 1024)}}
	archive := buildRuntimeArchive(t, entries)
	manifest := manifestForArchive(archive, entries)
	truncated := archive[:len(archive)/2]
	if err := ExtractRuntime(context.Background(), bytes.NewReader(truncated), t.TempDir(), manifest); !errors.Is(err, ErrExtractionFailed) {
		t.Fatalf("returned %v", err)
	}
}

func TestExtractRuntimeHonorsCancellation(t *testing.T) {
	entries := []archiveEntry{{name: "electron.exe", body: bytes.Repeat([]byte("x"), 1<<20)}}
	archive := buildRuntimeArchive(t, entries)
	manifest := manifestForArchive(archive, entries)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := ExtractRuntime(ctx, bytes.NewReader(archive), t.TempDir(), manifest); !errors.Is(err, context.Canceled) {
		t.Fatalf("returned %v", err)
	}
}

func TestExtractRuntimeStreamsWithoutReadingWholeArchive(t *testing.T) {
	entries := []archiveEntry{{name: "electron.exe", body: []byte("payload")}}
	archive := buildRuntimeArchive(t, entries)
	manifest := manifestForArchive(archive, entries)
	reader := &boundedReadRecorder{reader: bytes.NewReader(archive), maxRead: 64}
	if err := ExtractRuntime(context.Background(), reader, t.TempDir(), manifest); err != nil {
		t.Fatal(err)
	}
	if reader.largestRead > reader.maxRead {
		t.Fatalf("largest read = %d", reader.largestRead)
	}
}

type boundedReadRecorder struct {
	reader      io.Reader
	maxRead     int
	largestRead int
}

func (reader *boundedReadRecorder) Read(buffer []byte) (int, error) {
	if len(buffer) > reader.maxRead {
		buffer = buffer[:reader.maxRead]
	}
	if len(buffer) > reader.largestRead {
		reader.largestRead = len(buffer)
	}
	return reader.reader.Read(buffer)
}
