//go:build unix

package dbus

import (
	"os"
	"syscall"
)

// dialUnix connects to a Unix socket, "@name" being Linux's abstract namespace. Through syscall
// rather than net, which the helper does not link. Non-blocking, so read deadlines work.
func dialUnix(path string) (*os.File, error) {
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	syscall.CloseOnExec(fd)
	if err := syscall.Connect(fd, &syscall.SockaddrUnix{Name: path}); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	if err := syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), "dbus"), nil
}
