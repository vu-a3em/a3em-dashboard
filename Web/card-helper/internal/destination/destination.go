// Package destination is where a card's image goes: chosen by the person in the system's own
// save dialog, and checked for room before anything is copied.
//
// The page cannot choose a path on this computer — the browser gives it none — so the helper
// asks the system to show its dialog. And a 128 GB image that stops at 90% because the drive
// filled, or at 4 GB because the drive is FAT32, wastes an hour and says nothing useful; both
// are known before the first byte is read, so they are said then.
package destination

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/safety"
)

// Space is whether an image of NeededBytes fits at Path.
type Space struct {
	Path        string `json:"path"`
	NeededBytes int64  `json:"neededBytes"`
	FreeBytes   int64  `json:"freeBytes"`
	Filesystem  string `json:"filesystem,omitempty"`
	// Exists is a file already there, which the person agreed to replace in the dialog.
	Exists  bool   `json:"exists"`
	Fits    bool   `json:"fits"`
	Problem string `json:"problem,omitempty"`
}

// ErrCanceled is returned when the dialog was closed without choosing.
var ErrCanceled = errors.New("no location was chosen")

// ErrNoDialog is returned where the system has no save dialog the helper can show.
var ErrNoDialog = errors.New("no save dialog is available")

// Room left over beyond the image itself, so a drive is not filled to the last byte.
const margin = 64 << 20

// FAT32's largest file.
const fatLimit = 4<<30 - 1

// Check says whether an image of size bytes can be written at path.
func Check(path string, size int64) Space {
	space := Space{Path: path, NeededBytes: size}
	if _, err := os.Stat(path); err == nil {
		space.Exists = true
	}
	dir := filepath.Dir(path)
	free, filesystem, err := stat(dir)
	if err != nil {
		space.Problem = fmt.Sprintf("The folder %s cannot be used: %v.", dir, err)
		return space
	}
	// A file being replaced stays until the copy has finished, so it frees nothing meanwhile.
	space.FreeBytes, space.Filesystem = free, filesystem
	switch {
	case isFAT(filesystem) && size > fatLimit:
		space.Problem = fmt.Sprintf("That drive is formatted FAT32, which cannot hold a file larger than 4 GB, and the image is %s. Choose a drive formatted exFAT, APFS, NTFS or ext4.", safety.FormatSize(size))
	case free < size+margin:
		space.Problem = fmt.Sprintf("The image needs %s, but only %s is free there. Choose another drive, or make room first.", safety.FormatSize(size), safety.FormatSize(free))
	default:
		space.Fits = true
	}
	return space
}

// StartFolder is where the save dialog opens: the default folder if there is one already, and
// Documents otherwise. Nothing is created, since the person may choose somewhere else.
func StartFolder() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	for _, folder := range []string{filepath.Join(home, "Documents", "A3EM card images"), filepath.Join(home, "Documents")} {
		if info, err := os.Stat(folder); err == nil && info.IsDir() {
			return folder
		}
	}
	return home
}

// DefaultFolder is where images go when nowhere else is chosen, created if need be.
func DefaultFolder() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	folder := filepath.Join(home, "Documents", "A3EM card images")
	return folder, os.MkdirAll(folder, 0o755)
}

// Chosen is the path the person chose, with the .img extension it may have been given without.
func Chosen(path string) string {
	path = strings.TrimSpace(path)
	if path != "" && !strings.EqualFold(filepath.Ext(path), ".img") {
		path += ".img"
	}
	return path
}

// Choose shows the system's save dialog, starting in dir with name filled in. A test can name
// the answer instead, in A3EM_HELPER_SAVE_AS_DIR, so no dialog is shown.
func Choose(dir, name, prompt string) (string, error) {
	if test := os.Getenv("A3EM_HELPER_SAVE_AS_DIR"); test != "" {
		return filepath.Join(test, name), nil
	}
	path, err := choose(dir, name, prompt)
	if err != nil {
		return "", err
	}
	return Chosen(path), nil
}
