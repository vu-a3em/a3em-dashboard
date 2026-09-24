package jobs

import (
	"errors"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/exfat"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
)

// check is this helper's own filesystem check of one card. It only reads.
func check(job Job, plat platform.Platform, report Reporter) Result {
	if len(job.Targets) != 1 {
		return Result{Error: "A check is of one card.", Code: "bad-request"}
	}
	target := job.Targets[0]
	devices, err := plat.ListDevices()
	if err != nil {
		return failure(err)
	}
	if err := recheck(devices, target); err != nil {
		return failure(err)
	}
	report(Update{Device: target.Device.ID, Stage: "check", Note: notes["check"]})
	dev, err := blockdev.Open(target.RawPath, target.Device.SizeBytes, false)
	if err != nil {
		return failure(err)
	}
	defer dev.Close()
	result, err := exfat.Check(dev, job.Stopped)
	if errors.Is(err, exfat.ErrStopped) {
		return Result{Error: "The check was stopped.", Code: "stopped"}
	}
	if err != nil {
		return failure(err)
	}
	return Result{Check: &result}
}

/*
fix repairs one card's filesystem: with this helper's own repairs where the check shows they
fix everything, and with the system's tool otherwise.

The check comes first and writes nothing, on the card as it is. Only then is the disk
released for writing — which on Windows takes its volume offline, so the system's tool,
which needs the volume, runs without that.
*/
func fix(job Job, plat platform.Platform, report Reporter) Result {
	if len(job.Targets) != 1 {
		return Result{Error: "A repair is of one card.", Code: "bad-request"}
	}
	target := job.Targets[0]
	devices, err := plat.ListDevices()
	if err != nil {
		return failure(err)
	}
	if err := recheck(devices, target); err != nil {
		return failure(err)
	}
	report(Update{Device: target.Device.ID, Stage: "check", Note: notes["check"]})
	dev, err := blockdev.Open(target.RawPath, target.Device.SizeBytes, false)
	if err != nil {
		return failure(err)
	}
	before, err := exfat.Check(dev, nil)
	dev.Close()
	if err != nil {
		return failure(err)
	}
	fixed := &Fixed{Before: before}
	if before.Clean {
		return Result{Fix: fixed}
	}
	if before.FixableHere {
		report(Update{Device: target.Device.ID, Stage: "repair", Note: notes["repair"]})
		held, err := plat.Release(target.Device)
		if err != nil {
			return failure(err)
		}
		defer held()
		dev, err := blockdev.Open(target.RawPath, target.Device.SizeBytes, true)
		if err != nil {
			return failure(err)
		}
		ours, err := exfat.Repair(dev, job.SaveDir)
		dev.Close()
		for _, path := range ours.Saved {
			chown(path, job.Owner)
		}
		if err != nil {
			return failure(err)
		}
		fixed.Ours = &ours
		return Result{Fix: fixed}
	}
	if job.Volume == "" {
		return failure(&Failed{"The card has problems only the system's own repair can fix, and it has no volume for that tool to open.", "not-repairable", ""})
	}
	report(Update{Device: target.Device.ID, Stage: "repair", Note: notes["system-repair"]})
	system, err := plat.Repair(job.Volume)
	if err != nil {
		return failure(err)
	}
	fixed.System = &system
	return Result{Fix: fixed}
}
