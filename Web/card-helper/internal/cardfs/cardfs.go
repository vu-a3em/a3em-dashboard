// Package cardfs reads and writes a mounted card through its filesystem: what is on it, its
// configuration file, and how much room is left.
package cardfs

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/rules"
)

// Contents summarizes what is on a card besides its configuration.
type Contents struct {
	Files       int   `json:"files"`
	Directories int   `json:"directories"`
	Bytes       int64 `json:"bytes"`
	// Examples are a few of the paths found, for the report.
	Examples []string `json:"examples,omitempty"`
	// Truncated is set when the walk stopped early; the counts are then lower bounds.
	Truncated bool `json:"truncated,omitempty"`
}

const walkLimit = 5000

// systemNames are what operating systems leave on any card they mount. None is a recording.
var systemNames = map[string]bool{
	".Spotlight-V100": true, ".fseventsd": true, ".Trashes": true, ".TemporaryItems": true,
	"System Volume Information": true, ".DS_Store": true, "$RECYCLE.BIN": true,
	".DocumentRevisions-V100": true, "LOST.DIR": true, ".metadata_never_index": true,
}

func ignored(name string) bool {
	return systemNames[name] || strings.HasPrefix(name, "._") || strings.HasPrefix(name, ".a3em-probe-")
}

// Walk counts everything on the card except its configuration and system droppings.
func Walk(mount string) (Contents, error) {
	var contents Contents
	errStop := errors.New("stop")
	err := filepath.WalkDir(mount, func(path string, entry fs.DirEntry, err error) error {
		if path == mount {
			return err
		}
		if err != nil {
			return nil // an unreadable entry is not a reason to give up on the rest
		}
		if ignored(entry.Name()) {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		relative, _ := filepath.Rel(mount, path)
		if relative == rules.ConfigFileName {
			return nil
		}
		if contents.Files+contents.Directories >= walkLimit {
			contents.Truncated = true
			return errStop
		}
		if entry.IsDir() {
			contents.Directories++
		} else {
			contents.Files++
			if info, err := entry.Info(); err == nil {
				contents.Bytes += info.Size()
			}
		}
		if len(contents.Examples) < 8 {
			contents.Examples = append(contents.Examples, filepath.ToSlash(relative))
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return contents, err
	}
	return contents, nil
}

// Config is the card's configuration file as found.
type Config struct {
	Present bool   `json:"present"`
	Text    string `json:"text,omitempty"`
	Bytes   int64  `json:"bytes"`
	// TooLarge is set, and Text left empty, for a file beyond anything the firmware reads.
	TooLarge bool `json:"tooLarge,omitempty"`
}

// ReadConfig reads _a3em.cfg from the card's root.
func ReadConfig(mount string) (Config, error) {
	path := filepath.Join(mount, rules.ConfigFileName)
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, err
	}
	config := Config{Present: true, Bytes: info.Size()}
	if info.Size() > rules.ConfigMaxBytes {
		config.TooLarge = true
		return config, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	config.Text = string(raw)
	return config, nil
}

// WriteConfig writes _a3em.cfg to the card's root and reads it back.
func WriteConfig(mount, text string) error {
	if len(text) == 0 {
		return errors.New("the configuration is empty")
	}
	if len(text) > rules.ConfigMaxBytes {
		return fmt.Errorf("the configuration is %d bytes, over the %d the firmware reads", len(text), rules.ConfigMaxBytes)
	}
	path := filepath.Join(mount, rules.ConfigFileName)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(text); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	back, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(back, []byte(text)) {
		return errors.New("the configuration did not read back as written")
	}
	return nil
}
