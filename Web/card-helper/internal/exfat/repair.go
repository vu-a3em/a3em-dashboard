package exfat

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
)

/*
	The two repairs this helper makes itself.

	Each fixes one well-defined thing, and only after Check has shown that it is the whole
	problem:

	  - "bitmap": the allocation bitmap rebuilt from the files, which is what a card pulled
	    while the recorder was writing needs. Only the sectors that change are written, and the
	    card is marked cleanly unmounted.
	  - "boot": whichever copy of the boot region is damaged, replaced by the intact one.

	Neither runs when anything else is wrong. Rebuilding the bitmap from a folder tree that
	could not be read in full would mark a missed recording's space free — worse than leaving
	it — so a card with any problem this helper cannot fix goes to the system's own tool, after
	an image. And whatever is overwritten is saved first, so a repair can be undone.
*/

// ErrNotFixableHere is returned when the card has a problem these repairs do not cover.
var ErrNotFixableHere = errors.New("the card has problems this helper cannot repair")

// RepairResult is what a repair did.
type RepairResult struct {
	Repaired []string `json:"repaired"`
	// Saved are the files holding what was overwritten, for undoing a repair.
	Saved []string    `json:"saved,omitempty"`
	After CheckReport `json:"after"`
}

// Repair checks the card and fixes what the check found, when these repairs fix all of it.
// What is overwritten is saved in saveDir first, which is created if need be.
func Repair(dev blockdev.Device, saveDir string) (RepairResult, error) {
	v, report, err := open(dev)
	if err != nil {
		return RepairResult{}, err
	}
	if report.NotExFAT {
		return RepairResult{}, ErrNotFixableHere
	}
	if err := v.walk(); err != nil {
		return RepairResult{}, err
	}
	if err := v.compareBitmap(); err != nil {
		return RepairResult{}, err
	}
	report = v.report()
	if report.Clean {
		return RepairResult{After: report}, nil
	}
	if !report.FixableHere {
		return RepairResult{}, ErrNotFixableHere
	}
	var result RepairResult
	stamp := time.Now().Format("2006-01-02 150405")
	save := func(what string, data []byte) error {
		if err := os.MkdirAll(saveDir, 0o755); err != nil {
			return err
		}
		path := filepath.Join(saveDir, fmt.Sprintf("%s %s.bin", stamp, what))
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return fmt.Errorf("could not save what the repair replaces, so nothing was changed: %w", err)
		}
		result.Saved = append(result.Saved, path)
		return nil
	}
	for _, repair := range report.Repairs {
		switch repair {
		case "boot":
			if err := v.repairBoot(save); err != nil {
				return result, err
			}
		case "bitmap":
			if err := v.repairBitmap(save); err != nil {
				return result, err
			}
		}
		result.Repaired = append(result.Repaired, repair)
	}
	if err := dev.Sync(); err != nil {
		return result, err
	}
	after, err := Check(dev, nil)
	if err != nil {
		return result, err
	}
	result.After = after
	return result, nil
}

// repairBoot writes the intact boot region over the damaged one.
func (v *volume) repairBoot(save func(string, []byte) error) error {
	switch {
	case !v.mainOK && v.backupOK:
		if err := save("boot region (main, damaged)", v.mainRaw); err != nil {
			return err
		}
		return blockdev.WriteAll(v.dev, v.backupRaw, v.start*BytesPerSector, nil)
	case v.mainOK:
		if err := save("boot region (backup)", v.backupRaw); err != nil {
			return err
		}
		return blockdev.WriteAll(v.dev, v.mainRaw, (v.start+12)*BytesPerSector, nil)
	}
	return ErrNotFixableHere
}

// repairBitmap writes the bitmap the files call for, sector by sector where it differs, and
// marks the volume cleanly unmounted.
func (v *volume) repairBitmap(save func(string, []byte) error) error {
	old, err := v.readBitmap()
	if err != nil {
		return err
	}
	if err := save("allocation bitmap", old); err != nil {
		return err
	}
	want := make([]byte, len(old))
	copy(want, v.used)
	// The bitmap's own clusters and every cluster past the end stay as the files leave them.
	if extra := int64(len(want))*8 - v.clusterCount; extra > 0 {
		for index := v.clusterCount; index < int64(len(want))*8; index++ {
			want[index>>3] &^= 1 << (index & 7)
		}
	}
	// The bitmap's clusters, in order, from the FAT.
	clusters := []uint32{}
	cluster := v.bitmapCluster
	for int64(len(clusters))*v.clusterBytes < int64(len(want)) && v.valid(cluster) {
		clusters = append(clusters, cluster)
		next, err := v.fat.next(cluster)
		if err != nil {
			return err
		}
		if next == endOfChain || next == 0 {
			next = cluster + 1
		}
		cluster = next
	}
	sector := int(v.bytesPerSector)
	for offset := 0; offset < len(want); offset += sector {
		end := offset + sector
		if end > len(want) {
			end = len(want)
		}
		if string(want[offset:end]) == string(old[offset:end]) {
			continue
		}
		index := int64(offset) / v.clusterBytes
		if index >= int64(len(clusters)) {
			return errors.New("the allocation bitmap's clusters could not all be found, so it was not rewritten")
		}
		within := int64(offset) % v.clusterBytes
		block := make([]byte, sector)
		copy(block, want[offset:end])
		if end-offset < sector {
			// The last sector's tail, past the bitmap's length, is kept as it was.
			tail, err := readSectors(v.dev, v.clusterSector(clusters[index])+within/v.bytesPerSector, 1)
			if err != nil {
				return err
			}
			copy(block[end-offset:], tail[end-offset:])
		}
		if err := blockdev.WriteAll(v.dev, block, (v.clusterSector(clusters[index])*v.bytesPerSector)+within, nil); err != nil {
			return err
		}
	}
	// Cleanly unmounted, and how full it is: both outside the boot checksum, so only the main
	// boot sector changes.
	boot, err := readSectors(v.dev, v.start, 1)
	if err != nil {
		return err
	}
	boot[106] &^= 0x02
	var used int64
	for _, b := range v.used {
		for ; b != 0; b &= b - 1 {
			used++
		}
	}
	boot[112] = byte(used * 100 / v.clusterCount)
	return blockdev.WriteAll(v.dev, boot, v.start*BytesPerSector, nil)
}
