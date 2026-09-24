package destination

import (
	"fmt"
	"syscall"
)

// The filesystems worth naming, by their statfs magic numbers.
var magic = map[int64]string{
	0x4d44: "vfat", 0x2011bab0: "exfat", 0xef53: "ext4", 0x5346544e: "ntfs", 0x9123683e: "btrfs",
	0x58465342: "xfs", 0x01021994: "tmpfs", 0x65735546: "fuse", 0x6969: "nfs",
}

func stat(dir string) (int64, string, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, "", err
	}
	name, ok := magic[int64(st.Type)]
	if !ok {
		name = fmt.Sprintf("0x%x", st.Type)
	}
	return int64(st.Bavail) * int64(st.Bsize), name, nil
}

func isFAT(filesystem string) bool { return filesystem == "vfat" }
