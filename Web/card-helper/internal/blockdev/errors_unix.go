//go:build darwin || linux

package blockdev

import (
	"errors"
	"syscall"
)

func isWriteProtect(err error) bool { return errors.Is(err, syscall.EROFS) }

// CanAccess is whether this process may read and write path directly.
func CanAccess(path string) bool { return syscall.Access(path, 0x2|0x4) == nil }
