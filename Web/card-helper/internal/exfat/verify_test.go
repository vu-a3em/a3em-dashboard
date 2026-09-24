package exfat

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
)

func formatted(t *testing.T, size, cluster int64) (blockdev.Device, Images) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "card.img")
	f, _ := os.Create(path)
	f.Truncate(size)
	f.Close()
	dev, err := blockdev.OpenFile(path, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dev.Close() })
	images, err := BuildImages(size, cluster, "A3EM", 7, 9)
	if err != nil {
		t.Fatal(err)
	}
	if err := blockdev.WriteAll(dev, images.Body, LeadingBytes, nil); err != nil {
		t.Fatal(err)
	}
	if err := blockdev.WriteAll(dev, images.Leading, 0, nil); err != nil {
		t.Fatal(err)
	}
	return dev, images
}

func TestVerifyRecognizesItsOwnLayout(t *testing.T) {
	dev, _ := formatted(t, 4<<30, 131072)
	check, err := Verify(dev)
	if err != nil {
		t.Fatal(err)
	}
	if !check.Reference || check.ClusterBytes != 131072 || check.Label != "A3EM" {
		t.Fatalf("%+v", check)
	}
}

func TestVerifyToleratesUseButNotDamage(t *testing.T) {
	dev, images := formatted(t, 4<<30, 32768)
	// The dirty flag set by a mount, and a new root directory entry.
	dev.WriteAt([]byte{0x02}, int64(PartitionStartSector)*BytesPerSector+0x6a)
	rootAt := images.Layout.ClusterSector(images.Layout.RootCluster) * BytesPerSector
	dev.WriteAt([]byte{0x85}, rootAt+96)
	check, _ := Verify(dev)
	if !check.Reference {
		t.Fatalf("a card in normal use was reported as not matching: %+v", check)
	}
	// Now damage the FAT head.
	dev.WriteAt([]byte{0x12, 0x34}, int64(PartitionStartSector+images.Layout.FatOffsetSectors)*BytesPerSector+8)
	check, _ = Verify(dev)
	if check.Reference {
		t.Fatal("a damaged FAT was accepted")
	}
}

func TestVerifyExplainsAForeignCard(t *testing.T) {
	path := filepath.Join(t.TempDir(), "blank.img")
	f, _ := os.Create(path)
	f.Truncate(1 << 30)
	f.Close()
	dev, _ := blockdev.OpenFile(path, false)
	defer dev.Close()
	check, err := Verify(dev)
	if err != nil || check.Reference || check.Problem == "" {
		t.Fatalf("%+v %v", check, err)
	}
}
