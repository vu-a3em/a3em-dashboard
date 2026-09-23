// Package jobs is the work that needs the raw device: testing, formatting, verifying and
// imaging cards, and checking their filesystems.
//
// It runs wherever the raw device can be opened. That is this process when it already has
// access (a disk image, or a helper started as administrator), and otherwise a second copy
// of this executable started with administrator rights — see worker.go. Either way the job
// re-checks every device against the safety rules and the fingerprint the person confirmed,
// so an elevated worker never trusts the unprivileged process that launched it.
package jobs

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/exfat"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/grant"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/probe"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/safety"
)

// Kinds of job.
const (
	KindPrepare = "prepare"
	KindVerify  = "verify"
	KindFsck    = "fsck"
	KindImage   = "image"
)

// Job is one piece of raw-device work, serialisable for the elevated worker.
type Job struct {
	Kind    string   `json:"kind"`
	Targets []Target `json:"targets,omitempty"`
	// Volume and Repair are for a filesystem check.
	Volume string `json:"volume,omitempty"`
	Repair bool   `json:"repair,omitempty"`
	// Destination is where an image is written.
	Destination string `json:"destination,omitempty"`
	// Owner is who should own files the job creates, when it runs as root on someone's behalf.
	Owner *Owner `json:"owner,omitempty"`
}

// Owner is a Unix user and group.
type Owner struct {
	UID int `json:"uid"`
	GID int `json:"gid"`
}

// Target is one card.
type Target struct {
	Device              platform.Device `json:"device"`
	Fingerprint         string          `json:"fingerprint"`
	RawPath             string          `json:"rawPath"`
	AllocationUnitBytes int64           `json:"allocationUnitBytes,omitempty"`
	Label               string          `json:"label,omitempty"`
	SkipCapacityProbe   bool            `json:"skipCapacityProbe,omitempty"`
	SkipLatencyTest     bool            `json:"skipLatencyTest,omitempty"`
}

// Result is what a job produced.
type Result struct {
	Targets []TargetResult       `json:"targets,omitempty"`
	Fsck    *platform.FsckReport `json:"fsck,omitempty"`
	Image   *ImageReport         `json:"image,omitempty"`
	Error   string               `json:"error,omitempty"`
	Code    string               `json:"code,omitempty"`
	Detail  string               `json:"detail,omitempty"`
}

// TargetResult is what happened to one card.
type TargetResult struct {
	Device       string                `json:"device"`
	Capacity     *probe.CapacityReport `json:"capacity,omitempty"`
	Latency      *probe.LatencyReport  `json:"latency,omitempty"`
	Layout       *exfat.LayoutCheck    `json:"layout,omitempty"`
	Formatted    bool                  `json:"formatted"`
	VolumeSerial string                `json:"volumeSerial,omitempty"`
	Error        string                `json:"error,omitempty"`
	Code         string                `json:"code,omitempty"`
}

// Update is progress from a running job.
type Update struct {
	Device     string `json:"device,omitempty"`
	Stage      string `json:"stage"`
	Note       string `json:"note"`
	Done       int64  `json:"done,omitempty"`
	Total      int64  `json:"total,omitempty"`
	BadSectors int64  `json:"badSectors,omitempty"`
}

// Reporter receives updates. It may be called from the job's goroutine at any rate.
type Reporter func(Update)

// Failed is a refusal or failure with a code for the page.
type Failed struct{ Message, Code, Detail string }

func (f *Failed) Error() string { return f.Message }

var notes = map[string]string{
	"release":  "Releasing the card from the system.",
	"capacity": "Checking the card really holds what it claims.",
	"latency":  "Timing writes to the card.",
	"format":   "Writing the A3EM layout.",
	"verify":   "Reading the layout back.",
	"image":    "Copying the card sector by sector.",
	"fsck":     "Checking the filesystem. On a damaged card this can take several minutes.",
	"repair":   "Repairing the filesystem. Do not disconnect the card.",
}

// Run does a job with the platform's tools and this process's own access.
func Run(job Job, plat platform.Platform, report Reporter) Result {
	if report == nil {
		report = func(Update) {}
	}
	switch job.Kind {
	case KindPrepare, KindVerify:
		devices, err := plat.ListDevices()
		if err != nil {
			return failure(err)
		}
		var result Result
		for _, target := range job.Targets {
			outcome := TargetResult{Device: target.Device.ID}
			if err := recheck(devices, target); err != nil {
				outcome.Error, outcome.Code = describe(err)
			} else if job.Kind == KindPrepare {
				prepare(plat, target, &outcome, report)
			} else {
				verify(target, &outcome, report)
			}
			result.Targets = append(result.Targets, outcome)
		}
		return result
	case KindFsck:
		return fsck(job, plat, report)
	case KindImage:
		return image(job, plat, report)
	}
	return Result{Error: "Unknown job.", Code: "unexpected"}
}

// recheck confirms the device is still the one confirmed, and still a card.
func recheck(devices []platform.Device, target Target) error {
	var current *platform.Device
	for i := range devices {
		if devices[i].ID == target.Device.ID {
			current = &devices[i]
		}
	}
	if err := safety.RequireWritable(current, target.Device.ID); err != nil {
		return err
	}
	if grant.Fingerprint(*current) != target.Fingerprint {
		return &Failed{"The card changed since you confirmed. Check which card is connected and try again.", "bad-grant", ""}
	}
	return nil
}

func prepare(plat platform.Platform, target Target, outcome *TargetResult, report Reporter) {
	id := target.Device.ID
	step := func(stage string) Reporter {
		report(Update{Device: id, Stage: stage, Note: notes[stage]})
		return report
	}
	fail := func(err error) {
		outcome.Error, outcome.Code = describe(err)
	}

	step("release")
	held, err := plat.Release(target.Device)
	if err != nil {
		fail(err)
		return
	}
	// Given back before the system is asked to re-read the card, and on every early return.
	restore := sync.OnceFunc(held)
	defer restore()

	dev, err := blockdev.Open(target.RawPath, target.Device.SizeBytes, true)
	if err != nil {
		fail(err)
		return
	}
	closed := false
	closeDev := func() {
		if !closed {
			dev.Close()
			closed = true
		}
	}
	defer closeDev()

	progress := func(stage string) probe.Progress {
		return func(_ string, done, total int64) {
			report(Update{Device: id, Stage: stage, Note: notes[stage], Done: done, Total: total})
		}
	}
	if !target.SkipCapacityProbe {
		step("capacity")
		capacity, err := probe.Capacity(dev, progress("capacity"))
		if err != nil {
			fail(err)
			return
		}
		outcome.Capacity = &capacity
		if !capacity.Genuine {
			outcome.Error = fmt.Sprintf("This card does not hold what it claims: only the first %s kept what was written to it. It was not formatted; do not deploy it.",
				safety.FormatSize(capacity.VerifiedBytes))
			outcome.Code = "counterfeit"
			return
		}
	}
	if !target.SkipLatencyTest {
		step("latency")
		latency, err := probe.Latency(dev, progress("latency"))
		if err != nil {
			fail(err)
			return
		}
		outcome.Latency = &latency
	}

	step("format")
	var ids [8]byte
	rand.Read(ids[:])
	signature, serial := binary.LittleEndian.Uint32(ids[:4]), binary.LittleEndian.Uint32(ids[4:])
	images, err := exfat.BuildImages(dev.Size(), target.AllocationUnitBytes, target.Label, signature, serial)
	if err != nil {
		fail(&Failed{err.Error(), "bad-request", ""})
		return
	}
	outcome.VolumeSerial = fmt.Sprintf("%04X-%04X", serial>>16, serial&0xffff)
	total := int64(len(images.Body) + 2*len(images.Leading))
	written := func(base int64) func(int64) {
		return func(done int64) {
			report(Update{Device: id, Stage: "format", Note: notes["format"], Done: base + done, Total: total})
		}
	}
	/*
		In this order:

		  1. Zero the first MiB, which removes the old partition table, so the system has
		     nothing to mount while the rest is written.
		  2. Write the volume from the 1 MiB mark, then read it back and compare.
		  3. Write the first MiB — the new MBR — last, then read it back and compare.

		Reading back before the MBR exists matters: once it does, the system re-probes and
		mounts the volume, and mounting changes it.
	*/
	if err := blockdev.WriteAll(dev, make([]byte, exfat.LeadingBytes), 0, written(0)); err != nil {
		fail(err)
		return
	}
	if err := writeAndCompare(dev, images.Body, exfat.LeadingBytes, "volume", written(exfat.LeadingBytes)); err != nil {
		fail(err)
		return
	}
	if err := writeAndCompare(dev, images.Leading, 0, "partition table", written(exfat.LeadingBytes+int64(len(images.Body)))); err != nil {
		fail(err)
		return
	}
	outcome.Formatted = true

	step("verify")
	check, err := exfat.Verify(dev)
	if err != nil {
		fail(err)
		return
	}
	outcome.Layout = &check
	closeDev()
	restore()
	if !check.Reference {
		outcome.Error = "The card did not read back the layout that was written: " + check.Problem
		outcome.Code = "verify-failed"
		return
	}
	if err := plat.Reread(target.Device); err != nil {
		fail(err)
	}
}

func writeAndCompare(dev blockdev.Device, data []byte, offset int64, what string, onChunk func(int64)) error {
	if err := blockdev.WriteAll(dev, data, offset, onChunk); err != nil {
		return err
	}
	if err := dev.Sync(); err != nil {
		return err
	}
	back, err := blockdev.ReadAll(dev, len(data), offset)
	if err != nil {
		return err
	}
	if !bytes.Equal(back, data) {
		return &Failed{fmt.Sprintf("The card did not read back the %s that was written to it. It may be failing; do not deploy it.", what), "readback-mismatch", ""}
	}
	return nil
}

func verify(target Target, outcome *TargetResult, report Reporter) {
	report(Update{Device: target.Device.ID, Stage: "verify", Note: notes["verify"]})
	dev, err := blockdev.Open(target.RawPath, target.Device.SizeBytes, false)
	if err != nil {
		outcome.Error, outcome.Code = describe(err)
		return
	}
	defer dev.Close()
	check, err := exfat.Verify(dev)
	if err != nil {
		outcome.Error, outcome.Code = describe(err)
		return
	}
	outcome.Layout = &check
}

func fsck(job Job, plat platform.Platform, report Reporter) Result {
	devices, err := plat.ListDevices()
	if err != nil {
		return failure(err)
	}
	var holder *platform.Device
	for i := range devices {
		for _, v := range devices[i].Volumes {
			if v.ID == job.Volume {
				holder = &devices[i]
			}
		}
	}
	if holder == nil {
		return failure(&safety.Refused{Message: fmt.Sprintf("No connected card holds a volume called %s.", job.Volume), Code: "unknown-device"})
	}
	if err := safety.RequireWritable(holder, holder.ID); err != nil {
		return failure(err)
	}
	stage := "fsck"
	if job.Repair {
		stage = "repair"
	}
	report(Update{Device: holder.ID, Stage: stage, Note: notes[stage]})
	var fsckReport platform.FsckReport
	if job.Repair {
		fsckReport, err = plat.Repair(job.Volume)
	} else {
		fsckReport, err = plat.Diagnose(job.Volume)
	}
	if err != nil {
		return failure(err)
	}
	return Result{Fsck: &fsckReport}
}

// describe is an error as a message and a code for the page.
func describe(err error) (string, string) {
	var failed *Failed
	var refused *safety.Refused
	var command *platform.CommandError
	switch {
	case errors.As(err, &failed):
		return failed.Message, failed.Code
	case errors.As(err, &refused):
		return refused.Message, refused.Code
	case errors.As(err, &command):
		return command.Message, "platform-error"
	case errors.Is(err, blockdev.ErrWriteProtected):
		return "The card is write-protected. Slide the lock switch on its side away from LOCK, then reinsert it.", "write-protected"
	case errors.Is(err, blockdev.ErrPermission):
		return "The helper was not allowed to open the card.", "permission-denied"
	}
	return err.Error(), "unexpected"
}

func failure(err error) Result {
	message, code := describe(err)
	var command *platform.CommandError
	detail := ""
	if errors.As(err, &command) {
		detail = command.Output
	}
	return Result{Error: message, Code: code, Detail: detail}
}

// newID is a short random identifier for job directories.
func newID() string {
	var b [6]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// chown gives a file to the person the job runs for, when it runs as root.
func chown(path string, owner *Owner) {
	if owner != nil && os.Geteuid() == 0 {
		os.Chown(path, owner.UID, owner.GID)
	}
}
