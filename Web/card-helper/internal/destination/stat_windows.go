package destination

import (
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	kernel32              = syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceEx    = kernel32.NewProc("GetDiskFreeSpaceExW")
	getVolumeInformation  = kernel32.NewProc("GetVolumeInformationW")
	getVolumePathNameProc = kernel32.NewProc("GetVolumePathNameW")
)

func stat(dir string) (int64, string, error) {
	path, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return 0, "", err
	}
	var available, total, free uint64
	if r, _, err := getDiskFreeSpaceEx.Call(uintptr(unsafe.Pointer(path)), uintptr(unsafe.Pointer(&available)),
		uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free))); r == 0 {
		return 0, "", err
	}
	// The volume's root, as GetVolumeInformation wants it: "E:\" or a mounted folder's path.
	root := make([]uint16, 1024)
	name := filepath.VolumeName(dir) + `\`
	if r, _, _ := getVolumePathNameProc.Call(uintptr(unsafe.Pointer(path)), uintptr(unsafe.Pointer(&root[0])), uintptr(len(root))); r != 0 {
		name = syscall.UTF16ToString(root)
	}
	rootPtr, _ := syscall.UTF16PtrFromString(name)
	fs := make([]uint16, 64)
	if r, _, _ := getVolumeInformation.Call(uintptr(unsafe.Pointer(rootPtr)), 0, 0, 0, 0, 0,
		uintptr(unsafe.Pointer(&fs[0])), uintptr(len(fs))); r == 0 {
		return int64(available), "", nil
	}
	return int64(available), syscall.UTF16ToString(fs), nil
}

func isFAT(filesystem string) bool { return filesystem == "FAT32" || filesystem == "FAT" }
