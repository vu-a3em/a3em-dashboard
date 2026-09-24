//go:build !darwin

package blockdev

import (
	"errors"
	"os"
)

// ErrCanceled is returned when the administrator password was not given.
var ErrCanceled = errors.New("administrator access was not given")

// errNoPrivileged says this platform has no authopen: elevation is the worker's job here.
var errNoPrivileged = errors.New("no privileged open on this platform")

// Authorize is macOS's: elsewhere the elevated worker holds the privilege for a whole job.
func Authorize([]string, bool) (func(), error) { return func() {}, nil }

// ForcedAuthopen is macOS's test switch.
func ForcedAuthopen() bool { return false }

func viaAuthopenAlways() bool { return false }

func openPrivileged(string, int) (*os.File, error) { return nil, errNoPrivileged }

// OpenForChild opens path for a tool this process runs.
func OpenForChild(path string, write bool) (*os.File, error) {
	flag := os.O_RDONLY
	if write {
		flag = os.O_RDWR
	}
	file, err := os.OpenFile(path, flag, 0)
	if err != nil {
		return nil, Classify(err)
	}
	return file, nil
}
