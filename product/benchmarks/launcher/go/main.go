package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const readyJSON = `{"status":"ready","candidate":"go"}`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) != 2 || args[0] != "--manifest" || args[1] == "" {
		return fail("E_ARGUMENTS")
	}

	manifestFile, err := os.Open(args[1])
	if err != nil {
		return fail("E_MANIFEST_READ")
	}
	defer manifestFile.Close()

	var manifest Manifest
	decoder := json.NewDecoder(manifestFile)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return fail("E_MANIFEST_JSON")
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return fail("E_MANIFEST_JSON")
	}
	if err := ValidateManifest(manifest); err != nil {
		return fail("E_MANIFEST_INVALID")
	}
	if err := ValidatePackage(filepath.Dir(args[1]), manifest); err != nil {
		return fail("E_PACKAGE_INVALID")
	}

	fmt.Fprintln(os.Stdout, readyJSON)
	return 0
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if err == io.EOF {
		return nil
	}
	if err == nil {
		return fmt.Errorf("trailing JSON value")
	}
	return err
}

func fail(code string) int {
	fmt.Fprintln(os.Stderr, code)
	return 1
}
