package blockdev

import (
	"errors"
	"os"
	"syscall"
)

// macOS has no O_DIRECT. /dev/rdiskN is already unbuffered; F_NOCACHE covers the rest.
const directFlag = 0

// dkiocSynchronize is DKIOCSYNCHRONIZE, _IO('d', 22): flush the device's own write cache.
const dkiocSynchronize = 0x20006416

func afterOpen(handle *os.File) error {
	_, _, errno := syscall.Syscall(syscall.SYS_FCNTL, handle.Fd(), syscall.F_NOCACHE, 1)
	if errno != 0 {
		return errno
	}
	return nil
}

// Sync flushes the card's write cache. fsync is refused on a character device (ENOTTY), and
// writes through /dev/rdisk are already synchronous, so what is left to flush is the card's.
func (r *raw) Sync() error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, r.Fd(), dkiocSynchronize, 0)
	if errno != 0 && !errors.Is(errno, syscall.ENOTTY) && !errors.Is(errno, syscall.ENOTSUP) {
		return errno
	}
	return nil
}
