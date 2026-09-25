package exfat

import (
	"encoding/binary"
	"path"
	"regexp"
	"strconv"
	"strings"
)

/*
	What the recorder wrote past a file's recorded end.

	The recorder's FatFs records a file's length only when it syncs or closes the file, while
	what it writes reaches the card a sector at a time as it goes. Power lost in between leaves
	data on the card beyond the length its directory entry gives:

	  - a log (a3em.log) is synced after each event, so what follows its recorded end is the
	    lines written since: in the rest of its last cluster, and in any clusters after it
	    that are marked in use but that no file owns;
	  - an IMU file is synced only when it is closed, so a clip cut short leaves it with
	    nothing recorded at all, and its data in unowned clusters that begin with its own
	    header: the sample rate, and the time of its first sample, which names the file.

	This finds those bytes and hands them over; it does not judge them. Space past a file's end
	can as easily hold what was there before the card was last formatted, and it is the
	dashboard — which knows what a log line and an IMU sample look like — that keeps only what
	it can show belongs, and adds that to the file's copy. Nothing here writes to the card.
*/

// Tail is what the card holds past where a log's or IMU file's recorded length ends.
type Tail struct {
	Path string `json:"path"`
	// Kind is "log" or "imu".
	Kind          string `json:"kind"`
	RecordedBytes int64  `json:"recordedBytes"`
	// Before is the end of what is recorded, for a log, to read what follows against.
	Before []byte `json:"before,omitempty"`
	// Data starts where the recorded file ends: for a log, at its recorded length; for an IMU
	// file with nothing recorded, at the start of the unowned space its header names it in.
	Data []byte `json:"data"`
	// InFileBytes is how much of Data lies in the file's own last cluster. The rest is in space
	// no file owns, which rebuilding the record of space in use frees.
	InFileBytes int64 `json:"inFileBytes,omitempty"`
}

const (
	// Enough for what a log writes between syncs, many times over.
	maxTailBytes = 256 << 10
	// An IMU clip's worth at the highest rate the recorder writes, for a clip of a few minutes.
	maxRecoveryBytes = 512 << 10
	// All of them together, within one native message once encoded.
	maxTailsBytes = 600 << 10
	beforeBytes   = 4 << 10
	// How long after the time a file is named for its first sample can be.
	imuStartWindow = 60
	imuHeaderBytes = 8
	// How many unowned clusters' first sectors are read looking for an IMU header: a clip cut
	// short leaves a few hundred; far more is a card whose record of space is otherwise wrong.
	maxProbes = 20_000
)

var logName = regexp.MustCompile(`^a3em(\.\d+)?\.log$`)

// recordedFile is a log, as its directory entry records it.
type recordedFile struct {
	path       string
	length     int64
	extents    []extent
	contiguous bool
}

// noteFile keeps what tails() needs to know about a file the walk has just read.
func (v *volume) noteFile(path string, length uint64, flags byte, extents []extent) {
	name := strings.ToLower(pathBase(path))
	switch {
	case logName.MatchString(name) && flags&0x01 != 0 && length > 0 && len(extents) > 0:
		v.logs = append(v.logs, recordedFile{path, int64(length), extents, flags&0x02 != 0})
	case strings.HasSuffix(name, ".imu") && length < imuHeaderBytes:
		v.emptyIMU = append(v.emptyIMU, path)
	}
}

func pathBase(p string) string { return path.Base(p) }

// lost is a cluster marked in use that no file owns.
func (v *volume) lost(cluster uint32) bool {
	index := int64(cluster) - 2
	if index < 0 || index >= v.clusterCount || index>>3 >= int64(len(v.onCard)) {
		return false
	}
	marked := v.onCard[index>>3]&(1<<(index&7)) != 0
	return marked && !v.isUsed(cluster)
}

// continuation is the cluster a file would go on into after this one: the next one along for a
// contiguous file, else the FAT's next where it names one, else the next one along, which is
// where the recorder's FatFs allocates when the FAT has not yet been written.
func (v *volume) continuation(cluster uint32, contiguous bool) uint32 {
	if !contiguous {
		if next, err := v.fat.next(cluster); err == nil && v.valid(next) {
			return next
		}
	}
	return cluster + 1
}

// fileCluster is the cluster holding a file's index-th cluster of data.
func fileCluster(extents []extent, index int64) (uint32, bool) {
	for _, e := range extents {
		if index < e.count {
			return uint32(e.first + index), true
		}
		index -= e.count
	}
	return 0, false
}

// readFile reads a stretch of a file's recorded data, within its clusters.
func (v *volume) readFile(extents []extent, offset, length int64) ([]byte, error) {
	var out []byte
	for length > 0 {
		cluster, ok := fileCluster(extents, offset/v.clusterBytes)
		if !ok {
			break
		}
		data, err := v.readCluster(cluster)
		if err != nil {
			return nil, err
		}
		within := offset % v.clusterBytes
		n := min(length, v.clusterBytes-within)
		out = append(out, data[within:within+n]...)
		offset += n
		length -= n
	}
	return out, nil
}

func (v *volume) tails() ([]Tail, error) {
	var tails []Tail
	total := 0
	room := func(limit int) int { return min(limit, maxTailsBytes-total) }

	for _, f := range v.logs {
		if room(maxTailBytes) <= 0 {
			break
		}
		last := uint32(f.extents[len(f.extents)-1].first + f.extents[len(f.extents)-1].count - 1)
		var data []byte
		if within := f.length % v.clusterBytes; within != 0 {
			cluster, err := v.readCluster(last)
			if err != nil {
				return nil, err
			}
			data = append(data, cluster[within:]...)
		}
		inFile := int64(len(data))
		for next := v.continuation(last, f.contiguous); v.lost(next) && len(data) < room(maxTailBytes); next = v.continuation(next, f.contiguous) {
			cluster, err := v.readCluster(next)
			if err != nil {
				return nil, err
			}
			data = append(data, cluster...)
		}
		data = data[:min(len(data), room(maxTailBytes))]
		if len(data) == 0 {
			continue
		}
		start := max(0, f.length-beforeBytes)
		before, err := v.readFile(f.extents, start, f.length-start)
		if err != nil {
			return nil, err
		}
		tails = append(tails, Tail{Path: f.path, Kind: "log", RecordedBytes: f.length, Before: before, Data: data, InFileBytes: min(inFile, int64(len(data)))})
		total += len(data)
	}

	// Only asked where there is an IMU file with nothing recorded, and only of the first sector
	// of each unowned cluster: where a header naming the file's time would be. Its data may sit
	// anywhere among them, since the clip's audio file was growing at the same time.
	byTime := map[uint32]string{}
	for _, p := range v.emptyIMU {
		if t, err := strconv.ParseUint(strings.TrimSuffix(strings.ToLower(pathBase(p)), ".imu"), 10, 32); err == nil && t > 0 {
			byTime[uint32(t)] = p
		}
	}
	le := binary.LittleEndian
	probes := 0
	for _, run := range v.lostRuns {
		for c := run.first; c < run.first+run.count && len(byTime) > 0 && probes < maxProbes && room(maxRecoveryBytes) > 0; c++ {
			probes++
			head, err := readSectors(v.dev, v.clusterSector(uint32(c)), 1)
			if err != nil {
				return nil, err
			}
			rate, first := le.Uint32(head[0:]), le.Uint32(head[4:])
			if rate == 0 || rate > 1000 {
				continue
			}
			for t, p := range byTime {
				if first < t || first-t > imuStartWindow {
					continue
				}
				// From its header on, while the space stays unowned: the dashboard decides how
				// much of it is the file's.
				var data []byte
				for next := c; next < run.first+run.count && len(data) < room(maxRecoveryBytes); next++ {
					cluster, err := v.readCluster(uint32(next))
					if err != nil {
						return nil, err
					}
					data = append(data, cluster...)
				}
				data = data[:min(len(data), room(maxRecoveryBytes))]
				tails = append(tails, Tail{Path: p, Kind: "imu", Data: data})
				total += len(data)
				delete(byTime, t)
				break
			}
		}
	}
	return tails, nil
}
