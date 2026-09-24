//go:build !unix

package dbus

import (
	"errors"
	"os"
)

func dialUnix(string) (*os.File, error) { return nil, errors.New("dbus: not on this system") }
