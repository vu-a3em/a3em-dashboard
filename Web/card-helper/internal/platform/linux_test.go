//go:build linux

package platform

import "testing"

func TestUdisksNameEscapesAsUdisksDoes(t *testing.T) {
	for name, want := range map[string]string{"sdb1": "sdb1", "mmcblk0p1": "mmcblk0p1", "loop0p1": "loop0p1", "dm-0": "dm_2d0", "a_b": "a_5fb"} {
		if got := udisksName(name); got != want {
			t.Errorf("udisksName(%q) = %q, want %q", name, got, want)
		}
	}
}
