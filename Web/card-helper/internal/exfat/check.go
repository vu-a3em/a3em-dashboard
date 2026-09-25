package exfat

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
)

/*
	Checking an exFAT card's filesystem, without the operating system's tools.

	fsck_exfat, exfatprogs and chkdsk each find different things — exfatprogs does not report
	space marked in use that nothing uses, which fsck_exfat does — and one of them may not be
	installed at all. This reads the card itself, the same on every platform, and reports in
	terms the dashboard can act on: which recordings a problem touches, not a tool's log.

	What it checks, following Microsoft's exFAT specification:

	  - both boot regions: signature, geometry, and the checksum sector;
	  - the up-case table's checksum;
	  - every directory entry set: its checksum and its name's hash;
	  - every file's cluster chain: in range, not looping, as long as the file, and not shared
	    with another file;
	  - the allocation bitmap against what the files actually use, both ways: space marked free
	    that a file uses — which new recordings would overwrite — and space marked in use that
	    nothing uses.

	It only reads. Each finding says whether this helper can repair it (repair.go); the rest
	are for the system's own tool, or for an image and a recovery program.
*/

// Finding is one thing wrong with a card's filesystem.
type Finding struct {
	Kind string `json:"kind"`
	// Severity is "problem" — the card may lose recordings or not open — or "minor".
	Severity string   `json:"severity"`
	Message  string   `json:"message"`
	Paths    []string `json:"paths,omitempty"`
	// Files is how many files it touches, when that is more than Paths names.
	Files int   `json:"files,omitempty"`
	Count int64 `json:"count,omitempty"`
	// Repair is what fixes it here: "bitmap" or "boot". Empty when this helper cannot.
	Repair string `json:"repair,omitempty"`
}

// CheckReport is a card's filesystem, checked.
type CheckReport struct {
	Clean    bool      `json:"clean"`
	Findings []Finding `json:"findings"`
	// Repairs is what would fix every finding that has a fix here, in the order to apply them.
	Repairs []string `json:"repairs,omitempty"`
	// FixableHere is whether those repairs fix every problem, so no other tool is needed.
	FixableHere bool   `json:"fixableHere"`
	Label       string `json:"label,omitempty"`
	Files       int    `json:"files"`
	Directories int    `json:"directories"`
	// NotExFAT is a card this checker cannot read: no exFAT volume where one should be.
	NotExFAT bool `json:"notExfat,omitempty"`
	// Tails is what logs and IMU files may hold past their recorded end (see tails.go).
	Tails []Tail `json:"tails,omitempty"`
}

// maxPaths is how many affected files a finding names.
const maxPaths = 20

// volume is what the checker and the repairs know about one exFAT volume on a card.
type volume struct {
	dev                blockdev.Device
	start              int64 // the volume's first sector on the card
	bytesPerSector     int64
	sectorsPerCluster  int64
	clusterBytes       int64
	fatOffset          int64 // sectors, from the volume's start
	fatLength          int64
	heapOffset         int64
	clusterCount       int64
	rootCluster        uint32
	volumeFlags        uint16
	mainOK, backupOK   bool
	mainRaw, backupRaw []byte // the two boot regions as read, twelve sectors each

	fat  *fatReader
	used []byte // one bit per cluster, from cluster 2, of what the files use

	bitmapCluster uint32
	bitmapLength  int64
	upcase        []uint16

	files    []fileExtents
	findings []Finding
	files_   int
	dirs     int
	label    string
	crossed  map[string]bool // files already reported for sharing clusters, so each is named once
	stop     func() bool

	// For what the recorder wrote past files' recorded ends (tails.go).
	logs     []recordedFile
	emptyIMU []string
	onCard   []byte   // the allocation bitmap as the card has it
	lostRuns []extent // runs of clusters marked in use that no file owns
}

type extent struct{ first, count int64 }

// fileExtents is where one file's clusters are, for naming the files a problem touches.
type fileExtents struct {
	path    string
	extents []extent
}

// ErrStopped is returned when a check was stopped before it finished.
var ErrStopped = errors.New("the check was stopped")

// Check reads the card's exFAT volume and reports what is wrong with it. stop, when not nil,
// is asked now and then whether to give up.
func Check(dev blockdev.Device, stop func() bool) (CheckReport, error) {
	v, report, err := open(dev)
	if err != nil || report.NotExFAT {
		return report, err
	}
	v.stop = stop
	if err := v.walk(); err != nil {
		return CheckReport{}, err
	}
	if err := v.compareBitmap(); err != nil {
		return CheckReport{}, err
	}
	report = v.report()
	tails, err := v.tails()
	if err != nil {
		return CheckReport{}, err
	}
	report.Tails = tails
	return report, nil
}

// open finds the volume, reads both boot regions, and checks them.
func open(dev blockdev.Device) (*volume, CheckReport, error) {
	v := &volume{dev: dev, bytesPerSector: BytesPerSector, crossed: map[string]bool{}}
	mbr, err := readSectors(dev, 0, 1)
	if err != nil {
		return nil, CheckReport{}, err
	}
	switch {
	case isExfatBoot(mbr):
		// A card formatted with no partition table: the volume starts at the first sector.
		v.start = 0
	case mbr[0x1fe] == 0x55 && mbr[0x1ff] == 0xaa && binary.LittleEndian.Uint32(mbr[0x1be+8:]) != 0:
		v.start = int64(binary.LittleEndian.Uint32(mbr[0x1be+8:]))
	default:
		return nil, CheckReport{NotExFAT: true, Findings: []Finding{{Kind: "no-volume", Severity: "problem",
			Message: "The card has no partition table and no exFAT volume."}}}, nil
	}
	main, err := readSectors(dev, v.start, 12)
	if err != nil {
		return nil, CheckReport{}, err
	}
	backup, err := readSectors(dev, v.start+12, 12)
	if err != nil {
		return nil, CheckReport{}, err
	}
	v.mainRaw, v.backupRaw = main, backup
	v.mainOK, v.backupOK = bootRegionOK(main), bootRegionOK(backup)
	if !isExfatBoot(main) && !isExfatBoot(backup) {
		return nil, CheckReport{NotExFAT: true, Findings: []Finding{{Kind: "not-exfat", Severity: "problem",
			Message: "The card's partition does not hold an exFAT volume, so this check cannot read it."}}}, nil
	}
	boot := main
	switch {
	case !v.mainOK && v.backupOK:
		boot = backup
		v.add(Finding{Kind: "boot-region", Severity: "problem", Repair: "boot",
			Message: "The main boot region, which describes the card's layout, is damaged, so the card may not open. Its backup copy is intact and can replace it."})
	case v.mainOK && !v.backupOK:
		v.add(Finding{Kind: "boot-backup", Severity: "minor", Repair: "boot",
			Message: "The backup copy of the boot region is damaged. The main one is intact, and can replace it."})
	case !v.mainOK && !v.backupOK:
		v.add(Finding{Kind: "boot-region", Severity: "problem",
			Message: "Both copies of the boot region, which describes the card's layout, are damaged. The card needs a recovery tool; copy it to an image file first."})
		if !isExfatBoot(main) {
			boot = backup
		}
	case !sameBoot(main, backup):
		v.add(Finding{Kind: "boot-backup", Severity: "minor", Repair: "boot",
			Message: "The two copies of the boot region disagree. The main one is intact, and can replace the backup."})
	}
	le := binary.LittleEndian
	shift := int(boot[0x6c])
	v.bytesPerSector = 1 << shift
	v.sectorsPerCluster = 1 << int(boot[0x6d])
	v.clusterBytes = v.bytesPerSector * v.sectorsPerCluster
	v.fatOffset = int64(le.Uint32(boot[0x50:]))
	v.fatLength = int64(le.Uint32(boot[0x54:]))
	v.heapOffset = int64(le.Uint32(boot[0x58:]))
	v.clusterCount = int64(le.Uint32(boot[0x5c:]))
	v.rootCluster = le.Uint32(boot[0x60:])
	v.volumeFlags = le.Uint16(boot[0x6a:])
	if shift != 9 || v.clusterCount < 1 || v.rootCluster < 2 || int64(v.rootCluster) > v.clusterCount+1 ||
		v.fatOffset < 24 || v.heapOffset < v.fatOffset+v.fatLength || v.fatLength*v.bytesPerSector < (v.clusterCount+2)*4 {
		return nil, CheckReport{NotExFAT: true, Findings: append(v.findings, Finding{Kind: "geometry", Severity: "problem",
			Message: "The boot region describes a layout that cannot be right, so this check cannot read the card."})}, nil
	}
	v.fat = &fatReader{dev: dev, first: v.start + v.fatOffset, blocks: map[int64][]byte{}}
	v.used = make([]byte, (v.clusterCount+7)/8)
	return v, CheckReport{}, nil
}

func isExfatBoot(sector []byte) bool {
	return len(sector) >= 512 && bytes.Equal(sector[3:11], []byte("EXFAT   ")) && sector[0x1fe] == 0x55 && sector[0x1ff] == 0xaa
}

// bootRegionOK is a boot region whose boot sector is exFAT's and whose checksum sector agrees.
func bootRegionOK(region []byte) bool {
	if len(region) < 12*BytesPerSector || !isExfatBoot(region) {
		return false
	}
	want := bootChecksum(region[:11*BytesPerSector])
	for offset := 11 * BytesPerSector; offset < 12*BytesPerSector; offset += 4 {
		if binary.LittleEndian.Uint32(region[offset:]) != want {
			return false
		}
	}
	return true
}

// sameBoot compares two boot regions, apart from the flags and usage that change with use.
func sameBoot(a, b []byte) bool {
	x, y := bytes.Clone(a), bytes.Clone(b)
	for _, i := range []int{106, 107, 112} {
		x[i], y[i] = 0, 0
	}
	return bytes.Equal(x[:11*BytesPerSector], y[:11*BytesPerSector])
}

func (v *volume) add(f Finding) { v.findings = append(v.findings, f) }

func (v *volume) clusterSector(cluster uint32) int64 {
	return v.start + v.heapOffset + int64(cluster-2)*v.sectorsPerCluster
}

func (v *volume) readCluster(cluster uint32) ([]byte, error) {
	return readSectors(v.dev, v.clusterSector(cluster), v.sectorsPerCluster)
}

func (v *volume) valid(cluster uint32) bool {
	return cluster >= 2 && int64(cluster) <= v.clusterCount+1
}

func (v *volume) isUsed(cluster uint32) bool {
	index := int64(cluster - 2)
	return v.used[index>>3]&(1<<(index&7)) != 0
}

func (v *volume) markUsed(cluster uint32) {
	index := int64(cluster - 2)
	v.used[index>>3] |= 1 << (index & 7)
}

// fatReader reads the FAT a megabyte at a time, as chains are followed.
type fatReader struct {
	dev    blockdev.Device
	first  int64 // sector
	blocks map[int64][]byte
}

const fatBlock = 1 << 20

func (f *fatReader) next(cluster uint32) (uint32, error) {
	offset := int64(cluster) * 4
	block := offset / fatBlock
	data, ok := f.blocks[block]
	if !ok {
		var err error
		data, err = blockdev.ReadAll(f.dev, fatBlock, f.first*BytesPerSector+block*fatBlock)
		if err != nil {
			return 0, err
		}
		if len(f.blocks) > 64 {
			f.blocks = map[int64][]byte{}
		}
		f.blocks[block] = data
	}
	return binary.LittleEndian.Uint32(data[offset%fatBlock:]), nil
}

const endOfChain = 0xffffffff
const badCluster = 0xfffffff7

/*
chain follows one file's clusters, marks them used, and reports what is wrong with them.
Returns the clusters in order for a directory, whose contents are read next, and the
extents for naming the file later.
*/
func (v *volume) chain(path string, first uint32, length uint64, contiguous bool, keep bool) ([]uint32, []extent, error) {
	if length == 0 {
		return nil, nil, nil
	}
	needed := (int64(length) + v.clusterBytes - 1) / v.clusterBytes
	if !v.valid(first) {
		v.add(Finding{Kind: "chain", Severity: "problem", Paths: []string{path},
			Message: fmt.Sprintf("%s says it starts at a place on the card that does not exist.", path)})
		return nil, nil, nil
	}
	var clusters []uint32
	var extents []extent
	// claim marks a cluster this file's, or reports that something else already has it — which
	// is also how a chain that loops back on itself shows up, so the walk stops there.
	claim := func(cluster uint32) bool {
		if v.isUsed(cluster) {
			if !v.crossed[path] {
				v.crossed[path] = true
				owner := v.ownerOf(cluster)
				if owner == "" && containsCluster(extents, cluster) {
					owner = path
				}
				message := fmt.Sprintf("%s and %s claim the same part of the card, so at least one of them is damaged.", path, nonEmpty(owner, "another file"))
				if owner == path {
					message = fmt.Sprintf("%s's chain of clusters loops back on itself, so part of it cannot be found.", path)
				}
				v.add(Finding{Kind: "cross-link", Severity: "problem", Paths: uniq([]string{path, owner}), Message: message})
			}
			return false
		}
		v.markUsed(cluster)
		if n := len(extents); n > 0 && extents[n-1].first+extents[n-1].count == int64(cluster) {
			extents[n-1].count++
		} else {
			extents = append(extents, extent{int64(cluster), 1})
		}
		if keep {
			clusters = append(clusters, cluster)
		}
		return true
	}
	if contiguous {
		if int64(first)+needed-1 > v.clusterCount+1 {
			v.add(Finding{Kind: "chain", Severity: "problem", Paths: []string{path},
				Message: fmt.Sprintf("%s runs past the end of the card.", path)})
			needed = v.clusterCount + 2 - int64(first)
		}
		for i := int64(0); i < needed; i++ {
			claim(first + uint32(i))
		}
		return clusters, extents, nil
	}
	cluster := first
	for count := int64(0); ; count++ {
		if v.stop != nil && count%65536 == 0 && v.stop() {
			return nil, nil, ErrStopped
		}
		if count >= needed {
			v.add(Finding{Kind: "chain", Severity: "problem", Paths: []string{path},
				Message: fmt.Sprintf("%s's chain of clusters runs on past the end of the file.", path)})
			break
		}
		if !claim(cluster) {
			break
		}
		next, err := v.fat.next(cluster)
		if err != nil {
			return nil, nil, err
		}
		if next == endOfChain {
			if count+1 < needed {
				v.add(Finding{Kind: "chain", Severity: "problem", Paths: []string{path},
					Message: fmt.Sprintf("%s ends early: its chain of clusters stops before the file does, so part of it is missing.", path)})
			}
			break
		}
		if next == badCluster || !v.valid(next) {
			v.add(Finding{Kind: "chain", Severity: "problem", Paths: []string{path},
				Message: fmt.Sprintf("%s's chain of clusters is broken, so part of it cannot be found.", path)})
			break
		}
		cluster = next
	}
	return clusters, extents, nil
}

// walk reads the root directory and everything below it.
func (v *volume) walk() error {
	root, _, err := v.chain("the root folder", v.rootCluster, uint64(1<<40), false, true)
	if err != nil {
		return err
	}
	// The root folder has no length of its own: its chain ends where the FAT says. The "runs on"
	// finding the huge length above cannot produce, and "ends early" is expected, so drop both.
	v.findings = dropRoot(v.findings)
	return v.directory("", root, true, 0)
}

func dropRoot(findings []Finding) []Finding {
	out := findings[:0]
	for _, f := range findings {
		if f.Kind == "chain" && len(f.Paths) == 1 && f.Paths[0] == "the root folder" && strings.Contains(f.Message, "ends early") {
			continue
		}
		out = append(out, f)
	}
	return out
}

func (v *volume) directory(path string, clusters []uint32, root bool, depth int) error {
	if depth > 64 {
		v.add(Finding{Kind: "directory", Severity: "problem", Paths: []string{path}, Message: fmt.Sprintf("%s is nested impossibly deep, which means its folder structure is damaged.", path)})
		return nil
	}
	var data []byte
	for _, cluster := range clusters {
		chunk, err := v.readCluster(cluster)
		if err != nil {
			return err
		}
		data = append(data, chunk...)
	}
	for offset := 0; offset+32 <= len(data); offset += 32 {
		if v.stop != nil && v.stop() {
			return ErrStopped
		}
		entry := data[offset : offset+32]
		kind := entry[0]
		if kind == 0x00 {
			break // the end of the directory
		}
		if kind&0x80 == 0 {
			continue // deleted
		}
		switch kind {
		case 0x81:
			if root {
				v.bitmapCluster = binary.LittleEndian.Uint32(entry[20:])
				v.bitmapLength = int64(binary.LittleEndian.Uint64(entry[24:]))
				if _, _, err := v.chain("the allocation bitmap", v.bitmapCluster, uint64(v.bitmapLength), false, false); err != nil {
					return err
				}
			}
		case 0x82:
			if root {
				if err := v.readUpcase(entry); err != nil {
					return err
				}
			}
		case 0x83:
			if root {
				count := int(entry[1])
				if count > 11 {
					count = 11
				}
				units := make([]uint16, count)
				for i := range units {
					units[i] = binary.LittleEndian.Uint16(entry[2+i*2:])
				}
				v.label = string(utf16.Decode(units))
			}
		case 0x85:
			secondaries := int(entry[1])
			end := offset + 32*(secondaries+1)
			if secondaries < 2 || end > len(data) {
				v.add(Finding{Kind: "entry", Severity: "problem", Paths: []string{nonEmpty(path, "the root folder")},
					Message: fmt.Sprintf("An entry in %s is cut short, so the file it described cannot be read.", nonEmpty(path, "the root folder"))})
				continue
			}
			if err := v.file(path, data[offset:end], depth); err != nil {
				return err
			}
			offset = end - 32
		default:
			// Other critical primary entries (type importance bit clear) are not ones this
			// checker knows; benign ones may be skipped.
			if kind&0x40 == 0 && kind&0x20 == 0 && kind != 0xa0 {
				v.add(Finding{Kind: "entry", Severity: "minor", Paths: []string{nonEmpty(path, "the root folder")},
					Message: fmt.Sprintf("%s holds an entry of a kind this check does not know (0x%02x).", nonEmpty(path, "the root folder"), kind)})
			}
		}
	}
	return nil
}

// file checks one file or folder's entry set, and its clusters.
func (v *volume) file(parent string, set []byte, depth int) error {
	le := binary.LittleEndian
	stream := set[32:64]
	name := entryName(set)
	path := name
	if parent != "" {
		path = parent + "/" + name
	}
	if stream[0] != 0xc0 {
		v.add(Finding{Kind: "entry", Severity: "problem", Paths: []string{path}, Message: fmt.Sprintf("%s is missing the part of its entry that says where it is.", path)})
		return nil
	}
	if le.Uint16(set[2:]) != setChecksum(set) {
		v.add(Finding{Kind: "entry", Severity: "problem", Paths: []string{path},
			Message: fmt.Sprintf("The entry for %s is damaged: its checksum does not match. The system's repair may remove the file.", path)})
	}
	nameLength := int(stream[3])
	units := entryUnits(set)
	if nameLength <= len(units) && v.upcase != nil && le.Uint16(stream[4:]) != nameHash(units[:nameLength], v.upcase) {
		v.add(Finding{Kind: "name-hash", Severity: "minor", Paths: []string{path}, Message: fmt.Sprintf("The recorded hash of %s's name does not match the name.", path)})
	}
	flags := stream[1]
	first := le.Uint32(stream[20:])
	length := le.Uint64(stream[24:])
	directory := le.Uint16(set[4:])&0x10 != 0
	if directory {
		v.dirs++
	} else {
		v.files_++
	}
	if flags&0x01 == 0 {
		if !directory {
			v.noteFile(path, length, flags, nil)
		}
		return nil // no clusters allocated
	}
	clusters, extents, err := v.chain(path, first, length, flags&0x02 != 0, directory)
	if err != nil {
		return err
	}
	v.files = append(v.files, fileExtents{path, extents})
	if !directory {
		v.noteFile(path, length, flags, extents)
	}
	// Vendor allocation entries claim clusters too.
	for offset := 64; offset+32 <= len(set); offset += 32 {
		if set[offset] == 0xe1 {
			if _, _, err := v.chain(path+" (vendor data)", le.Uint32(set[offset+20:]), le.Uint64(set[offset+24:]), set[offset+1]&0x02 != 0, false); err != nil {
				return err
			}
		}
	}
	if directory {
		return v.directory(path, clusters, false, depth+1)
	}
	return nil
}

func entryUnits(set []byte) []uint16 {
	var units []uint16
	for offset := 64; offset+32 <= len(set); offset += 32 {
		if set[offset] != 0xc1 {
			continue
		}
		for i := 0; i < 15; i++ {
			units = append(units, binary.LittleEndian.Uint16(set[offset+2+i*2:]))
		}
	}
	return units
}

func entryName(set []byte) string {
	units := entryUnits(set)
	if length := int(set[32+3]); length <= len(units) {
		units = units[:length]
	}
	name := string(utf16.Decode(units))
	if name == "" {
		return "(a file with no name)"
	}
	return name
}

// setChecksum is the entry set's checksum, skipping the checksum field itself.
func setChecksum(set []byte) uint16 {
	var checksum uint16
	for index, b := range set {
		if index == 2 || index == 3 {
			continue
		}
		checksum = (checksum<<15 | checksum>>1) + uint16(b)
	}
	return checksum
}

func nameHash(units []uint16, upcase []uint16) uint16 {
	var hash uint16
	for _, unit := range units {
		if int(unit) < len(upcase) {
			unit = upcase[unit]
		}
		hash = (hash<<15 | hash>>1) + uint16(unit&0xff)
		hash = (hash<<15 | hash>>1) + uint16(unit>>8)
	}
	return hash
}

// readUpcase reads the up-case table, checks its checksum, and expands it for name hashes.
func (v *volume) readUpcase(entry []byte) error {
	le := binary.LittleEndian
	first := le.Uint32(entry[20:])
	length := le.Uint64(entry[24:])
	if length == 0 || length > 1<<20 {
		v.add(Finding{Kind: "upcase", Severity: "problem", Message: "The up-case table, which the card uses to compare file names, has an impossible size."})
		return nil
	}
	clusters, _, err := v.chain("the up-case table", first, length, false, true)
	if err != nil {
		return err
	}
	var data []byte
	for _, cluster := range clusters {
		chunk, err := v.readCluster(cluster)
		if err != nil {
			return err
		}
		data = append(data, chunk...)
	}
	if uint64(len(data)) < length {
		return nil
	}
	table := data[:length]
	if UpcaseChecksum(table) != le.Uint32(entry[4:]) {
		v.add(Finding{Kind: "upcase", Severity: "problem", Message: "The up-case table, which the card uses to compare file names, is damaged."})
		return nil
	}
	expanded := expandUpcase(table)
	v.upcase = expanded
	return nil
}

// expandUpcase turns an up-case table into one entry per character. In the table, 0xffff and a
// count stand for that many characters that map to themselves.
func expandUpcase(table []byte) []uint16 {
	le := binary.LittleEndian
	expanded := make([]uint16, 0, 65536)
	for i := 0; i+1 < len(table) && len(expanded) < 65536; i += 2 {
		unit := le.Uint16(table[i:])
		if unit == 0xffff && i+3 < len(table) {
			count := int(le.Uint16(table[i+2:]))
			for j := 0; j < count && len(expanded) < 65536; j++ {
				expanded = append(expanded, uint16(len(expanded)))
			}
			i += 2
			continue
		}
		expanded = append(expanded, unit)
	}
	for len(expanded) < 65536 {
		expanded = append(expanded, uint16(len(expanded)))
	}
	return expanded
}

// compareBitmap compares the allocation bitmap on the card with what the files use.
func (v *volume) compareBitmap() error {
	if v.bitmapCluster == 0 {
		v.add(Finding{Kind: "bitmap", Severity: "problem", Message: "The card has no allocation bitmap, its record of which space is in use."})
		return nil
	}
	onCard, err := v.readBitmap()
	if err != nil {
		return err
	}
	var freeInUse, lost int64
	var free []uint32
	for index := int64(0); index < v.clusterCount; index++ {
		if v.stop != nil && index%(1<<24) == 0 && v.stop() {
			return ErrStopped
		}
		used := v.used[index>>3]&(1<<(index&7)) != 0
		marked := index>>3 < int64(len(onCard)) && onCard[index>>3]&(1<<(index&7)) != 0
		switch {
		case used && !marked:
			freeInUse++
			if len(free) < 1_000_000 {
				free = append(free, uint32(index+2))
			}
		case !used && marked:
			lost++
			if n := len(v.lostRuns); n > 0 && v.lostRuns[n-1].first+v.lostRuns[n-1].count == index+2 {
				v.lostRuns[n-1].count++
			} else if n < 100_000 {
				v.lostRuns = append(v.lostRuns, extent{index + 2, 1})
			}
		}
	}
	v.onCard = onCard
	if freeInUse > 0 {
		names, owners := v.owners(free)
		f := Finding{Kind: "bitmap-free", Severity: "problem", Repair: "bitmap", Count: freeInUse, Paths: names,
			Message: fmt.Sprintf("The card's record of which space is in use marks %s that %s as free, so new recordings could be written over %s. That usually happens when a card is taken out, or loses power, while the recorder is writing. Rebuilding the record from the files fixes it; the files themselves are not changed.",
				bytesWord(freeInUse*v.clusterBytes), filesUse(owners), itThem(owners))}
		if owners > len(names) {
			f.Files = owners
		}
		v.add(f)
	}
	if lost > 0 {
		v.add(Finding{Kind: "bitmap-lost", Severity: "minor", Repair: "bitmap", Count: lost,
			Message: fmt.Sprintf("The card's record of which space is in use marks %s as in use that no file uses, so the card holds less than it could. Rebuilding the record from the files frees it.",
				bytesWord(lost*v.clusterBytes))})
	}
	return nil
}

func (v *volume) readBitmap() ([]byte, error) {
	sectors := (v.bitmapLength + v.bytesPerSector - 1) / v.bytesPerSector
	var out []byte
	cluster := v.bitmapCluster
	for int64(len(out)) < sectors*v.bytesPerSector && v.valid(cluster) {
		chunk, err := v.readCluster(cluster)
		if err != nil {
			return nil, err
		}
		out = append(out, chunk...)
		next, err := v.fat.next(cluster)
		if err != nil {
			return nil, err
		}
		if next == endOfChain || next == 0 {
			// A bitmap written without a FAT chain is contiguous.
			cluster++
			continue
		}
		cluster = next
	}
	if int64(len(out)) > v.bitmapLength {
		out = out[:v.bitmapLength]
	}
	return out, nil
}

// ownerOf is the file already holding a cluster, among those walked so far.
func (v *volume) ownerOf(cluster uint32) string {
	for _, file := range v.files {
		if containsCluster(file.extents, cluster) {
			return file.path
		}
	}
	return ""
}

func containsCluster(extents []extent, cluster uint32) bool {
	for _, e := range extents {
		if int64(cluster) >= e.first && int64(cluster) < e.first+e.count {
			return true
		}
	}
	return false
}

func uniq(values []string) []string {
	var out []string
	for _, value := range values {
		if value != "" && (len(out) == 0 || out[len(out)-1] != value) {
			out = append(out, value)
		}
	}
	return out
}

// owners names the files that hold any of these clusters.
// owners is the files using any of the clusters: the first maxPaths of them by name, and how
// many there are in all.
func (v *volume) owners(clusters []uint32) ([]string, int) {
	if len(clusters) == 0 {
		return nil, 0
	}
	sort.Slice(clusters, func(i, j int) bool { return clusters[i] < clusters[j] })
	var names []string
	total := 0
	for _, file := range v.files {
		for _, e := range file.extents {
			i := sort.Search(len(clusters), func(i int) bool { return int64(clusters[i]) >= e.first })
			if i < len(clusters) && int64(clusters[i]) < e.first+e.count {
				if len(names) < maxPaths {
					names = append(names, file.path)
				}
				total++
				break
			}
		}
	}
	return names, total
}

func (v *volume) report() CheckReport {
	r := CheckReport{Findings: v.findings, Label: v.label, Files: v.files_, Directories: v.dirs}
	if r.Findings == nil {
		r.Findings = []Finding{}
	}
	needs := map[string]bool{}
	fixable := true
	for _, f := range r.Findings {
		if f.Repair != "" {
			needs[f.Repair] = true
		} else if f.Severity == "problem" {
			fixable = false
		}
	}
	for _, repair := range []string{"boot", "bitmap"} {
		if needs[repair] {
			r.Repairs = append(r.Repairs, repair)
		}
	}
	r.Clean = len(r.Findings) == 0
	// Fixable here when a repair of this helper's own applies and nothing it cannot fix is a
	// problem: a minor finding with no repair of its own is left as it is.
	r.FixableHere = !r.Clean && fixable && len(r.Repairs) > 0
	return r
}

// bytesWord is a size as the dashboard writes one: decimal, to three figures.
func bytesWord(n int64) string {
	units := []string{"bytes", "kB", "MB", "GB", "TB"}
	value, unit := float64(n), 0
	for value >= 1000 && unit < len(units)-1 {
		value /= 1000
		unit++
	}
	switch {
	case unit == 0:
		return fmt.Sprintf("%d bytes", n)
	case value >= 100:
		return fmt.Sprintf("%.0f %s", value, units[unit])
	case value >= 10:
		return fmt.Sprintf("%.1f %s", value, units[unit])
	}
	return fmt.Sprintf("%.2f %s", value, units[unit])
}

// filesUse is "1 file uses" or "3 files use"; "files use" when none can be named, as where
// only metadata is affected.
func filesUse(n int) string {
	switch n {
	case 0:
		return "the card's own structures use"
	case 1:
		return "1 file uses"
	}
	return fmt.Sprintf("%d files use", n)
}

func itThem(n int) string {
	if n == 1 {
		return "it"
	}
	return "them"
}

func nonEmpty(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
