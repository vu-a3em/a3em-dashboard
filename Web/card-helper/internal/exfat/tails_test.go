package exfat

import (
	"bytes"
	"encoding/binary"
	"strings"
	"testing"
)

// lostCluster marks the next free cluster in use without any file owning it, holding data, as
// the recorder leaves one it wrote to but never recorded.
func (c *card) lostCluster(data []byte) uint32 {
	cluster := c.next
	c.next++
	c.setBit(cluster, true)
	block := make([]byte, c.l.ClusterBytes)
	copy(block, data)
	c.write(c.sector(cluster)*BytesPerSector, block)
	return cluster
}

func TestALogsUnrecordedTailIsHandedOver(t *testing.T) {
	c := newCard(t)
	folder := c.add(c.root(), "OWL_01", 4096, false, true)
	recorded := strings.Repeat("EVT|TICK|t=1788000000,ok\n", 200)[:5000]
	logAt := c.add(folder, "a3em.log", int64(len(recorded)), true, false)
	c.write(c.sector(logAt)*BytesPerSector, []byte(recorded))
	// Written after the last sync: the rest of its second cluster, and one more after it.
	tail := strings.Repeat("EVT|TICK|t=1788000100,late\n", 300)[:8192-5000+4096]
	c.write(c.sector(logAt)*BytesPerSector+5000, []byte(tail[:8192-5000]))
	c.lostCluster([]byte(tail[8192-5000:]))

	report := check(t, c)
	if len(report.Tails) != 1 {
		t.Fatalf("want one tail: %+v", report.Tails)
	}
	got := report.Tails[0]
	if got.Path != "OWL_01/a3em.log" || got.Kind != "log" || got.RecordedBytes != 5000 || got.InFileBytes != 8192-5000 {
		t.Fatalf("tail %+v", got)
	}
	if string(got.Data) != tail {
		t.Fatalf("the data past the recorded end: %d bytes, starting %q", len(got.Data), got.Data[:40])
	}
	if !strings.HasSuffix(recorded, string(got.Before)) || len(got.Before) != 4096 {
		t.Fatalf("before: %d bytes", len(got.Before))
	}
}

func TestAnEmptyIMUFilesDataIsFoundByItsHeader(t *testing.T) {
	c := newCard(t)
	folder := c.add(c.root(), "OWL_01", 4096, false, true)
	c.add(folder, "1788037220.imu", 0, true, false)
	c.add(folder, "1788037300.imu", 0, true, false) // nothing of it reached the card
	// Unowned space with no header, then the empty file's data: its header names its time.
	c.lostCluster(bytes.Repeat([]byte{0x00, 0x49}, 100))
	header := make([]byte, 8)
	binary.LittleEndian.PutUint32(header[0:], 50)
	binary.LittleEndian.PutUint32(header[4:], 1788037221)
	first := c.lostCluster(append(header, bytes.Repeat([]byte{1}, 4000)...))
	c.lostCluster(bytes.Repeat([]byte{2}, 4096))
	// A header whose time is too far from any empty file's.
	binary.LittleEndian.PutUint32(header[4:], 1788039999)
	c.next++
	c.lostCluster(header)

	report := check(t, c)
	if len(report.Tails) != 1 {
		t.Fatalf("want one recovery: %+v", report.Tails)
	}
	got := report.Tails[0]
	if got.Path != "OWL_01/1788037220.imu" || got.Kind != "imu" || len(got.Data) != 2*4096 {
		t.Fatalf("recovery %s %s %d bytes", got.Path, got.Kind, len(got.Data))
	}
	if !bytes.Equal(got.Data[:4], []byte{50, 0, 0, 0}) {
		t.Fatalf("it should start at the header, in cluster %d: % x", first, got.Data[:8])
	}
}

func TestNothingIsHandedOverForFilesWithNothingPastTheirEnd(t *testing.T) {
	c := newCard(t)
	folder := c.add(c.root(), "OWL_01", 4096, false, true)
	// A log ending exactly at a cluster's end, with free space after it, and a closed IMU file.
	c.add(folder, "a3em.log", 4096, true, false)
	c.add(folder, "1788037220.imu", 6008, true, false)
	if report := check(t, c); len(report.Tails) != 0 {
		t.Fatalf("want no tails: %+v", report.Tails)
	}
}
