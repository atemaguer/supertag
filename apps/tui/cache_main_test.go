package main

import (
	"os"
	"testing"
)

// TestMain keeps every test's cache out of the user's cache directory.
func TestMain(m *testing.M) {
	root, err := os.MkdirTemp("", "supertag-tui-cache-")
	if err != nil {
		panic(err)
	}
	cacheDirectory = func() (string, error) { return root, nil }
	code := m.Run()
	os.RemoveAll(root)
	os.Exit(code)
}
