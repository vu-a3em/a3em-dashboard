package exfat

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
)

// card is a formatted test card with files written into it directly, the way an exFAT driver
// would, so each kind of damage can then be made on purpose.
type card struct {
	t    *testing.T
	dev  blockdev.Device
	l    Layout
	next uint32 // the next free cluster
	// where each directory's entries go next: its first cluster and the byte offset within it
	dirs map[uint32]int
}

func newCard(t *testing.T) *card {
	t.Helper()
	dev, images := formatted(t, 256<<20, 4096)
	c := &card{t: t, dev: dev, l: images.Layout, next: uint32(images.Layout.RootCluster + 1), dirs: map[uint32]int{uint32(images.Layout.RootCluster): 96}}
	return c
}

func (c *card) sector(cluster uint32) int64 { return c.l.ClusterSector(int64(cluster)) }

func (c *card) read(sector, count int64) []byte {
	c.t.Helper()
	data, err := readSectors(c.dev, sector, count)
	if err != nil {
		c.t.Fatal(err)
	}
	return data
}

func (c *card) write(offset int64, data []byte) {
	c.t.Helper()
	// Read-modify-write whole sectors, as the device requires.
	first := offset / BytesPerSector
	last := (offset + int64(len(data)) + BytesPerSector - 1) / BytesPerSector
	block := c.read(first, last-first)
	copy(block[offset-first*BytesPerSector:], data)
	if err := blockdev.WriteAll(c.dev, block, first*BytesPerSector, nil); err != nil {
		c.t.Fatal(err)
	}
}

func (c *card) fatEntry(cluster, value uint32) {
	entry := make([]byte, 4)
	binary.LittleEndian.PutUint32(entry, value)
	c.write((PartitionStartSector+c.l.FatOffsetSectors)*BytesPerSector+int64(cluster)*4, entry)
}

// setBit marks a cluster in use, or free, in the allocation bitmap.
func (c *card) setBit(cluster uint32, used bool) {
	index := int64(cluster - 2)
	offset := c.sector(uint32(c.l.BitmapCluster))*BytesPerSector + index/8
	b := c.read(offset/BytesPerSector, 1)[offset%BytesPerSector]
	if used {
		b |= 1 << (index % 8)
	} else {
		b &^= 1 << (index % 8)
	}
	c.write(offset, []byte{b})
}

// add writes a file (or folder) into the directory starting at parent, and returns its first
// cluster. contiguous files carry no FAT chain.
func (c *card) add(parent uint32, name string, size int64, contiguous, folder bool) uint32 {
	c.t.Helper()
	clusters := (size + c.l.ClusterBytes - 1) / c.l.ClusterBytes
	first := c.next
	for i := int64(0); i < clusters; i++ {
		cluster := first + uint32(i)
		c.setBit(cluster, true)
		if !contiguous {
			next := uint32(endOfChain)
			if i < clusters-1 {
				next = cluster + 1
			}
			c.fatEntry(cluster, next)
		}
	}
	c.next += uint32(clusters)
	if folder {
		c.dirs[first] = 0
	}

	units := utf16.Encode([]rune(name))
	names := (len(units) + 14) / 15
	set := make([]byte, 32*(2+names))
	set[0] = 0x85
	set[1] = byte(1 + names)
	attributes := uint16(0x20)
	if folder {
		attributes = 0x10
	}
	binary.LittleEndian.PutUint16(set[4:], attributes)
	stream := set[32:64]
	stream[0] = 0xc0
	stream[1] = 0x01
	if contiguous {
		stream[1] |= 0x02
	}
	stream[3] = byte(len(units))
	binary.LittleEndian.PutUint16(stream[4:], nameHash(units, expandUpcase(UpcaseTable())))
	binary.LittleEndian.PutUint64(stream[8:], uint64(size))
	binary.LittleEndian.PutUint32(stream[20:], first)
	binary.LittleEndian.PutUint64(stream[24:], uint64(size))
	for i := 0; i < names; i++ {
		entry := set[64+32*i : 96+32*i]
		entry[0] = 0xc1
		for j := 0; j < 15 && i*15+j < len(units); j++ {
			binary.LittleEndian.PutUint16(entry[2+2*j:], units[i*15+j])
		}
	}
	binary.LittleEndian.PutUint16(set[2:], setChecksum(set))
	offset := c.dirs[parent]
	c.write(c.sector(parent)*BytesPerSector+int64(offset), set)
	c.dirs[parent] = offset + len(set)
	return first
}

func (c *card) root() uint32 { return uint32(c.l.RootCluster) }

// withFiles is a card holding what a recorder leaves: a folder of clips, one with a FAT chain.
func withFiles(t *testing.T) (*card, uint32) {
	c := newCard(t)
	folder := c.add(c.root(), "OWL_01", 4096, false, true)
	clip := c.add(folder, "Activation_0001_clip.wav", 60_000, false, false)
	c.add(folder, "Activation_0002_clip.wav", 90_000, true, false)
	c.add(c.root(), "_conf.a3m", 300, false, false)
	return c, clip
}

func check(t *testing.T, c *card) CheckReport {
	t.Helper()
	report, err := Check(c.dev, nil)
	if err != nil {
		t.Fatal(err)
	}
	return report
}

func kinds(report CheckReport) []string {
	var out []string
	for _, f := range report.Findings {
		out = append(out, f.Kind)
	}
	return out
}

func digest(t *testing.T, dev blockdev.Device) [32]byte {
	data, err := blockdev.ReadAll(dev, int(dev.Size()), 0)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(data)
}

func TestAFreshCardIsClean(t *testing.T) {
	report := check(t, newCard(t))
	if !report.Clean || report.Label != "A3EM" {
		t.Fatalf("a freshly formatted card should be clean: %+v", report)
	}
}

func TestACardWithFilesIsClean(t *testing.T) {
	c, _ := withFiles(t)
	report := check(t, c)
	if !report.Clean {
		t.Fatalf("a consistent card should be clean: %+v", report.Findings)
	}
	if report.Files != 3 || report.Directories != 1 {
		t.Errorf("files %d, directories %d; want 3 and 1", report.Files, report.Directories)
	}
}

func TestSpaceInUseMarkedFreeIsFoundAndRepaired(t *testing.T) {
	c, clip := withFiles(t)
	c.setBit(clip+3, false)
	c.setBit(clip+4, false)
	report := check(t, c)
	if len(report.Findings) != 1 || report.Findings[0].Kind != "bitmap-free" || report.Findings[0].Count != 2 {
		t.Fatalf("want one bitmap-free finding of 2 clusters: %+v", report.Findings)
	}
	if got := report.Findings[0].Paths; len(got) != 1 || got[0] != "OWL_01/Activation_0001_clip.wav" {
		t.Errorf("the affected recording should be named: %v", got)
	}
	if !report.FixableHere || strings.Join(report.Repairs, ",") != "bitmap" {
		t.Fatalf("want fixable here by a bitmap rebuild: %+v", report)
	}
	saved := t.TempDir()
	result, err := Repair(c.dev, saved)
	if err != nil {
		t.Fatal(err)
	}
	if !result.After.Clean || len(result.Repaired) != 1 || len(result.Saved) != 1 {
		t.Fatalf("the repair should leave the card clean and save the old bitmap: %+v", result)
	}
	if _, err := os.Stat(result.Saved[0]); err != nil {
		t.Errorf("the old bitmap should be saved: %v", err)
	}
	if boot := c.read(PartitionStartSector, 1); boot[106]&0x02 != 0 {
		t.Error("the volume should be marked cleanly unmounted after the repair")
	}
	if !bootRegionOK(c.read(PartitionStartSector, 12)) {
		t.Error("marking the volume clean must not break the boot checksum")
	}
}

func TestSpaceMarkedInUseThatNothingUsesIsMinor(t *testing.T) {
	c, _ := withFiles(t)
	c.setBit(c.next+100, true)
	report := check(t, c)
	if strings.Join(kinds(report), ",") != "bitmap-lost" || report.Findings[0].Severity != "minor" {
		t.Fatalf("want one minor bitmap-lost finding: %+v", report.Findings)
	}
	if result, err := Repair(c.dev, t.TempDir()); err != nil || !result.After.Clean {
		t.Fatalf("the rebuild should free it: %+v %v", result, err)
	}
}

func TestADamagedMainBootRegionIsRestoredFromItsBackup(t *testing.T) {
	c, _ := withFiles(t)
	c.write((PartitionStartSector+11)*BytesPerSector, make([]byte, BytesPerSector))
	report := check(t, c)
	if strings.Join(kinds(report), ",") != "boot-region" || !report.FixableHere {
		t.Fatalf("want a fixable boot-region finding: %+v", report.Findings)
	}
	result, err := Repair(c.dev, t.TempDir())
	if err != nil || !result.After.Clean {
		t.Fatalf("the backup should restore it: %+v %v", result, err)
	}
	if !bootRegionOK(c.read(PartitionStartSector, 12)) {
		t.Error("the main boot region should be intact again")
	}
}

func TestADamagedBackupBootRegionIsMinor(t *testing.T) {
	c := newCard(t)
	c.write((PartitionStartSector+23)*BytesPerSector, make([]byte, BytesPerSector))
	report := check(t, c)
	if strings.Join(kinds(report), ",") != "boot-backup" || report.Findings[0].Severity != "minor" {
		t.Fatalf("want a minor boot-backup finding: %+v", report.Findings)
	}
	if result, err := Repair(c.dev, t.TempDir()); err != nil || !result.After.Clean {
		t.Fatalf("the main copy should restore the backup: %+v %v", result, err)
	}
}

func TestSharedClustersAreNotRepairedHere(t *testing.T) {
	c, clip := withFiles(t)
	// A second file that starts in the middle of the first one.
	shared := c.next
	c.add(c.root(), "stray.wav", 8192, true, false)
	stream := make([]byte, 4)
	binary.LittleEndian.PutUint32(stream, clip+2)
	// Point the new file's stream extension at the clip's clusters, and fix its checksum.
	offset := c.sector(c.root())*BytesPerSector + int64(c.dirs[c.root()]) - 96
	set := c.read(offset/BytesPerSector, 1)[offset%BytesPerSector : offset%BytesPerSector+96]
	set = bytes.Clone(set)
	copy(set[32+20:], stream)
	binary.LittleEndian.PutUint16(set[2:], setChecksum(set))
	c.write(offset, set)
	c.setBit(shared, false)
	c.setBit(shared+1, false)

	report := check(t, c)
	if !strings.Contains(strings.Join(kinds(report), ","), "cross-link") || report.FixableHere {
		t.Fatalf("want a cross-link, not fixable here: %+v", report.Findings)
	}
	before := digest(t, c.dev)
	if _, err := Repair(c.dev, t.TempDir()); !errors.Is(err, ErrNotFixableHere) {
		t.Fatalf("the repair should refuse: %v", err)
	}
	if digest(t, c.dev) != before {
		t.Error("a refused repair must change nothing")
	}
}

func TestAChainThatEndsEarlyIsFound(t *testing.T) {
	c, clip := withFiles(t)
	c.fatEntry(clip+5, endOfChain)
	report := check(t, c)
	found := false
	for _, f := range report.Findings {
		if f.Kind == "chain" && strings.Contains(f.Message, "ends early") && f.Paths[0] == "OWL_01/Activation_0001_clip.wav" {
			found = true
		}
	}
	if !found || report.FixableHere {
		t.Fatalf("want an 'ends early' finding naming the clip, not fixable here: %+v", report.Findings)
	}
}

func TestAChainThatLoopsEnds(t *testing.T) {
	c, clip := withFiles(t)
	c.fatEntry(clip+5, clip+1)
	report := check(t, c)
	if !strings.Contains(strings.Join(kinds(report), ","), "cross-link") {
		t.Fatalf("a loop should be found, and the check should end: %+v", report.Findings)
	}
}

func TestADamagedEntryIsFound(t *testing.T) {
	c, _ := withFiles(t)
	// Change one letter of the configuration's name without its checksum.
	offset := c.sector(c.root())*BytesPerSector + int64(c.dirs[c.root()]) - 32 + 2
	c.write(offset, []byte{'X'})
	report := check(t, c)
	if !strings.Contains(strings.Join(kinds(report), ","), "entry") || report.FixableHere {
		t.Fatalf("want a damaged entry, not fixable here: %+v", report.Findings)
	}
}

func TestStopping(t *testing.T) {
	c, _ := withFiles(t)
	if _, err := Check(c.dev, func() bool { return true }); !errors.Is(err, ErrStopped) {
		t.Fatalf("want ErrStopped, got %v", err)
	}
}

func TestAMinorFindingWithNoRepairHereIsNotFixableHere(t *testing.T) {
	c, _ := withFiles(t)
	// Change the configuration's name hash, and put the set's checksum right, so only the hash is off.
	offset := c.sector(c.root())*BytesPerSector + int64(c.dirs[c.root()]) - 96
	set := bytes.Clone(c.read(offset/BytesPerSector, 1)[offset%BytesPerSector : offset%BytesPerSector+96])
	set[32+4] ^= 0xff
	binary.LittleEndian.PutUint16(set[2:], setChecksum(set))
	c.write(offset, set)
	report := check(t, c)
	if strings.Join(kinds(report), ",") != "name-hash" || report.Findings[0].Severity != "minor" {
		t.Fatalf("want one minor name-hash finding: %+v", report.Findings)
	}
	if report.FixableHere || len(report.Repairs) != 0 {
		t.Fatalf("nothing here repairs a name hash, so it is not fixable here: %+v", report)
	}
}

func TestTheFilesAMisMarkedRegionTouchesAreCounted(t *testing.T) {
	c := newCard(t)
	var first []uint32
	for i := 0; i < maxPaths+5; i++ {
		first = append(first, c.add(c.root(), fmt.Sprintf("clip_%02d.wav", i), 4096, true, false))
	}
	for _, cluster := range first {
		c.setBit(cluster, false)
	}
	report := check(t, c)
	if len(report.Findings) != 1 {
		t.Fatalf("want one finding: %+v", report.Findings)
	}
	f := report.Findings[0]
	if len(f.Paths) != maxPaths || f.Files != maxPaths+5 {
		t.Fatalf("want %d named of %d files: %d named, %d counted", maxPaths, maxPaths+5, len(f.Paths), f.Files)
	}
	if !strings.Contains(f.Message, "25 files use") {
		t.Errorf("the message should count the files: %s", f.Message)
	}
}

func TestSavedRepairsAreLetGoOfInTime(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.Local)
	defer func(limit int64) { maxSaved = limit }(maxSaved)
	maxSaved = 256
	write := func(name string, size int) {
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("2026-08-01 090000 allocation bitmap.bin", 10)  // older than 30 days
	write("2026-09-20 090000 allocation bitmap.bin", 200) // recent, but the oldest of two over the cap
	write("2026-09-24 090000 allocation bitmap.bin", 100)
	write("2026-09-24 100000 boot region.bin", 10)
	write("notes.txt", 10)          // not the helper's
	write("2026-09-24 bad.bin", 10) // not named as a repair names them
	PruneSaved(dir, now)
	var left []string
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		left = append(left, entry.Name())
	}
	want := []string{"2026-09-24 090000 allocation bitmap.bin", "2026-09-24 100000 boot region.bin", "2026-09-24 bad.bin", "notes.txt"}
	if strings.Join(left, "|") != strings.Join(want, "|") {
		t.Fatalf("left %q, want %q", left, want)
	}
}
