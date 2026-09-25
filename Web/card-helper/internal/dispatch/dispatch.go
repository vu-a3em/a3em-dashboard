// Package dispatch turns a request into a reply, refusing whatever should not happen.
//
// Every decision about what may be acted on lives here or in package safety, never in a
// platform implementation, so the refusals are identical on three operating systems and
// testable on one. Errors become replies rather than crashes: a host that dies takes the
// port with it, and the page would see "not installed" when what happened is that a card was
// pulled out mid-scan.
//
// The helper reports facts and the page judges them. Whether a card's geometry suits the
// firmware, whether its configuration parses, whether its free space covers the deployment —
// those rules already live, tested, in the dashboard's schema package, so they are not
// written a second time here. The exception is the format request itself, which this helper
// must refuse on its own; its rules are checked against the schema's by a golden test.
package dispatch

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/cardfs"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/destination"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/exfat"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/grant"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/jobs"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/ledger"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/protocol"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/rules"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/safety"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/sysenv"
)

// ProtocolVersion changes when a reply changes shape.
const ProtocolVersion = 3

// Operations are every op this helper answers.
var Operations = []string{
	"hello", "listDevices", "identify", "inspect", "mount", "unmount", "eject", "diagnose",
	"challenge", "repair", "image", "format", "prepare", "readiness", "verify", "writeConfig",
	"chooseImage", "stop", "rename",
}

// Dispatcher answers requests.
type Dispatcher struct {
	Plat    platform.Platform
	Grants  *grant.Store
	Ledger  *ledger.Store
	Version string
	// Send delivers a progress message. It must be safe to call from several goroutines.
	Send func(any)
	// Execute runs a raw-device job; jobs.Execute unless a test replaces it.
	Execute func(job jobs.Job, paths []string, report jobs.Reporter, reason string) (jobs.Result, error)

	stopMu sync.Mutex
	stops  map[string]chan struct{}
}

// New is a dispatcher for this computer.
func New(plat platform.Platform, version string, send func(any)) (*Dispatcher, error) {
	grants, err := grant.DefaultStore()
	if err != nil {
		return nil, err
	}
	d := &Dispatcher{Plat: plat, Grants: grants, Ledger: &ledger.Store{Dir: grants.Dir}, Version: version, Send: send}
	d.Execute = func(job jobs.Job, paths []string, report jobs.Reporter, reason string) (jobs.Result, error) {
		return jobs.Execute(job, plat, paths, report, reason)
	}
	return d, nil
}

type reply map[string]any

// Handle answers one raw request.
func (d *Dispatcher) Handle(raw json.RawMessage) any {
	var req protocol.Request
	if err := json.Unmarshal(raw, &req); err != nil || req.ID == "" {
		return protocol.Failure{ID: nonEmpty(req.ID, "unknown"), Error: "Malformed request.", Code: "malformed"}
	}
	result, err := d.route(req)
	if err != nil {
		return asFailure(req.ID, err)
	}
	result["id"], result["ok"], result["op"] = req.ID, true, req.Op
	return result
}

var probeName = regexp.MustCompile(`^\.a3em-probe-[0-9a-f-]{36}$`)

func (d *Dispatcher) route(req protocol.Request) (reply, error) {
	switch req.Op {
	case "hello":
		// What this computer lacks, so the dashboard can say so before a card needs it.
		return reply{"version": d.Version, "platform": d.Plat.ID(), "implemented": Operations, "protocol": ProtocolVersion, "issues": sysenv.Check()}, nil

	case "listDevices":
		devices, err := d.eligible()
		if err != nil {
			return nil, err
		}
		return reply{"devices": devices}, nil

	case "identify":
		// The name becomes part of a path, so it must be the shape the page generates.
		if !probeName.MatchString(req.Probe) {
			return nil, refuse("That is not a probe file name this helper issued.", "no-probe-match")
		}
		devices, err := d.eligible()
		if err != nil {
			return nil, err
		}
		type match struct{ device, volume string }
		var matches []match
		for _, device := range devices {
			for _, volume := range device.Volumes {
				if volume.MountPoint == nil {
					continue
				}
				if _, err := os.Stat(filepath.Join(*volume.MountPoint, req.Probe)); err == nil {
					matches = append(matches, match{device.ID, volume.ID})
				}
			}
		}
		switch len(matches) {
		case 0:
			return nil, refuse("No connected card carries that marker. It may have been ejected.", "no-probe-match")
		case 1:
			return reply{"volume": matches[0].volume, "device": matches[0].device}, nil
		}
		// Never guess: identical cards are the normal case in batch preparation.
		return nil, refuse(fmt.Sprintf("%d cards carry that marker, so the right one cannot be identified. Disconnect the others.", len(matches)), "ambiguous-probe")

	case "inspect":
		if _, _, err := d.holding(req.Volume); err != nil {
			return nil, err
		}
		geometry, err := d.Plat.Inspect(req.Volume)
		if err != nil {
			return nil, err
		}
		return reply{"geometry": geometry}, nil

	case "mount", "unmount":
		if _, _, err := d.holding(req.Volume); err != nil {
			return nil, err
		}
		if req.Op == "mount" {
			return reply{}, d.Plat.Mount(req.Volume)
		}
		return reply{}, d.Plat.Unmount(req.Volume)

	case "eject":
		device, err := d.writable(req.Device)
		if err != nil {
			return nil, err
		}
		return reply{}, d.Plat.Eject(device.ID)

	case "challenge":
		device, err := d.writable(req.Device)
		if err != nil {
			return nil, err
		}
		token, description, expires, err := d.Grants.Issue(*device, req.Operation)
		if err != nil {
			return nil, err
		}
		return reply{"token": token, "description": description, "expiresAt": expires}, nil

	case "diagnose":
		return d.diagnose(req)

	case "repair":
		return d.repairFilesystem(req)

	case "stop":
		// Stops an image or a check that is running, asked on the same port it runs on.
		return reply{"stopping": d.Stop(req.Target)}, nil

	case "image":
		return d.image(req)

	case "chooseImage":
		// The system's save dialog, then whether the image would fit where it points.
		device, err := d.readable(req.Device)
		if err != nil {
			return nil, err
		}
		path, err := destination.Choose(destination.StartFolder(), imageName(*device), "Where should the image of "+describeCard(*device)+" be saved?")
		switch {
		case errors.Is(err, destination.ErrCanceled):
			return nil, refuse("No location was chosen, so nothing was copied.", "cancelled")
		case errors.Is(err, destination.ErrNoDialog):
			return nil, refuse("This system has no save dialog the helper can show.", "no-dialog")
		case err != nil:
			return nil, err
		}
		if onCard(*device, path) {
			return nil, refuse("An image cannot be saved onto the card it is copied from. Choose another drive.", "bad-destination")
		}
		return reply{"destination": destination.Check(path, device.SizeBytes)}, nil

	case "format":
		results, err := d.prepare(req, "format", []protocol.PrepareTarget{{
			Device: req.Device, Grant: req.Grant, AllocationUnitBytes: req.AllocationUnitBytes, Label: req.Label,
		}}, true, true)
		if err != nil {
			return nil, err
		}
		if results[0].Error != "" {
			return nil, &jobs.Failed{Message: results[0].Error, Code: results[0].Code}
		}
		return reply{"geometry": results[0].Geometry, "layout": results[0].Layout, "volume": results[0].Volume}, nil

	case "prepare":
		if len(req.Targets) == 0 {
			return nil, refuse("No cards were named.", "bad-request")
		}
		results, err := d.prepare(req, "prepare", req.Targets, req.SkipCapacityProbe, req.SkipLatencyTest)
		if err != nil {
			return nil, err
		}
		return reply{"results": results}, nil

	case "readiness":
		if len(req.Devices) > 0 {
			reports, err := withHeartbeat(d, req, func(progress jobs.Reporter) ([]*Readiness, error) { return d.readinessMany(req, progress) })
			if err != nil {
				return nil, err
			}
			return reply{"readiness": reports}, nil
		}
		report, err := withHeartbeat(d, req, func(progress jobs.Reporter) (*Readiness, error) { return d.readiness(req, progress) })
		if err != nil {
			return nil, err
		}
		return reply{"readiness": report}, nil

	case "verify":
		device, err := d.readable(req.Device)
		if err != nil {
			return nil, err
		}
		check, err := d.layout(req, *device)
		if err != nil {
			return nil, err
		}
		return reply{"layout": check}, nil

	case "writeConfig":
		_, volume, err := d.holding(req.Volume)
		if err != nil {
			return nil, err
		}
		if volume.MountPoint == nil {
			return nil, refuse("The card is not mounted.", "not-mounted")
		}
		if err := cardfs.WriteConfig(*volume.MountPoint, req.Text); err != nil {
			return nil, &jobs.Failed{Message: "Could not write the configuration: " + err.Error(), Code: "write-failed"}
		}
		return reply{"bytes": len(req.Text), "path": filepath.Join(*volume.MountPoint, rules.ConfigFileName)}, nil

	case "rename":
		return d.rename(req)
	}
	return nil, refuse("Unknown operation.", "unknown-op")
}

// PreparedCard is one card's outcome in a prepare or format reply.
type PreparedCard struct {
	jobs.TargetResult
	Volume        string             `json:"volume,omitempty"`
	Geometry      *platform.Geometry `json:"geometry,omitempty"`
	ConfigWritten bool               `json:"configWritten"`
}

// prepare validates every target before any is touched, runs one job for all of them — one
// administrator prompt for a batch — and then mounts each card and writes its configuration
// as the person, not as root.
func (d *Dispatcher) prepare(req protocol.Request, operation string, targets []protocol.PrepareTarget, skipProbe, skipLatency bool) ([]PreparedCard, error) {
	devices, err := d.Plat.ListDevices()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	job := jobs.Job{Kind: jobs.KindPrepare}
	var paths []string
	for _, target := range targets {
		if seen[target.Device] {
			return nil, refuse(fmt.Sprintf("%s is named twice.", target.Device), "bad-request")
		}
		seen[target.Device] = true
		device := find(devices, target.Device)
		if err := safety.RequireWritable(device, target.Device); err != nil {
			return nil, err
		}
		if problems := rules.ValidateFormat(target.AllocationUnitBytes, target.Label); len(problems) > 0 {
			return nil, refuse(strings.Join(problems, " "), "bad-request")
		}
		if len(target.Config) > rules.ConfigMaxBytes {
			return nil, refuse("The configuration is larger than the firmware reads.", "bad-request")
		}
		if device.WriteProtected {
			return nil, refuse(fmt.Sprintf("%s is write-protected. Slide the lock switch on the card away from LOCK, then reinsert it.", describeCard(*device)), "write-protected")
		}
		job.Targets = append(job.Targets, jobs.Target{
			Device: *device, Fingerprint: grant.Fingerprint(*device), RawPath: d.Plat.RawPath(*device),
			AllocationUnitBytes: target.AllocationUnitBytes, Label: strings.TrimSpace(target.Label),
			SkipCapacityProbe: skipProbe, SkipLatencyTest: skipLatency,
		})
		paths = append(paths, d.Plat.RawPath(*device))
	}
	// Only once every target is acceptable is any confirmation spent.
	for i, target := range targets {
		if err := d.Grants.Redeem(target.Grant, operation, job.Targets[i].Device); err != nil {
			return nil, err
		}
	}

	reason := "erase and format " + describeCard(job.Targets[0].Device)
	if len(job.Targets) > 1 {
		reason = fmt.Sprintf("erase and format %d cards", len(job.Targets))
	}
	// Mounting and configuring each card afterward is inside the heartbeat too: waiting for
	// the system to mount a new volume can take longer than the page tolerates silence.
	return withHeartbeat(d, req, func(report jobs.Reporter) ([]PreparedCard, error) {
		result, err := d.Execute(job, paths, report, reason)
		if err != nil {
			return nil, err
		}
		if result.Error != "" {
			return nil, &jobs.Failed{Message: result.Error, Code: result.Code, Detail: result.Detail}
		}
		cards := make([]PreparedCard, len(result.Targets))
		for i, outcome := range result.Targets {
			card := PreparedCard{TargetResult: outcome}
			target, spec := job.Targets[i], targets[i]
			if outcome.Error == "" && outcome.Formatted {
				report(jobs.Update{Device: target.Device.ID, Stage: "mount", Note: "Mounting the card and writing its configuration."})
				d.finish(target, spec, &card)
			}
			cards[i] = card
		}
		return cards, nil
	})
}

// finish mounts a freshly formatted card, checks what the system now says about it, writes
// its configuration and remembers its test results.
func (d *Dispatcher) finish(target jobs.Target, spec protocol.PrepareTarget, card *PreparedCard) {
	fail := func(message, code string) { card.Error, card.Code = message, code }
	volumeID, err := d.Plat.Settle(target.Device)
	if err != nil {
		fail("The card was formatted but did not mount: "+err.Error(), "mount-failed")
		return
	}
	card.Volume = volumeID
	geometry, err := d.Plat.Inspect(volumeID)
	if err != nil {
		fail("The card was formatted but could not be inspected: "+err.Error(), "platform-error")
		return
	}
	card.Geometry = &geometry
	// Judged by what the card now says, never by an exit code.
	if geometry.AllocationUnitBytes == nil || *geometry.AllocationUnitBytes != target.AllocationUnitBytes {
		fail(fmt.Sprintf("The card reports a %s allocation unit after formatting, not the %d bytes requested.", sizeOrUnknown(geometry.AllocationUnitBytes), target.AllocationUnitBytes), "verify-failed")
		return
	}
	if geometry.Filesystem == nil || *geometry.Filesystem != "exfat" {
		fail("The card does not report exFAT after formatting.", "verify-failed")
		return
	}
	devices, _ := d.Plat.ListDevices()
	volume := findVolume(devices, volumeID)
	if volume == nil || volume.Label == nil || *volume.Label != target.Label {
		fail(fmt.Sprintf("The card does not report the label %q after formatting.", target.Label), "verify-failed")
		return
	}
	if spec.Config != "" {
		if volume.MountPoint == nil {
			fail("The card was formatted but is not mounted, so its configuration was not written.", "mount-failed")
			return
		}
		if err := cardfs.WriteConfig(*volume.MountPoint, spec.Config); err != nil {
			fail("The card was formatted but its configuration could not be written: "+err.Error(), "write-failed")
			return
		}
		card.ConfigWritten = true
	}
	if volume.UUID != "" {
		d.Ledger.Record(ledger.Key(volume.UUID, target.Device.SizeBytes), ledger.Entry{
			PreparedAt: time.Now().UTC(), DeviceBytes: target.Device.SizeBytes, ClusterBytes: target.AllocationUnitBytes,
			Label: target.Label, VolumeSerial: card.VolumeSerial, Capacity: card.Capacity, Latency: card.Latency,
		})
	}
}

// Readiness is everything the page needs to decide whether a card can be deployed.
type Readiness struct {
	CheckedAt time.Time          `json:"checkedAt"`
	Device    platform.Device    `json:"device"`
	Identity  platform.Identity  `json:"identity"`
	Volume    *platform.Volume   `json:"volume"`
	Geometry  *platform.Geometry `json:"geometry"`
	Contents  *cardfs.Contents   `json:"contents"`
	Config    *cardfs.Config     `json:"config"`
	FreeBytes *int64             `json:"freeBytes"`
	// Layout compares the raw card with the reference layout; nil when not checked.
	Layout *exfat.LayoutCheck `json:"layout"`
	// LayoutSkipped says why Layout is nil.
	LayoutSkipped string `json:"layoutSkipped,omitempty"`
	// LayoutError is what went wrong reading the layout, in words, with the system's own
	// output where there was some, for the person to pass on.
	LayoutError string `json:"layoutError,omitempty"`
	// Prepared is what this computer recorded when it prepared this very format of the card.
	Prepared *ledger.Entry `json:"prepared"`
	Problems []string      `json:"problems,omitempty"`
}

func (d *Dispatcher) readiness(req protocol.Request, progress jobs.Reporter) (*Readiness, error) {
	device, err := d.readable(req.Device)
	if err != nil {
		return nil, err
	}
	r := d.surface(*device, progress)
	raw := d.Plat.RawPath(*device)
	if req.Deep || accessible(raw) {
		progress(jobs.Update{Device: device.ID, Stage: "verify", Note: "Comparing the card's layout with the reference."})
		check, err := d.readLayout(*device, progress)
		d.attachLayout(r, check, err)
	} else {
		r.LayoutSkipped = "needs-admin"
	}
	return r, nil
}

// readinessMany checks several cards, reading all their layouts in one job.
func (d *Dispatcher) readinessMany(req protocol.Request, progress jobs.Reporter) ([]*Readiness, error) {
	// One listing for all of them: on macOS each listing is a round of diskutil queries.
	listed, err := d.Plat.ListDevices()
	if err != nil {
		return nil, err
	}
	var devices []platform.Device
	for _, id := range req.Devices {
		device := find(listed, id)
		if err := safety.RequireWritable(device, id); err != nil {
			return nil, err
		}
		devices = append(devices, *device)
	}
	reports := make([]*Readiness, len(devices))
	job := jobs.Job{Kind: jobs.KindVerify}
	var paths []string
	for i, device := range devices {
		reports[i] = d.surface(device, progress)
		raw := d.Plat.RawPath(device)
		if req.Deep || accessible(raw) {
			job.Targets = append(job.Targets, jobs.Target{Device: device, Fingerprint: grant.Fingerprint(device), RawPath: raw})
			paths = append(paths, raw)
		} else {
			reports[i].LayoutSkipped = "needs-admin"
		}
	}
	if len(job.Targets) == 0 {
		return reports, nil
	}
	note := "Comparing the card's layout with the reference."
	if len(job.Targets) > 1 {
		note = "Comparing the cards' layouts with the reference."
	}
	progress(jobs.Update{Stage: "verify", Note: note})
	reason := "read the layout of " + describeCard(job.Targets[0].Device)
	if len(job.Targets) > 1 {
		reason = fmt.Sprintf("read the layout of %d cards", len(job.Targets))
	}
	result, err := d.Execute(job, paths, progress, reason)
	for i := range reports {
		if reports[i].LayoutSkipped != "" {
			continue
		}
		switch {
		case err != nil:
			d.attachLayout(reports[i], nil, err)
		case result.Error != "":
			d.attachLayout(reports[i], nil, &jobs.Failed{Message: result.Error, Code: result.Code})
		default:
			for _, outcome := range result.Targets {
				if outcome.Device != reports[i].Device.ID {
					continue
				}
				if outcome.Error != "" {
					d.attachLayout(reports[i], nil, &jobs.Failed{Message: outcome.Error, Code: outcome.Code})
				} else {
					d.attachLayout(reports[i], outcome.Layout, nil)
				}
			}
		}
	}
	return reports, nil
}

func (d *Dispatcher) attachLayout(r *Readiness, check *exfat.LayoutCheck, err error) {
	if err != nil {
		// A layout that could not be read leaves the rest of the report standing.
		failure := asFailure("", err)
		r.LayoutSkipped = failure.Code
		if failure.Code != "cancelled" {
			r.LayoutError = failure.Error
			if detail := strings.TrimSpace(failure.Detail); detail != "" {
				if len(detail) > 300 {
					detail = detail[:300] + "…"
				}
				r.LayoutError += " (" + detail + ")"
			}
			r.Problems = append(r.Problems, "The card's layout could not be read: "+r.LayoutError)
		}
		return
	}
	r.Layout = check
}

// surface is everything about a card that needs no raw access.
func (d *Dispatcher) surface(dev platform.Device, progress jobs.Reporter) *Readiness {
	device := &dev
	progress(jobs.Update{Device: device.ID, Stage: "inspect", Note: "Reading the card."})
	r := &Readiness{CheckedAt: time.Now().UTC(), Device: *device, Identity: d.Plat.Identity(*device)}
	note := func(format string, args ...any) { r.Problems = append(r.Problems, fmt.Sprintf(format, args...)) }
	if len(device.Volumes) > 0 {
		volume := device.Volumes[0]
		if volume.MountPoint == nil && volume.Mountable && volume.Filesystem != nil {
			if err := d.Plat.Mount(volume.ID); err == nil {
				if devices, err := d.Plat.ListDevices(); err == nil {
					if v := findVolume(devices, volume.ID); v != nil {
						volume = *v
					}
				}
			}
		}
		r.Volume = &volume
		if geometry, err := d.Plat.Inspect(volume.ID); err == nil {
			r.Geometry = &geometry
		} else {
			note("The volume could not be inspected: %v", err)
		}
		if volume.MountPoint != nil {
			if contents, err := cardfs.Walk(*volume.MountPoint); err == nil {
				r.Contents = &contents
			} else {
				note("The card's files could not be listed: %v", err)
			}
			if config, err := cardfs.ReadConfig(*volume.MountPoint); err == nil {
				r.Config = &config
			} else {
				note("The configuration could not be read: %v", err)
			}
			if free, err := cardfs.FreeBytes(*volume.MountPoint); err == nil {
				r.FreeBytes = &free
			}
		}
		if volume.UUID != "" {
			r.Prepared = d.Ledger.Lookup(ledger.Key(volume.UUID, device.SizeBytes))
		}
	}
	return r
}

// layout reads the card's first sectors and compares them with the reference. Only reads,
// but the raw device may still need the elevated worker.
func (d *Dispatcher) layout(req protocol.Request, device platform.Device) (*exfat.LayoutCheck, error) {
	return withHeartbeat(d, req, func(report jobs.Reporter) (*exfat.LayoutCheck, error) { return d.readLayout(device, report) })
}

func (d *Dispatcher) readLayout(device platform.Device, report jobs.Reporter) (*exfat.LayoutCheck, error) {
	job := jobs.Job{Kind: jobs.KindVerify, Targets: []jobs.Target{{Device: device, Fingerprint: grant.Fingerprint(device), RawPath: d.Plat.RawPath(device)}}}
	result, err := d.Execute(job, []string{d.Plat.RawPath(device)}, report, "read the layout of "+describeCard(device))
	if err != nil {
		return nil, err
	}
	if result.Error != "" {
		return nil, &jobs.Failed{Message: result.Error, Code: result.Code}
	}
	outcome := result.Targets[0]
	if outcome.Error != "" {
		return nil, &jobs.Failed{Message: outcome.Error, Code: outcome.Code}
	}
	return outcome.Layout, nil
}

func (d *Dispatcher) image(req protocol.Request) (reply, error) {
	device, err := d.readable(req.Device)
	if err != nil {
		return nil, err
	}
	target := req.Destination
	if target == "" {
		folder, err := destination.DefaultFolder()
		if err != nil {
			return nil, err
		}
		target = filepath.Join(folder, imageName(*device))
	}
	if !filepath.IsAbs(target) {
		return nil, refuse("The image destination must be a full path.", "bad-destination")
	}
	if onCard(*device, target) {
		return nil, refuse("An image cannot be saved onto the card it is copied from.", "bad-destination")
	}
	// Known before a byte is read, so said now rather than when the drive fills an hour in.
	space := destination.Check(target, device.SizeBytes)
	if space.Exists && !req.Replace {
		return nil, refuse("A file already exists at "+target+".", "bad-destination")
	}
	if !space.Fits {
		return nil, refuse(space.Problem, "no-space")
	}
	// An image runs for up to an hour, so it can be stopped: by the page, or by the page going.
	stop, done := d.stoppable(req.ID)
	defer done()
	job := jobs.Job{Kind: jobs.KindImage, Destination: target, Stop: stop,
		Targets: []jobs.Target{{Device: *device, Fingerprint: grant.Fingerprint(*device), RawPath: d.Plat.RawPath(*device)}}}
	result, err := d.long(req, func(report jobs.Reporter) (jobs.Result, error) {
		return d.Execute(job, []string{d.Plat.RawPath(*device)}, report, "copy "+describeCard(*device)+" to an image file")
	})
	if err != nil {
		return nil, err
	}
	if result.Error != "" {
		return nil, &jobs.Failed{Message: result.Error, Code: result.Code}
	}
	return reply{"report": result.Image}, nil
}

// long runs work while emitting a heartbeat, and forwards the work's own progress.
//
// Formatting, probing, fsck and imaging all run for minutes, often with nothing measurable to
// report. The page times out on silence rather than duration, so the heartbeat is what keeps
// a slow but healthy operation alive.
func (d *Dispatcher) long(req protocol.Request, work func(jobs.Reporter) (jobs.Result, error)) (jobs.Result, error) {
	return withHeartbeat(d, req, work)
}

func withHeartbeat[T any](d *Dispatcher, req protocol.Request, work func(jobs.Reporter) (T, error)) (T, error) {
	started := time.Now()
	var mu sync.Mutex
	last := protocol.TaskProgress{Op: req.Op, Note: "Starting."}
	send := func(p protocol.TaskProgress) {
		p.ElapsedMs = time.Since(started).Milliseconds()
		if d.Send != nil {
			d.Send(protocol.Progress{ID: req.ID, Progress: p})
		}
	}
	var sentAt time.Time
	report := func(u jobs.Update) {
		mu.Lock()
		changed := u.Stage != last.Stage || u.Device != last.Device
		last = protocol.TaskProgress{Op: req.Op, Note: u.Note, Stage: u.Stage, Device: u.Device, BytesCopied: u.Done, TotalBytes: u.Total, BadSectors: u.BadSectors}
		p := last
		// Thinned to a few a second; a new stage or a finished one always goes through.
		due := changed || u.Done == u.Total || time.Since(sentAt) >= 200*time.Millisecond
		if due {
			sentAt = time.Now()
		}
		mu.Unlock()
		if due {
			send(p)
		}
	}
	send(last)
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(protocol.HeartbeatIntervalMs * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				mu.Lock()
				p := last
				mu.Unlock()
				send(p)
			}
		}
	}()
	defer close(stop)
	return work(report)
}

// eligible is every device the page may see. Anything else is invisible, not merely refused.
func (d *Dispatcher) eligible() ([]platform.Device, error) {
	devices, err := d.Plat.ListDevices()
	if err != nil {
		return nil, err
	}
	out := []platform.Device{}
	for _, device := range devices {
		if safety.Eligible(device) {
			out = append(out, device)
		}
	}
	return out, nil
}

func (d *Dispatcher) writable(id string) (*platform.Device, error) {
	devices, err := d.Plat.ListDevices()
	if err != nil {
		return nil, err
	}
	device := find(devices, id)
	return device, safety.RequireWritable(device, id)
}

// readable is writable's check for operations that only read: the same rules, because a
// device the page may not write is one it has no business reading raw either.
func (d *Dispatcher) readable(id string) (*platform.Device, error) { return d.writable(id) }

func (d *Dispatcher) holding(volumeID string) (*platform.Device, *platform.Volume, error) {
	devices, err := d.Plat.ListDevices()
	if err != nil {
		return nil, nil, err
	}
	for i := range devices {
		for j := range devices[i].Volumes {
			if devices[i].Volumes[j].ID == volumeID {
				if err := safety.RequireWritable(&devices[i], devices[i].ID); err != nil {
					return nil, nil, err
				}
				return &devices[i], &devices[i].Volumes[j], nil
			}
		}
	}
	return nil, nil, refuse(fmt.Sprintf("No connected card holds a volume called %s.", volumeID), "unknown-device")
}

func find(devices []platform.Device, id string) *platform.Device {
	for i := range devices {
		if devices[i].ID == id {
			return &devices[i]
		}
	}
	return nil
}

func findVolume(devices []platform.Device, id string) *platform.Volume {
	for i := range devices {
		for j := range devices[i].Volumes {
			if devices[i].Volumes[j].ID == id {
				return &devices[i].Volumes[j]
			}
		}
	}
	return nil
}

func accessible(path string) bool {
	// For tests: a disk image as a real card is, whose raw device needs the password, so a
	// quick read skips its layout (test/e2e sets it).
	if os.Getenv("A3EM_HELPER_TEST_NEEDS_ADMIN") != "" {
		return false
	}
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
		return true
	}
	return blockdev.CanAccess(path)
}

// imageName is an image's file name: the card's label, or its device, and when it was made.
func imageName(device platform.Device) string {
	name := device.ID
	if len(device.Volumes) > 0 && device.Volumes[0].Label != nil {
		name = *device.Volumes[0].Label
	}
	return fmt.Sprintf("%s %s.img", sanitize(name), time.Now().Format("2006-01-02 150405"))
}

// onCard is whether path is on one of the card's own volumes.
func onCard(device platform.Device, path string) bool {
	for _, v := range device.Volumes {
		if v.MountPoint != nil && strings.HasPrefix(path, strings.TrimSuffix(*v.MountPoint, string(filepath.Separator))+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func describeCard(device platform.Device) string {
	return fmt.Sprintf("the %s card %s", safety.FormatSize(device.SizeBytes), device.Node)
}

func sizeOrUnknown(value *int64) string {
	if value == nil {
		return "unknown"
	}
	return fmt.Sprintf("%d-byte", *value)
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9 _-]+`)

func sanitize(name string) string {
	clean := strings.TrimSpace(unsafeName.ReplaceAllString(name, "_"))
	if clean == "" {
		return "card"
	}
	return clean
}

func nonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func refuse(message, code string) error { return &safety.Refused{Message: message, Code: code} }

func asFailure(id string, err error) protocol.Failure {
	var refused *safety.Refused
	var failed *jobs.Failed
	var command *platform.CommandError
	var missing *platform.NotImplemented
	switch {
	case errors.As(err, &refused):
		return protocol.Failure{ID: id, Error: refused.Message, Code: refused.Code}
	case errors.As(err, &failed):
		return protocol.Failure{ID: id, Error: failed.Message, Code: failed.Code, Detail: truncate(failed.Detail)}
	case errors.As(err, &command):
		return protocol.Failure{ID: id, Error: command.Message, Code: "platform-error", Detail: truncate(command.Output)}
	case errors.As(err, &missing):
		return protocol.Failure{ID: id, Error: fmt.Sprintf("%s is not available on %s yet.", missing.Operation, missing.Platform), Code: "not-implemented", Detail: missing.Plan}
	case errors.Is(err, blockdev.ErrWriteProtected):
		return protocol.Failure{ID: id, Error: "The card is write-protected. Slide the lock switch on its side away from LOCK, then reinsert it.", Code: "write-protected"}
	}
	return protocol.Failure{ID: id, Error: err.Error(), Code: "unexpected"}
}

func truncate(text string) string {
	if len(text) > 4000 {
		return text[:4000]
	}
	return text
}

// rename names a card: nothing on it changes but its name, so it needs no confirmation, as
// writing its configuration needs none. A card already so named is left alone.
func (d *Dispatcher) rename(req protocol.Request) (reply, error) {
	device, volume, err := d.holding(req.Volume)
	if err != nil {
		return nil, err
	}
	if problems := rules.ValidateLabel(req.Label); len(problems) > 0 {
		return nil, refuse(strings.Join(problems, " "), "bad-request")
	}
	label := strings.TrimSpace(req.Label)
	if volume.Label != nil && *volume.Label == label {
		return reply{"renamed": false}, nil
	}
	if runtime.GOOS != "windows" {
		if err := d.Plat.Rename(volume.ID, label); err != nil {
			return nil, err
		}
		return reply{"renamed": true}, nil
	}
	job := jobs.Job{Kind: jobs.KindRename, Volume: volume.ID, Label: label,
		Targets: []jobs.Target{{Device: *device, Fingerprint: grant.Fingerprint(*device), RawPath: d.Plat.RawPath(*device)}}}
	result, err := d.long(req, func(report jobs.Reporter) (jobs.Result, error) {
		return d.Execute(job, []string{d.Plat.VolumeRawPath(volume.ID)}, report, "rename "+describeCard(*device))
	})
	if err != nil {
		return nil, err
	}
	if result.Error != "" {
		return nil, &jobs.Failed{Message: result.Error, Code: result.Code, Detail: result.Detail}
	}
	return reply{"renamed": true}, nil
}
