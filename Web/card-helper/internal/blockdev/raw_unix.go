//go:build darwin || linux

package blockdev

import (
	"os"
	"syscall"
)

type raw struct {
	*os.File
	size int64
}

func (r *raw) Size() int64 { return r.size }

func openRaw(path string, sizeBytes int64, write bool) (Device, error) {
	flag := os.O_RDONLY
	if write {
		flag = os.O_RDWR
	}
	handle, err := os.OpenFile(path, flag|directFlag|syscall.O_SYNC, 0)
	if err != nil {
		return nil, Classify(err)
	}
	if err := afterOpen(handle); err != nil {
		handle.Close()
		return nil, err
	}
	size := sizeBytes
	if size <= 0 {
		if end, err := handle.Seek(0, 2); err == nil && end > 0 {
			size = end
		}
	}
	return &raw{File: handle, size: size}, nil
}
