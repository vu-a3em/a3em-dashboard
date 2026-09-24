package destination

import "syscall"

func stat(dir string) (int64, string, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, "", err
	}
	name := make([]byte, 0, len(st.Fstypename))
	for _, c := range st.Fstypename {
		if c == 0 {
			break
		}
		name = append(name, byte(c))
	}
	return int64(st.Bavail) * int64(st.Bsize), string(name), nil
}

func isFAT(filesystem string) bool { return filesystem == "msdos" }
