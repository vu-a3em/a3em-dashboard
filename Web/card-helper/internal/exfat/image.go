package exfat

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"sync"
	"unicode/utf16"
)

// PartitionType is the MBR type byte Windows uses for both NTFS and exFAT.
const PartitionType = 0x07

var (
	upcaseOnce  sync.Once
	upcaseBytes []byte
)

// UpcaseTable is the canonical up-case table, decompressed.
func UpcaseTable() []byte {
	upcaseOnce.Do(func() {
		compressed, err := base64.StdEncoding.DecodeString(upcaseZlibBase64)
		if err != nil {
			panic(err)
		}
		reader, err := zlib.NewReader(bytes.NewReader(compressed))
		if err != nil {
			panic(err)
		}
		upcaseBytes, err = io.ReadAll(reader)
		if err != nil {
			panic(err)
		}
	})
	return upcaseBytes
}

func rotateAdd(checksum uint32, value byte) uint32 {
	return ((checksum << 31) | (checksum >> 1)) + uint32(value)
}

// UpcaseChecksum is the rotate-right-and-add checksum exFAT records for the up-case table.
func UpcaseChecksum(table []byte) uint32 {
	var checksum uint32
	for _, b := range table {
		checksum = rotateAdd(checksum, b)
	}
	return checksum
}

// bootChecksum covers boot sectors 0..10, skipping VolumeFlags and PercentInUse in sector 0.
func bootChecksum(sectors []byte) uint32 {
	var checksum uint32
	for index, b := range sectors {
		if index == 106 || index == 107 || index == 112 {
			continue
		}
		checksum = rotateAdd(checksum, b)
	}
	return checksum
}

// CheckLabel reports whether exFAT can store this volume label.
func CheckLabel(label string) error {
	if n := len(utf16.Encode([]rune(label))); n == 0 || n > MaxLabelCharacters {
		return fmt.Errorf("the volume label must be 1 to %d characters", MaxLabelCharacters)
	}
	return nil
}

func chs(lba int64) [3]byte {
	const heads, sectors = 255, 63
	cylinder := lba / (heads * sectors)
	remainder := lba % (heads * sectors)
	head := remainder / sectors
	sector := remainder % sectors
	if cylinder > 1023 {
		cylinder, head, sector = 1023, 254, 62
	}
	return [3]byte{byte(head), byte(((cylinder >> 2) & 0xc0) | (sector + 1)), byte(cylinder & 0xff)}
}

// BuildMBR is one partition from the 2 MiB mark to the card's last sector. CHS fields use the
// conventional 255-head, 63-sector geometry, saturated once an address no longer fits; nothing
// reads them, since FatFs takes only the type byte and the starting LBA.
func BuildMBR(l Layout, diskSignature uint32) []byte {
	mbr := make([]byte, BytesPerSector)
	binary.LittleEndian.PutUint32(mbr[0x1b8:], diskSignature)
	entry := mbr[0x1be : 0x1be+16]
	start := chs(PartitionStartSector)
	end := chs(l.DiskSectors - 1)
	copy(entry[1:4], start[:])
	entry[4] = PartitionType
	copy(entry[5:8], end[:])
	binary.LittleEndian.PutUint32(entry[8:], PartitionStartSector)
	binary.LittleEndian.PutUint32(entry[12:], uint32(l.DiskSectors-PartitionStartSector))
	mbr[0x1fe], mbr[0x1ff] = 0x55, 0xaa
	return mbr
}

// BuildVBR is the volume boot record.
func BuildVBR(l Layout, volumeSerial uint32, percentInUse byte) []byte {
	vbr := make([]byte, BytesPerSector)
	copy(vbr, []byte{0xeb, 0x76, 0x90})
	copy(vbr[3:], "EXFAT   ")
	le := binary.LittleEndian
	le.PutUint64(vbr[0x40:], PartitionStartSector)
	le.PutUint64(vbr[0x48:], uint64(l.VolumeSectors))
	le.PutUint32(vbr[0x50:], uint32(l.FatOffsetSectors))
	le.PutUint32(vbr[0x54:], uint32(l.FatLengthSectors))
	le.PutUint32(vbr[0x58:], uint32(l.ClusterHeapOffsetSectors))
	le.PutUint32(vbr[0x5c:], uint32(l.ClusterCount))
	le.PutUint32(vbr[0x60:], uint32(l.RootCluster))
	le.PutUint32(vbr[0x64:], volumeSerial)
	le.PutUint16(vbr[0x68:], 0x0100) // filesystem revision 1.00
	le.PutUint16(vbr[0x6a:], 0)      // VolumeFlags: clean, active FAT 0
	vbr[0x6c] = 9                    // BytesPerSectorShift -> 512
	vbr[0x6d] = byte(l.SectorsPerClusterShift)
	vbr[0x6e] = 1    // NumberOfFats
	vbr[0x6f] = 0x80 // DriveSelect
	vbr[0x70] = percentInUse
	vbr[0x1fe], vbr[0x1ff] = 0x55, 0xaa
	return vbr
}

// BuildBootRegion is the twelve-sector boot region: VBR, eight extended sectors, OEM, reserved,
// and the checksum sector.
func BuildBootRegion(l Layout, volumeSerial uint32, percentInUse byte) []byte {
	region := make([]byte, 0, 12*BytesPerSector)
	region = append(region, BuildVBR(l, volumeSerial, percentInUse)...)
	extended := make([]byte, BytesPerSector)
	extended[510], extended[511] = 0x55, 0xaa
	for i := 0; i < 8; i++ {
		region = append(region, extended...)
	}
	region = append(region, bytes.Repeat([]byte{0xff}, BytesPerSector)...) // OEM parameters: none present
	region = append(region, make([]byte, BytesPerSector)...)               // reserved
	checksum := bootChecksum(region)
	sector := make([]byte, BytesPerSector)
	for offset := 0; offset < BytesPerSector; offset += 4 {
		binary.LittleEndian.PutUint32(sector[offset:], checksum)
	}
	return append(region, sector...)
}

// BuildFAT is the populated head of the FAT: the bitmap, up-case table and root directory chains.
func BuildFAT(l Layout) []byte {
	entries := []uint32{0xfffffff8, 0xffffffff}
	for cluster := int64(2); cluster <= l.RootCluster; cluster++ {
		last := cluster == l.UpcaseCluster-1 || cluster == l.RootCluster-1 || cluster == l.RootCluster
		if last {
			entries = append(entries, 0xffffffff)
		} else {
			entries = append(entries, uint32(cluster+1))
		}
	}
	fat := make([]byte, roundUp(int64(len(entries)*4), BytesPerSector))
	for index, value := range entries {
		binary.LittleEndian.PutUint32(fat[index*4:], value)
	}
	return fat
}

// BuildBitmap is the head of the allocation bitmap: only the formatter's own clusters are in use.
func BuildBitmap(l Layout) []byte {
	bitmap := make([]byte, roundUp(roundUp(l.MetadataClusters, 8)/8, BytesPerSector))
	for index := int64(0); index < l.MetadataClusters; index++ {
		bitmap[index>>3] |= 1 << (index & 7)
	}
	return bitmap
}

// BuildRootDirectory is the volume label, allocation bitmap and up-case table entries.
func BuildRootDirectory(l Layout, label string) ([]byte, error) {
	if err := CheckLabel(label); err != nil {
		return nil, err
	}
	cluster := make([]byte, l.ClusterBytes)
	units := utf16.Encode([]rune(label))
	cluster[0] = 0x83
	cluster[1] = byte(len(units))
	for index, unit := range units {
		binary.LittleEndian.PutUint16(cluster[2+index*2:], unit)
	}
	cluster[32] = 0x81
	binary.LittleEndian.PutUint32(cluster[32+20:], uint32(l.BitmapCluster))
	binary.LittleEndian.PutUint64(cluster[32+24:], uint64(l.BitmapBytes))
	upcase := UpcaseTable()
	cluster[64] = 0x82
	binary.LittleEndian.PutUint32(cluster[64+4:], UpcaseChecksum(upcase))
	binary.LittleEndian.PutUint32(cluster[64+20:], uint32(l.UpcaseCluster))
	binary.LittleEndian.PutUint64(cluster[64+24:], uint64(len(upcase)))
	return cluster, nil
}

// Region is one structure to write, at an absolute sector.
type Region struct {
	Name   string
	Sector int64
	Data   []byte
}

// WritePlan is every region, in the order to apply them. Everything before ZeroThroughSector is
// expected to have been blanked first, which leaves the unwritten tails of the FAT, bitmap and
// up-case table at zero. The MBR is last, so no host sees a partition until the volume is whole.
func WritePlan(l Layout, diskSignature, volumeSerial uint32, label string) ([]Region, error) {
	root, err := BuildRootDirectory(l, label)
	if err != nil {
		return nil, err
	}
	percent := byte(l.MetadataClusters * 100 / l.ClusterCount)
	boot := BuildBootRegion(l, volumeSerial, percent)
	upcase := UpcaseTable()
	padded := make([]byte, roundUp(int64(len(upcase)), BytesPerSector))
	copy(padded, upcase)
	return []Region{
		{"boot region", PartitionStartSector, boot},
		{"boot region backup", PartitionStartSector + 12, boot},
		{"file allocation table", PartitionStartSector + l.FatOffsetSectors, BuildFAT(l)},
		{"allocation bitmap", l.ClusterSector(l.BitmapCluster), BuildBitmap(l)},
		{"up-case table", l.ClusterSector(l.UpcaseCluster), padded},
		{"root directory", l.ClusterSector(l.RootCluster), root},
		{"master boot record", 0, BuildMBR(l, diskSignature)},
	}, nil
}

// Images is the whole format as two contiguous images for streaming to the raw device.
//
// Leading is the first MiB (the MBR and the zeroed gap after it) and is written LAST. Body runs
// from the 1 MiB mark to the end of the root directory, rounded up to a whole MiB, with every
// region laid into it and zeros everywhere else, so one pass both blanks and fills. Everything
// past the root directory is free cluster heap, where the rounding's extra zeros land harmlessly.
type Images struct {
	Layout  Layout
	Leading []byte
	Body    []byte // written at byte offset LeadingBytes
}

// BuildImages lays out a card of diskBytes at clusterBytes with the given label.
func BuildImages(diskBytes, clusterBytes int64, label string, diskSignature, volumeSerial uint32) (Images, error) {
	l, err := NewLayout(diskBytes, clusterBytes)
	if err != nil {
		return Images{}, err
	}
	plan, err := WritePlan(l, diskSignature, volumeSerial, label)
	if err != nil {
		return Images{}, err
	}
	bodyEnd := roundUp(l.ZeroThroughSector*BytesPerSector, LeadingBytes)
	if bodyEnd > l.DiskSectors*BytesPerSector {
		return Images{}, fmt.Errorf("the card is too small for this cluster size")
	}
	images := Images{Layout: l, Leading: make([]byte, LeadingBytes), Body: make([]byte, bodyEnd-LeadingBytes)}
	leadingSectors := int64(LeadingBytes / BytesPerSector)
	for _, region := range plan {
		if region.Sector < leadingSectors {
			copy(images.Leading[region.Sector*BytesPerSector:], region.Data)
		} else {
			copy(images.Body[(region.Sector-leadingSectors)*BytesPerSector:], region.Data)
		}
	}
	return images, nil
}
