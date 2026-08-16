package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

const (
	payloadMagic    = "UCLAWUP1"
	payloadTrailer  = 16
	maxManifestSize = 1 << 20
)

type Payload struct {
	Manifest      []byte
	file          *os.File
	runtimeOffset int64
	runtimeLength int64
}

func openPayload(path string) (*Payload, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect update executable: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("update executable must be a regular file, not a symbolic link")
	}
	if info.Size() <= payloadTrailer {
		return nil, errors.New("update payload is too short")
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open update executable: %w", err)
	}
	closeWithError := func(err error) (*Payload, error) {
		_ = file.Close()
		return nil, err
	}

	trailer := make([]byte, payloadTrailer)
	if _, err := file.ReadAt(trailer, info.Size()-payloadTrailer); err != nil {
		return closeWithError(fmt.Errorf("read update trailer: %w", err))
	}
	if string(trailer[:8]) != payloadMagic {
		return closeWithError(errors.New("invalid update payload magic"))
	}
	manifestLength := int64(binary.BigEndian.Uint32(trailer[8:12]))
	runtimeLength := int64(binary.BigEndian.Uint32(trailer[12:16]))
	if manifestLength == 0 || runtimeLength == 0 {
		return closeWithError(errors.New("update payload sections must not be empty"))
	}
	if manifestLength > maxManifestSize {
		return closeWithError(errors.New("update manifest exceeds 1 MiB"))
	}
	payloadLength := manifestLength + runtimeLength
	payloadOffset := info.Size() - payloadTrailer - payloadLength
	if payloadOffset <= 0 {
		return closeWithError(errors.New("update payload lengths exceed executable size"))
	}

	manifest := make([]byte, manifestLength)
	if _, err := file.ReadAt(manifest, payloadOffset); err != nil {
		return closeWithError(fmt.Errorf("read update manifest: %w", err))
	}
	return &Payload{
		Manifest:      manifest,
		file:          file,
		runtimeOffset: payloadOffset + manifestLength,
		runtimeLength: runtimeLength,
	}, nil
}

func (p *Payload) Runtime() io.Reader {
	return io.NewSectionReader(p.file, p.runtimeOffset, p.runtimeLength)
}

func (p *Payload) RuntimeBytes() ([]byte, error) {
	return io.ReadAll(p.Runtime())
}

func (p *Payload) Close() error {
	return p.file.Close()
}
