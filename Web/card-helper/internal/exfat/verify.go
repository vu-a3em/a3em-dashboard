package exfat

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"unicode/utf16"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
)

// RegionCheck is how one region of a card compares with a freshly built one.
type RegionCheck struct {
	Name string `json:"name"`
	// Status is "match", "in-use" (differs only as a card in use does) or "differs".
	Status string `json:"status"`
	Note   string `json:"note,omitempty"`
}

// LayoutCheck is a card compared, region by region, with the layout this formatter produces.
type LayoutCheck struct {
	// Reference is true when the card carries the A3EM layout: every region matches, or
	// differs only by the files and flags that using a card leaves behind.
	Reference    bool          `json:"reference"`
	ClusterBytes int64         `json:"clusterBytes,omitempty"`
	Label        string        `json:"label,omitempty"`
	Problem      string        `json:"problem,omitempty"`
	Regions      []RegionCheck `json:"regions,omitempty"`
}

func readSectors(dev blockdev.Device, sector, count int64) ([]byte, error) {
	return blockdev.ReadAll(dev, int(count*BytesPerSector), sector*BytesPerSector)
}

// Verify rebuilds the expected layout from the card's own capacity, cluster size, identifiers
// and label, and compares every region. It only reads.
func Verify(dev blockdev.Device) (LayoutCheck, error) {
	mbr, err := readSectors(dev, 0, 1)
	if err != nil {
		return LayoutCheck{}, err
	}
	if mbr[0x1fe] != 0x55 || mbr[0x1ff] != 0xaa {
		return LayoutCheck{Problem: "The card has no MBR partition table."}, nil
	}
	entry := mbr[0x1be : 0x1be+16]
	if entry[4] != PartitionType || binary.LittleEndian.Uint32(entry[8:]) != PartitionStartSector {
		return LayoutCheck{Problem: fmt.Sprintf("The first partition is type 0x%02x at sector %d, not an exFAT partition at the 2 MiB mark.",
			entry[4], binary.LittleEndian.Uint32(entry[8:]))}, nil
	}
	vbr, err := readSectors(dev, PartitionStartSector, 1)
	if err != nil {
		return LayoutCheck{}, err
	}
	if !bytes.Equal(vbr[:11], append([]byte{0xeb, 0x76, 0x90}, []byte("EXFAT   ")...)) {
		return LayoutCheck{Problem: "The partition does not hold an exFAT volume."}, nil
	}
	clusterBytes := int64(BytesPerSector) << vbr[0x6d]
	layout, err := NewLayout(dev.Size(), clusterBytes)
	if err != nil {
		return LayoutCheck{Problem: err.Error()}, nil
	}
	root, err := readSectors(dev, layout.ClusterSector(layout.RootCluster), 1)
	if err != nil {
		return LayoutCheck{}, err
	}
	label := DefaultLabel
	if root[0] == 0x83 && root[1] > 0 && root[1] <= MaxLabelCharacters {
		units := make([]uint16, root[1])
		for i := range units {
			units[i] = binary.LittleEndian.Uint16(root[2+i*2:])
		}
		label = string(utf16.Decode(units))
	}
	plan, err := WritePlan(layout, binary.LittleEndian.Uint32(mbr[0x1b8:]), binary.LittleEndian.Uint32(vbr[0x64:]), label)
	if err != nil {
		return LayoutCheck{Problem: err.Error()}, nil
	}

	check := LayoutCheck{Reference: true, ClusterBytes: clusterBytes, Label: label}
	for _, region := range plan {
		actual, err := readSectors(dev, region.Sector, int64(len(region.Data)/BytesPerSector))
		if err != nil {
			return LayoutCheck{}, err
		}
		result := RegionCheck{Name: region.Name, Status: "match"}
		if !bytes.Equal(actual, region.Data) {
			if note, ok := inUse(region.Name, region.Data, actual); ok {
				result.Status, result.Note = "in-use", note
			} else {
				result.Status = "differs"
				check.Reference = false
			}
		}
		check.Regions = append(check.Regions, result)
	}
	return check, nil
}

// inUse recognises the differences that using a card leaves behind, as opposed to damage or a
// different formatter's layout. The same rules the retired Python formatter's verify applied.
func inUse(name string, expected, actual []byte) (string, bool) {
	var diffs []int
	for i := range expected {
		if expected[i] != actual[i] {
			diffs = append(diffs, i)
		}
	}
	switch name {
	case "boot region", "boot region backup":
		// VolumeFlags (the dirty bit) and PercentInUse change with use, and are excluded from the
		// boot checksum for exactly that reason.
		for _, d := range diffs {
			if d != 0x6a && d != 0x6b && d != 0x70 {
				return "", false
			}
		}
		return "flags and usage updated since formatting", true
	case "root directory":
		for _, d := range diffs {
			if d < 96 {
				return "", false
			}
		}
		entries := 0
		for offset := 96; offset < len(actual); offset += 32 {
			if actual[offset] != 0 {
				entries++
			}
		}
		return fmt.Sprintf("%d directory entries added since formatting", entries), true
	case "allocation bitmap":
		extra := 0
		for _, d := range diffs {
			if expected[d]&^actual[d] != 0 {
				return "", false // a metadata cluster marked free
			}
			for bits := actual[d] &^ expected[d]; bits != 0; bits &= bits - 1 {
				extra++
			}
		}
		return fmt.Sprintf("%d clusters in use by files", extra), true
	}
	return "", false
}
