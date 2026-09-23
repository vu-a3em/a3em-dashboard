package exfat

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// The Go formatter against the Python one it was ported from, region by region. Every case in
// testdata/python-golden.json was recorded from exfat_image.py (since retired), whose images
// fsck_exfat passes and macOS mounts with the requested allocation unit and label. The file is
// the only record of that formatter's output: keep it.
type golden struct {
	DiskBytes         int64 `json:"diskBytes"`
	ClusterBytes      int64 `json:"clusterBytes"`
	ZeroThroughSector int64 `json:"zeroThroughSector"`
	ClusterCount      int64 `json:"clusterCount"`
	Regions           []struct {
		Name   string `json:"name"`
		Sector int64  `json:"sector"`
		Length int    `json:"length"`
		SHA256 string `json:"sha256"`
	} `json:"regions"`
}

func TestMatchesPythonFormatter(t *testing.T) {
	raw, err := os.ReadFile("testdata/python-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []golden
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 40 {
		t.Fatalf("only %d golden cases", len(cases))
	}
	for _, c := range cases {
		layout, err := NewLayout(c.DiskBytes, c.ClusterBytes)
		if err != nil {
			t.Fatalf("%d bytes at %d: %v", c.DiskBytes, c.ClusterBytes, err)
		}
		if layout.ZeroThroughSector != c.ZeroThroughSector || layout.ClusterCount != c.ClusterCount {
			t.Fatalf("%d at %d: layout %+v", c.DiskBytes, c.ClusterBytes, layout)
		}
		plan, err := WritePlan(layout, 0x1a2b3c4d, 0xcafef00d, "A3EM")
		if err != nil {
			t.Fatal(err)
		}
		for index, region := range plan {
			want := c.Regions[index]
			sum := sha256.Sum256(region.Data)
			if region.Name != want.Name || region.Sector != want.Sector || len(region.Data) != want.Length || hex.EncodeToString(sum[:]) != want.SHA256 {
				t.Fatalf("%d at %d: region %q differs from Python", c.DiskBytes, c.ClusterBytes, region.Name)
			}
		}
	}
}

func TestImagesCarryEveryRegionAndZerosElsewhere(t *testing.T) {
	images, err := BuildImages(31_914_983_424, 131072, "A3EM", 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	plan, _ := WritePlan(images.Layout, 1, 2, "A3EM")
	whole := append(append([]byte{}, images.Leading...), images.Body...)
	covered := make([]bool, len(whole))
	for _, region := range plan {
		at := region.Sector * BytesPerSector
		if !bytes.Equal(whole[at:at+int64(len(region.Data))], region.Data) {
			t.Fatalf("%s is not where it belongs", region.Name)
		}
		for i := at; i < at+int64(len(region.Data)); i++ {
			covered[i] = true
		}
	}
	for i, b := range whole {
		if !covered[i] && b != 0 {
			t.Fatalf("byte %d outside every region is %d", i, b)
		}
	}
	if len(whole)%LeadingBytes != 0 {
		t.Fatal("images are not whole MiB")
	}
}

func TestUpcaseTable(t *testing.T) {
	table := UpcaseTable()
	if len(table) != 5836 || UpcaseChecksum(table) != 0xe619d30d {
		t.Fatalf("up-case table %d bytes, checksum %08x", len(table), UpcaseChecksum(table))
	}
}

func TestRejectsWhatExfatCannotHold(t *testing.T) {
	if _, err := BuildImages(31_914_983_424, 131072, "A_LABEL_TOO_LONG", 1, 2); err == nil {
		t.Fatal("accepted a 16-character label")
	}
	if _, err := NewLayout(31_914_983_424, 3000); err == nil {
		t.Fatal("accepted a cluster size that is not a power of two")
	}
}
