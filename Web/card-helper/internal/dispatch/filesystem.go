package dispatch

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/exfat"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/grant"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/jobs"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/protocol"
)

/*
	Checking and repairing a card's filesystem.

	The check is this helper's own (internal/exfat), the same on every platform and needing no
	system tool; a card that is not exFAT goes to the system's, as before. A repair is this
	helper's own when the check shows it fixes everything, and the system's tool otherwise.
	Either way the page gets one report: whether the card is clean, what is wrong in words,
	which recordings it touches, and what can be done about it here.
*/

// FilesystemReport is what the page is told about a card's filesystem. It keeps the fields
// of the system tool's report, so a page written for those still reads it.
type FilesystemReport struct {
	Clean    bool   `json:"clean"`
	Modified bool   `json:"modified"`
	Output   string `json:"output"`
	ExitCode *int   `json:"exitCode"`
	// Engine is "a3em" for this helper's check or repair, "system" for the system's tool.
	Engine      string          `json:"engine"`
	Findings    []exfat.Finding `json:"findings,omitempty"`
	Repairs     []string        `json:"repairs,omitempty"`
	FixableHere bool            `json:"fixableHere"`
	Files       int             `json:"files,omitempty"`
	Directories int             `json:"directories,omitempty"`
	Repaired    []string        `json:"repaired,omitempty"`
	Saved       []string        `json:"saved,omitempty"`
	// Tails is what logs and IMU files may hold past their recorded end, for the page to judge
	// and add to their copies.
	Tails []exfat.Tail `json:"tails,omitempty"`
}

func fromCheck(check exfat.CheckReport) FilesystemReport {
	return FilesystemReport{Clean: check.Clean, Engine: "a3em", Findings: check.Findings, Repairs: check.Repairs,
		FixableHere: check.FixableHere, Files: check.Files, Directories: check.Directories, Output: describeFindings(check), Tails: check.Tails}
}

func fromSystem(fsck platform.FsckReport) FilesystemReport {
	return FilesystemReport{Clean: fsck.Clean, Modified: fsck.Modified, Output: fsck.Output, ExitCode: fsck.ExitCode, Engine: "system"}
}

// describeFindings is the check as text, for the page's "what the check reported".
func describeFindings(check exfat.CheckReport) string {
	var lines []string
	lines = append(lines, fmt.Sprintf("Checked %d files in %d folders.", check.Files, check.Directories))
	for _, f := range check.Findings {
		line := "- " + f.Message
		if len(f.Paths) > 0 {
			line += "\n  " + strings.Join(f.Paths, "\n  ")
		}
		lines = append(lines, line)
	}
	if check.Clean {
		lines = append(lines, "No problems found.")
	}
	return strings.Join(lines, "\n")
}

// diagnose checks the filesystem on a volume's card, changing nothing.
func (d *Dispatcher) diagnose(req protocol.Request) (reply, error) {
	device, volume, err := d.holding(req.Volume)
	if err != nil {
		return nil, err
	}
	stop, done := d.stoppable(req.ID)
	defer done()
	// What past repairs saved is let go of in time, repair or not.
	exfat.PruneSaved(filepath.Join(d.Grants.Dir, "repairs"), time.Now())
	job := jobs.Job{Kind: jobs.KindCheck, Stop: stop, Targets: []jobs.Target{{Device: *device, Fingerprint: grant.Fingerprint(*device), RawPath: d.Plat.RawPath(*device)}}}
	result, err := d.long(req, func(report jobs.Reporter) (jobs.Result, error) {
		return d.Execute(job, []string{d.Plat.RawPath(*device)}, report, "check the filesystem on "+describeCard(*device))
	})
	if err != nil {
		return nil, err
	}
	if result.Error != "" {
		return nil, &jobs.Failed{Message: result.Error, Code: result.Code, Detail: result.Detail}
	}
	if result.Check != nil && !result.Check.NotExFAT {
		return reply{"report": fromCheck(*result.Check)}, nil
	}
	// Not exFAT — a FAT32 card, say — so the system's tool, as before this helper had its own.
	fsckJob := jobs.Job{Kind: jobs.KindFsck, Volume: volume.ID}
	result, err = d.long(req, func(report jobs.Reporter) (jobs.Result, error) {
		return d.Execute(fsckJob, []string{d.Plat.VolumeRawPath(volume.ID)}, report, "check the filesystem on "+describeCard(*device))
	})
	if err != nil {
		return nil, err
	}
	if result.Error != "" {
		return nil, &jobs.Failed{Message: result.Error, Code: result.Code, Detail: result.Detail}
	}
	if result.Fsck == nil {
		return nil, &jobs.Failed{Message: "The filesystem check gave no report.", Code: "unexpected"}
	}
	return reply{"report": fromSystem(*result.Fsck)}, nil
}

// repairFilesystem repairs a confirmed card's filesystem.
func (d *Dispatcher) repairFilesystem(req protocol.Request) (reply, error) {
	device, volume, err := d.holding(req.Volume)
	if err != nil {
		return nil, err
	}
	if device.ID != req.Device {
		return nil, refuse("That volume is not on the confirmed card.", "bad-grant")
	}
	if err := d.Grants.Redeem(req.Grant, "repair", *device); err != nil {
		return nil, err
	}
	job := jobs.Job{Kind: jobs.KindFix, Volume: volume.ID, SaveDir: filepath.Join(d.Grants.Dir, "repairs"),
		Targets: []jobs.Target{{Device: *device, Fingerprint: grant.Fingerprint(*device), RawPath: d.Plat.RawPath(*device)}}}
	result, err := d.long(req, func(report jobs.Reporter) (jobs.Result, error) {
		// Both nodes, so one authorization covers this helper's repair and the system's tool.
		return d.Execute(job, []string{d.Plat.RawPath(*device), d.Plat.VolumeRawPath(volume.ID)}, report, "repair the filesystem on "+describeCard(*device))
	})
	if err != nil {
		return nil, err
	}
	if result.Error != "" {
		return nil, &jobs.Failed{Message: result.Error, Code: result.Code, Detail: result.Detail}
	}
	fixed := result.Fix
	if fixed == nil {
		return nil, &jobs.Failed{Message: "The repair gave no report.", Code: "unexpected"}
	}
	switch {
	case fixed.Ours != nil:
		after := fromCheck(fixed.Ours.After)
		after.Modified, after.Repaired, after.Saved = true, fixed.Ours.Repaired, fixed.Ours.Saved
		after.Output = "Repaired: " + strings.Join(fixed.Ours.Repaired, ", ") + ".\n" + after.Output
		if len(fixed.Ours.Saved) > 0 {
			after.Output += "\nWhat the repair replaced was saved in:\n  " + strings.Join(fixed.Ours.Saved, "\n  ")
		}
		return reply{"report": after}, nil
	case fixed.System != nil:
		return reply{"report": fromSystem(*fixed.System)}, nil
	}
	// Clean before anything was done.
	return reply{"report": fromCheck(fixed.Before)}, nil
}

// stoppable registers a request that can be stopped, and returns what closes when it is asked
// to, and what to call when it is over.
func (d *Dispatcher) stoppable(id string) (<-chan struct{}, func()) {
	d.stopMu.Lock()
	defer d.stopMu.Unlock()
	if d.stops == nil {
		d.stops = map[string]chan struct{}{}
	}
	stop := make(chan struct{})
	d.stops[id] = stop
	return stop, func() {
		d.stopMu.Lock()
		defer d.stopMu.Unlock()
		delete(d.stops, id)
	}
}

// Stop asks the request with this ID to stop, where it can. It reports whether one was running.
func (d *Dispatcher) Stop(id string) bool {
	d.stopMu.Lock()
	defer d.stopMu.Unlock()
	stop, ok := d.stops[id]
	if ok {
		close(stop)
		delete(d.stops, id)
	}
	return ok
}

// StopAll stops everything that can stop, for when the page has gone. A format or a repair,
// which cannot stop partway safely, carries on to the end.
func (d *Dispatcher) StopAll() {
	d.stopMu.Lock()
	defer d.stopMu.Unlock()
	for id, stop := range d.stops {
		close(stop)
		delete(d.stops, id)
	}
}
