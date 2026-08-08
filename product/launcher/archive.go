package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

var ErrExtractionFailed = errors.New("runtime extraction failed")

func ExtractRuntime(ctx context.Context, archive io.Reader, target string, manifest Manifest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateManifest(manifest); err != nil {
		return ErrExtractionFailed
	}
	gzipReader, err := gzip.NewReader(archive)
	if err != nil {
		return ErrExtractionFailed
	}
	defer gzipReader.Close()
	root, err := os.OpenRoot(target)
	if err != nil {
		return ErrExtractionFailed
	}
	defer root.Close()

	tarReader := tar.NewReader(gzipReader)
	seen := make(map[string]struct{})
	var fileCount int64
	var unpackedBytes int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return ErrExtractionFailed
		}
		normalized := strings.ReplaceAll(header.Name, `\`, "/")
		canonical := strings.ToLower(normalized)
		if !isSafeWindowsRelativePath(normalized) || canonical == strings.ToLower(cacheMarkerName) {
			return ErrExtractionFailed
		}
		if _, exists := seen[canonical]; exists {
			return ErrExtractionFailed
		}
		seen[canonical] = struct{}{}
		relative := filepath.FromSlash(normalized)

		switch header.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(relative, 0o700); err != nil {
				return ErrExtractionFailed
			}
		case tar.TypeReg, tar.TypeRegA:
			fileCount++
			if header.Size < 0 || fileCount > manifest.FileCount ||
				header.Size > manifest.UnpackedBytes-unpackedBytes {
				return ErrExtractionFailed
			}
			if parent := filepath.Dir(relative); parent != "." {
				if err := root.MkdirAll(parent, 0o700); err != nil {
					return ErrExtractionFailed
				}
			}
			mode := os.FileMode(header.Mode).Perm()
			if mode == 0 {
				mode = 0o600
			}
			file, err := root.OpenFile(relative, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return ErrExtractionFailed
			}
			written, copyErr := copyContext(ctx, file, tarReader)
			closeErr := file.Close()
			if copyErr != nil {
				if errors.Is(copyErr, context.Canceled) {
					return copyErr
				}
				return ErrExtractionFailed
			}
			if closeErr != nil || written != header.Size {
				return ErrExtractionFailed
			}
			unpackedBytes += written
		default:
			return ErrExtractionFailed
		}
	}
	if fileCount != manifest.FileCount || unpackedBytes != manifest.UnpackedBytes {
		return ErrExtractionFailed
	}
	if _, err := io.Copy(io.Discard, gzipReader); err != nil {
		return ErrExtractionFailed
	}
	return nil
}

func copyContext(ctx context.Context, destination io.Writer, source io.Reader) (int64, error) {
	buffer := make([]byte, 64*1024)
	return io.CopyBuffer(destination, &contextReader{ctx: ctx, source: source}, buffer)
}

type contextReader struct {
	ctx    context.Context
	source io.Reader
}

func (reader *contextReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.source.Read(buffer)
}
