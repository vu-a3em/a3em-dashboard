// Package probe tests whether a card really holds what it claims, and how steadily it writes.
//
// Counterfeit cards report a capacity they do not have. A 16 GB part sold as 256 GB behaves
// normally until the real capacity is passed, then silently wraps — later writes land on top
// of earlier ones — or throws the data away. On a recorder that is weeks of audio overwritten
// without a single error, discovered only at retrieval. Both behaviors are cheap to catch:
// write a uniquely marked block at many places across the claimed capacity, push the card's
// write cache out, and read every block back. A genuine card returns each block as written; a
// wrapping one returns another position's block; a lossy one returns zeros or garbage.
//
// This is the quick probe, in the spirit of f3probe: tens of megabytes of writes, taking
// seconds to a minute. It does not certify every sector, which would take hours (the full
// write-and-verify of a 128 GB card runs one to two hours), but it catches every counterfeit
// that misreports capacity, which is what counterfeits do. It is destructive, so it only ever
// runs as part of preparing a card that is about to be formatted.
package probe

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"sort"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
)

const (
	probeBlockBytes = 64 * 1024
	spreadProbes    = 64
	flushBytes      = 64 * 1024 * 1024
	mib             = 1024 * 1024
	magic           = "A3EMPRB1"
)

// Failure is one probe that did not read back as written.
type Failure struct {
	Offset int64 `json:"offset"`
	// Kind is "aliased" (another position's block came back: the card wraps), "lost" (zeros
	// or ones: the write was discarded) or "corrupt" (anything else).
	Kind string `json:"kind"`
	// AliasOf is the offset whose block was returned, for an aliased probe.
	AliasOf int64 `json:"aliasOf,omitempty"`
}

// CapacityReport is what the probe found.
type CapacityReport struct {
	ClaimedBytes  int64 `json:"claimedBytes"`
	VerifiedBytes int64 `json:"verifiedBytes"`
	Genuine       bool  `json:"genuine"`
	// Verdict is "genuine", "wraps" (counterfeit: reports more than it holds) or "loses-data".
	Verdict  string    `json:"verdict"`
	Probes   int       `json:"probes"`
	Failures []Failure `json:"failures,omitempty"`
	Seconds  float64   `json:"seconds"`
}

// Progress reports how far a probe or test has got.
type Progress func(stage string, done, total int64)

// positions spreads probes across the claimed capacity: evenly, at every power-of-two boundary
// a wrapping controller might fold at, just below each boundary, and at the very end.
func positions(claimed int64) []int64 {
	set := map[int64]bool{}
	add := func(offset int64) {
		offset = offset / probeBlockBytes * probeBlockBytes
		if offset >= 16*mib && offset+probeBlockBytes <= claimed {
			set[offset] = true
		}
	}
	add(16 * mib)
	for k := int64(1); k <= spreadProbes; k++ {
		add(claimed / (spreadProbes + 1) * k)
	}
	for boundary := int64(256 * mib); boundary < claimed; boundary *= 2 {
		add(boundary)
		add(boundary - probeBlockBytes)
	}
	add(claimed - probeBlockBytes)
	out := make([]int64, 0, len(set))
	for offset := range set {
		out = append(out, offset)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// fill writes a block that could only have come from this run, at this offset.
func fill(block []byte, nonce []byte, offset int64) {
	copy(block, magic)
	copy(block[8:24], nonce)
	binary.LittleEndian.PutUint64(block[24:], uint64(offset))
	state := binary.LittleEndian.Uint64(nonce) ^ uint64(offset) ^ 0x9e3779b97f4a7c15
	for i := 32; i < len(block); i += 8 {
		state ^= state << 13
		state ^= state >> 7
		state ^= state << 17
		binary.LittleEndian.PutUint64(block[i:], state)
	}
}

func overlaps(start, length int64, probes []int64) bool {
	for _, offset := range probes {
		if offset < start+length && start < offset+probeBlockBytes {
			return true
		}
	}
	return false
}

// Capacity runs the quick counterfeit probe. It overwrites data scattered across the card.
func Capacity(dev blockdev.Device, onProgress Progress) (CapacityReport, error) {
	started := time.Now()
	claimed := dev.Size()
	report := CapacityReport{ClaimedBytes: claimed}
	if claimed < 64*mib {
		return report, fmt.Errorf("the card is too small to probe")
	}
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return report, err
	}
	probes := positions(claimed)
	report.Probes = len(probes)
	block := blockdev.Aligned(probeBlockBytes)
	total := int64(len(probes))*2 + flushBytes/mib

	for index, offset := range probes {
		fill(block, nonce, offset)
		if _, err := dev.WriteAt(block, offset); err != nil {
			return report, fmt.Errorf("writing a probe at %d: %w", offset, err)
		}
		if onProgress != nil {
			onProgress("capacity", int64(index+1), total)
		}
	}
	if err := dev.Sync(); err != nil {
		return report, err
	}

	// Push the card's own write cache out, so the reads below come from flash rather than
	// from a buffer that would make any card look genuine.
	flush := blockdev.Aligned(mib)
	written := int64(0)
	for start := int64(32 * mib); written < flushBytes && start+mib <= claimed; start += mib {
		if overlaps(start, mib, probes) {
			continue
		}
		fill(flush, nonce, -start)
		if _, err := dev.WriteAt(flush, start); err != nil {
			return report, fmt.Errorf("flushing the card's cache: %w", err)
		}
		written += mib
		if onProgress != nil {
			onProgress("capacity", int64(len(probes))+written/mib, total)
		}
	}
	if err := dev.Sync(); err != nil {
		return report, err
	}

	expected := make([]byte, probeBlockBytes)
	firstFailure := int64(-1)
	for index, offset := range probes {
		if _, err := dev.ReadAt(block, offset); err != nil {
			report.Failures = append(report.Failures, Failure{Offset: offset, Kind: "lost"})
		} else {
			fill(expected, nonce, offset)
			if !bytes.Equal(block, expected) {
				report.Failures = append(report.Failures, classify(block, nonce, offset))
			}
		}
		if len(report.Failures) > 0 && firstFailure < 0 {
			firstFailure = offset
		}
		if onProgress != nil {
			onProgress("capacity", int64(len(probes))+flushBytes/mib+int64(index+1), total)
		}
	}

	report.Seconds = time.Since(started).Seconds()
	switch {
	case len(report.Failures) == 0:
		report.Genuine, report.Verdict, report.VerifiedBytes = true, "genuine", claimed
	default:
		report.Verdict = "loses-data"
		for _, failure := range report.Failures {
			if failure.Kind == "aliased" {
				report.Verdict = "wraps"
			}
		}
		report.VerifiedBytes = firstFailure / mib * mib
		if len(report.Failures) > 16 {
			report.Failures = report.Failures[:16]
		}
	}
	return report, nil
}

func classify(block, nonce []byte, offset int64) Failure {
	if bytes.HasPrefix(block, []byte(magic)) && bytes.Equal(block[8:24], nonce) {
		return Failure{Offset: offset, Kind: "aliased", AliasOf: int64(binary.LittleEndian.Uint64(block[24:]))}
	}
	if bytes.Count(block, []byte{0}) == len(block) || bytes.Count(block, []byte{0xff}) == len(block) {
		return Failure{Offset: offset, Kind: "lost"}
	}
	return Failure{Offset: offset, Kind: "corrupt"}
}
