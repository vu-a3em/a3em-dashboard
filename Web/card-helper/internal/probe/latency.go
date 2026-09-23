package probe

import (
	"crypto/rand"
	"fmt"
	"sort"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
)

// LatencyReport is how long each write took, sequentially, at the size the firmware writes.
//
// The device records into a DMA buffer holding a second or two of audio and writes it out
// while the next fills. A card that occasionally stalls — flash controllers pause to erase and
// remap — for longer than that buffer lasts drops audio, and the firmware's audio_dropped
// counter is how that shows up after the fact. This measures the stalls beforehand. It runs
// through the computer's card reader rather than the device's own bus, so the numbers are
// indicative rather than exact, but a card that stalls here stalls there.
type LatencyReport struct {
	ChunkBytes  int64   `json:"chunkBytes"`
	Chunks      int     `json:"chunks"`
	MBPerSecond float64 `json:"mbPerSecond"`
	MedianMs    float64 `json:"medianMs"`
	P99Ms       float64 `json:"p99Ms"`
	MaxMs       float64 `json:"maxMs"`
	// Verdict is "ok", "slow" (a stall long enough to be worth knowing about) or "stalls"
	// (long enough to drop audio at the highest sample rate).
	Verdict string  `json:"verdict"`
	Seconds float64 `json:"seconds"`
}

const (
	latencyChunk = 512 * 1024 // the firmware's WAV staging buffer
	latencyTotal = 64 * 1024 * 1024
	slowMs       = 500
	stallMs      = 1500
)

// Latency writes latencyTotal bytes in the middle of the card and times each write. It
// overwrites that region, so it only runs on a card about to be formatted.
func Latency(dev blockdev.Device, onProgress Progress) (LatencyReport, error) {
	report := LatencyReport{ChunkBytes: latencyChunk}
	start := dev.Size() / 2 / mib * mib
	if start+latencyTotal > dev.Size() {
		return report, fmt.Errorf("the card is too small to time")
	}
	buffer := blockdev.Aligned(latencyChunk)
	if _, err := rand.Read(buffer); err != nil {
		return report, err
	}
	chunks := latencyTotal / latencyChunk
	durations := make([]float64, 0, chunks)
	began := time.Now()
	for index := 0; index < chunks; index++ {
		t := time.Now()
		if _, err := dev.WriteAt(buffer, start+int64(index)*latencyChunk); err != nil {
			return report, fmt.Errorf("timing writes: %w", err)
		}
		if err := dev.Sync(); err != nil {
			return report, err
		}
		durations = append(durations, float64(time.Since(t).Microseconds())/1000)
		if onProgress != nil {
			onProgress("latency", int64(index+1), int64(chunks))
		}
	}
	report.Seconds = time.Since(began).Seconds()
	report.Chunks = chunks
	report.MBPerSecond = float64(latencyTotal) / 1e6 / report.Seconds
	sorted := append([]float64(nil), durations...)
	sort.Float64s(sorted)
	report.MedianMs = sorted[len(sorted)/2]
	report.P99Ms = sorted[(len(sorted)*99)/100]
	report.MaxMs = sorted[len(sorted)-1]
	switch {
	case report.MaxMs >= stallMs:
		report.Verdict = "stalls"
	case report.MaxMs >= slowMs:
		report.Verdict = "slow"
	default:
		report.Verdict = "ok"
	}
	return report, nil
}
