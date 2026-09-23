package safety

import (
	"testing"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
)

func TestOnlyCardsAreEligible(t *testing.T) {
	card := platform.Device{ID: "disk4", SizeBytes: 64 << 30, Removable: true}
	if !Eligible(card) || RequireWritable(&card, "disk4") != nil {
		t.Fatal("a removable 64 GB card was refused")
	}
	for name, device := range map[string]platform.Device{
		"boot disk":  {ID: "disk0", SizeBytes: 64 << 30, Removable: true, IsBootDevice: true},
		"internal":   {ID: "disk1", SizeBytes: 64 << 30, Removable: true, Internal: true},
		"fixed":      {ID: "disk2", SizeBytes: 64 << 30},
		"image":      {ID: "disk3", SizeBytes: 64 << 30, Removable: true, Virtual: true},
		"hard drive": {ID: "disk5", SizeBytes: 4 << 40, Removable: true},
		"tiny":       {ID: "disk6", SizeBytes: 512 << 20, Removable: true},
	} {
		device := device
		if Eligible(device) || RequireWritable(&device, device.ID) == nil {
			t.Errorf("%s was allowed", name)
		}
	}
	if RequireWritable(nil, "disk9") == nil {
		t.Error("an absent device was allowed")
	}
}

func TestTestModeHidesRealDevices(t *testing.T) {
	t.Setenv("A3EM_HELPER_VIRTUAL_ONLY", "1")
	real := platform.Device{ID: "disk4", SizeBytes: 64 << 30, Removable: true}
	image := platform.Device{ID: "disk9", SizeBytes: 2 << 30, Virtual: true}
	if Eligible(real) || RequireWritable(&real, "disk4") == nil {
		t.Fatal("a real card was usable in test mode")
	}
	if !Eligible(image) || RequireWritable(&image, "disk9") != nil {
		t.Fatal("a disk image was refused in test mode")
	}
}
