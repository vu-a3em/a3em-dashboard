//go:build darwin || linux

package cardfs

import "syscall"

// FreeBytes is the space available on the mounted volume.
func FreeBytes(mount string) (int64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(mount, &stat); err != nil {
		return 0, err
	}
	return int64(stat.Bavail) * int64(stat.Bsize), nil
}
