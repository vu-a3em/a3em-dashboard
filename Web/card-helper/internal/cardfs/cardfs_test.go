package cardfs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTheLegacyConfigurationIsReadAndReplaced(t *testing.T) {
	mount := t.TempDir()
	os.WriteFile(filepath.Join(mount, "_a3em.cfg"), []byte("DEVICE_LABEL = \"OLD\"\n"), 0o644)
	config, err := ReadConfig(mount)
	if err != nil || !config.Present || config.Name != "_a3em.cfg" || config.Text != "DEVICE_LABEL = \"OLD\"\n" {
		t.Fatalf("a card prepared before the rename reads as %+v, %v", config, err)
	}
	if contents, _ := Walk(mount); contents.Files != 0 {
		t.Errorf("the legacy configuration counts as a file from before: %+v", contents)
	}
	if err := WriteConfig(mount, "DEVICE_LABEL = \"NEW\"\n"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(mount, "_a3em.cfg")); !os.IsNotExist(err) {
		t.Errorf("the legacy configuration was left beside the new one")
	}
	config, _ = ReadConfig(mount)
	if config.Name != "_conf.a3m" || config.Text != "DEVICE_LABEL = \"NEW\"\n" {
		t.Errorf("after writing, the card reads as %+v", config)
	}
}
