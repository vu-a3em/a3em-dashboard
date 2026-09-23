package blockdev

import (
	"errors"
	"syscall"
)

const errorWriteProtect = syscall.Errno(19)

func isWriteProtect(err error) bool { return errors.Is(err, errorWriteProtect) }

// CanAccess is whether this process may open path for raw reading and writing. On Windows
// that needs an elevated token, so the question is answered by trying.
func CanAccess(path string) bool {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, 0, 0)
	if err != nil {
		return false
	}
	syscall.CloseHandle(handle)
	return true
}
