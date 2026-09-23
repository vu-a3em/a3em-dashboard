package blockdev

import (
	"errors"
	"os"
	"syscall"
)

const (
	fileFlagNoBuffering  = 0x20000000
	fileFlagWriteThrough = 0x80000000
)

type raw struct {
	*os.File
	size int64
}

func (r *raw) Size() int64 { return r.size }

// openRaw opens \\.\PhysicalDriveN unbuffered and write-through. Sharing is allowed so the
// open succeeds while Windows still has the disk; the caller has already removed its volumes.
func openRaw(path string, sizeBytes int64, write bool) (Device, error) {
	access := uint32(syscall.GENERIC_READ)
	if write {
		access |= syscall.GENERIC_WRITE
	}
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, access, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil,
		syscall.OPEN_EXISTING, fileFlagNoBuffering|fileFlagWriteThrough, 0)
	if err != nil {
		if errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
			return nil, ErrPermission
		}
		return nil, Classify(err)
	}
	return &raw{File: os.NewFile(uintptr(handle), path), size: sizeBytes}, nil
}
