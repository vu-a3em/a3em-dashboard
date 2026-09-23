//go:build darwin || linux

package install

import (
	"os"
	"path/filepath"
)

func writeManifest(location Location, raw []byte) (string, error) {
	if err := os.MkdirAll(location.Dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(location.Dir, HostName+".json")
	return path, os.WriteFile(path, append(raw, '\n'), 0o644)
}

func removeManifest(location Location) error {
	return os.Remove(filepath.Join(location.Dir, HostName+".json"))
}

func readManifest(location Location) (string, []byte, error) {
	path := filepath.Join(location.Dir, HostName+".json")
	raw, err := os.ReadFile(path)
	return path, raw, err
}
