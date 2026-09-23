package probe

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
)

// fakeCard claims a capacity it does not have and folds every address back onto what it has,
// which is what the common counterfeit controllers do.
type fakeCard struct {
	blockdev.Device
	claimed, real int64
}

func (f *fakeCard) Size() int64 { return f.claimed }
func (f *fakeCard) WriteAt(p []byte, off int64) (int, error) {
	return f.Device.WriteAt(p, off%f.real)
}
func (f *fakeCard) ReadAt(p []byte, off int64) (int, error) {
	return f.Device.ReadAt(p, off%f.real)
}

// lossyCard discards writes past its real capacity and reads zeros there.
type lossyCard struct {
	blockdev.Device
	claimed, real int64
}

func (l *lossyCard) Size() int64 { return l.claimed }
func (l *lossyCard) WriteAt(p []byte, off int64) (int, error) {
	if off >= l.real {
		return len(p), nil
	}
	return l.Device.WriteAt(p, off)
}
func (l *lossyCard) ReadAt(p []byte, off int64) (int, error) {
	if off >= l.real {
		for i := range p {
			p[i] = 0
		}
		return len(p), nil
	}
	return l.Device.ReadAt(p, off)
}

func sparse(t *testing.T, size int64) blockdev.Device {
	t.Helper()
	path := filepath.Join(t.TempDir(), "card.img")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(size); err != nil {
		t.Fatal(err)
	}
	file.Close()
	dev, err := blockdev.OpenFile(path, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { dev.Close() })
	return dev
}

func TestGenuineCardPasses(t *testing.T) {
	report, err := Capacity(sparse(t, 8<<30), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Genuine || report.Verdict != "genuine" || report.VerifiedBytes != 8<<30 || report.Probes < 64 {
		t.Fatalf("%+v", report)
	}
}

func TestWrappingCounterfeitIsCaught(t *testing.T) {
	// Sold as 64 GB, holds 4 GB.
	card := &fakeCard{Device: sparse(t, 4<<30), claimed: 64 << 30, real: 4 << 30}
	report, err := Capacity(card, nil)
	if err != nil {
		t.Fatal(err)
	}
	if report.Genuine || report.Verdict != "wraps" {
		t.Fatalf("%+v", report)
	}
	if report.VerifiedBytes > 4<<30 {
		t.Fatalf("verified %d bytes of a card holding 4 GiB", report.VerifiedBytes)
	}
}

func TestLossyCounterfeitIsCaught(t *testing.T) {
	card := &lossyCard{Device: sparse(t, 2<<30), claimed: 32 << 30, real: 2 << 30}
	report, err := Capacity(card, nil)
	if err != nil {
		t.Fatal(err)
	}
	if report.Genuine || report.Verdict != "loses-data" || report.VerifiedBytes > 2<<30 {
		t.Fatalf("%+v", report)
	}
}

func TestLatencyReportsEveryWrite(t *testing.T) {
	report, err := Latency(sparse(t, 1<<30), nil)
	if err != nil {
		t.Fatal(err)
	}
	if report.Chunks != 128 || report.MaxMs < report.MedianMs || report.Verdict == "" {
		t.Fatalf("%+v", report)
	}
}
