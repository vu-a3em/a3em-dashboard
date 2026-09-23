package dispatch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/exfat"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/grant"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/jobs"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/ledger"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
)

// fake is a computer with a startup disk, an external drive and one card, the card backed by
// a sparse file so that everything above the platform runs for real.
type fake struct {
	mu      sync.Mutex
	image   string
	mount   string
	card    platform.Device
	mounted bool
	label   string
	cluster int64
}

func newFake(t *testing.T) *fake {
	dir := t.TempDir()
	image := filepath.Join(dir, "card.img")
	file, _ := os.Create(image)
	file.Truncate(2 << 30)
	file.Close()
	mount := filepath.Join(dir, "mnt")
	os.Mkdir(mount, 0o755)
	return &fake{image: image, mount: mount, card: platform.Device{
		ID: "disk4", Node: "/dev/disk4", SizeBytes: 2 << 30, Removable: true, Bus: "Secure Digital",
		PartitionScheme: platform.SchemeNone, Volumes: []platform.Volume{},
	}}
}

func (f *fake) ID() string { return "fake" }
func (f *fake) ListDevices() ([]platform.Device, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	card := f.card
	if f.mounted {
		label, fs := f.label, "exfat"
		mount := f.mount
		card.PartitionScheme = platform.SchemeMBR
		card.Volumes = []platform.Volume{{ID: "disk4s1", Node: "/dev/disk4s1", Label: &label, Filesystem: &fs,
			MountPoint: &mount, AllocationUnitBytes: &f.cluster, Mountable: true, UUID: "UUID-1"}}
	}
	return []platform.Device{
		{ID: "disk0", SizeBytes: 500 << 30, Internal: true, IsBootDevice: true, Bus: "Apple Fabric"},
		{ID: "disk6", SizeBytes: 2000 << 30, Bus: "USB"},
		card,
	}, nil
}
func (f *fake) Inspect(string) (platform.Geometry, error) {
	fs := "exfat"
	return platform.Geometry{PartitionScheme: platform.SchemeMBR, Filesystem: &fs, AllocationUnitBytes: &f.cluster, Mountable: true}, nil
}
func (f *fake) Mount(string) error   { return nil }
func (f *fake) Unmount(string) error { return nil }
func (f *fake) Eject(string) error   { return nil }
func (f *fake) Diagnose(string) (platform.FsckReport, error) {
	return platform.FsckReport{Clean: true}, nil
}
func (f *fake) Repair(string) (platform.FsckReport, error) {
	return platform.FsckReport{Clean: true, Modified: true}, nil
}
func (f *fake) Identity(platform.Device) platform.Identity {
	return platform.Identity{Source: "reader"}
}
func (f *fake) RawPath(platform.Device) string          { return f.image }
func (f *fake) VolumeRawPath(string) string             { return f.image }
func (f *fake) Release(platform.Device) (func(), error) { return func() {}, nil }
func (f *fake) Reread(platform.Device) error            { return nil }
func (f *fake) Elevate(string, []string, string) (platform.Command, error) {
	return platform.Command{}, nil
}

// Settle reads back the label and cluster size the format wrote, as a real system would.
func (f *fake) Settle(platform.Device) (string, error) {
	dev, err := os.Open(f.image)
	if err != nil {
		return "", err
	}
	defer dev.Close()
	vbr := make([]byte, 512)
	dev.ReadAt(vbr, exfat.PartitionStartSector*512)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cluster = int64(512) << vbr[0x6d]
	f.label = f.pendingLabel()
	f.mounted = true
	return "disk4s1", nil
}

// pendingLabel is the label in the root directory's volume label entry.
func (f *fake) pendingLabel() string {
	dev, _ := blockOpen(f.image)
	defer dev.Close()
	check, _ := exfat.Verify(dev)
	return check.Label
}

func newDispatcher(t *testing.T, plat platform.Platform) (*Dispatcher, *[]any) {
	state := t.TempDir()
	var sent []any
	var mu sync.Mutex
	d := &Dispatcher{Plat: plat, Grants: &grant.Store{Dir: state, Now: time.Now}, Ledger: &ledger.Store{Dir: state}, Version: "test",
		Send: func(m any) { mu.Lock(); sent = append(sent, m); mu.Unlock() }}
	d.Execute = func(job jobs.Job, paths []string, report jobs.Reporter, reason string) (jobs.Result, error) {
		return jobs.Run(job, plat, report), nil
	}
	return d, &sent
}

func call(t *testing.T, d *Dispatcher, request map[string]any) map[string]any {
	t.Helper()
	request["id"] = "t"
	raw, _ := json.Marshal(request)
	out, _ := json.Marshal(d.Handle(raw))
	var reply map[string]any
	json.Unmarshal(out, &reply)
	return reply
}

func TestOnlyTheCardIsVisible(t *testing.T) {
	d, _ := newDispatcher(t, newFake(t))
	reply := call(t, d, map[string]any{"op": "listDevices"})
	devices := reply["devices"].([]any)
	if len(devices) != 1 || devices[0].(map[string]any)["id"] != "disk4" {
		t.Fatalf("listed %v", devices)
	}
	for _, id := range []string{"disk0", "disk6", "disk9"} {
		if reply := call(t, d, map[string]any{"op": "challenge", "device": id, "operation": "format"}); reply["ok"] != false {
			t.Errorf("a challenge was issued for %s", id)
		}
	}
}

func TestPrepareTestsFormatsVerifiesAndWritesTheConfig(t *testing.T) {
	plat := newFake(t)
	d, sent := newDispatcher(t, plat)
	challenge := call(t, d, map[string]any{"op": "challenge", "device": "disk4", "operation": "prepare"})
	if !strings.Contains(challenge["description"].(string), "/dev/disk4") {
		t.Fatalf("challenge %v", challenge)
	}
	config := "DEVICE_LABEL = FIELD1\n"
	target := map[string]any{"device": "disk4", "grant": challenge["token"], "allocationUnitBytes": 32768, "label": "FIELD1", "config": config}
	reply := call(t, d, map[string]any{"op": "prepare", "targets": []any{target}})
	if reply["ok"] != true {
		t.Fatalf("prepare failed: %v", reply)
	}
	card := reply["results"].([]any)[0].(map[string]any)
	if card["error"] != nil || card["formatted"] != true || card["configWritten"] != true {
		t.Fatalf("card %v", card)
	}
	if card["capacity"].(map[string]any)["verdict"] != "genuine" || card["layout"].(map[string]any)["reference"] != true {
		t.Fatalf("card %v", card)
	}
	if written, _ := os.ReadFile(filepath.Join(plat.mount, "_a3em.cfg")); string(written) != config {
		t.Fatalf("config on card: %q", written)
	}
	if len(*sent) < 3 {
		t.Fatalf("only %d progress messages", len(*sent))
	}
	// The same confirmation cannot be used again.
	if again := call(t, d, map[string]any{"op": "prepare", "targets": []any{target}}); again["code"] != "bad-grant" {
		t.Fatalf("a spent grant was accepted: %v", again)
	}

	readiness := call(t, d, map[string]any{"op": "readiness", "device": "disk4"})["readiness"].(map[string]any)
	if readiness["config"].(map[string]any)["text"] != config {
		t.Fatalf("readiness config %v", readiness["config"])
	}
	if readiness["prepared"] == nil || readiness["layout"].(map[string]any)["reference"] != true {
		t.Fatalf("readiness %v", readiness)
	}
	if contents := readiness["contents"].(map[string]any); contents["files"].(float64) != 0 {
		t.Fatalf("contents %v", contents)
	}
}

func TestPrepareRefusesBeforeSpendingAnything(t *testing.T) {
	plat := newFake(t)
	d, _ := newDispatcher(t, plat)
	token := call(t, d, map[string]any{"op": "challenge", "device": "disk4", "operation": "prepare"})["token"]
	bad := call(t, d, map[string]any{"op": "prepare", "targets": []any{
		map[string]any{"device": "disk4", "grant": token, "allocationUnitBytes": 12345, "label": "A3EM"},
	}})
	if bad["code"] != "bad-request" {
		t.Fatalf("a bad allocation unit was accepted: %v", bad)
	}
	// The refusal did not spend the confirmation.
	good := call(t, d, map[string]any{"op": "prepare", "skipCapacityProbe": true, "skipLatencyTest": true, "targets": []any{
		map[string]any{"device": "disk4", "grant": token, "allocationUnitBytes": 4096, "label": "A3EM"},
	}})
	if good["ok"] != true {
		t.Fatalf("prepare after a refusal failed: %v", good)
	}

	plat.card.WriteProtected = true
	token = call(t, d, map[string]any{"op": "challenge", "device": "disk4", "operation": "prepare"})["token"]
	locked := call(t, d, map[string]any{"op": "prepare", "targets": []any{
		map[string]any{"device": "disk4", "grant": token, "allocationUnitBytes": 4096, "label": "A3EM"},
	}})
	if locked["code"] != "write-protected" {
		t.Fatalf("a locked card was accepted: %v", locked)
	}
}

func TestIdentifyNeedsExactlyOneMarker(t *testing.T) {
	plat := newFake(t)
	plat.mounted, plat.label, plat.cluster = true, "A3EM", 4096
	d, _ := newDispatcher(t, plat)
	probe := ".a3em-probe-01234567-89ab-cdef-0123-456789abcdef"
	if reply := call(t, d, map[string]any{"op": "identify", "probe": "../../etc/passwd"}); reply["ok"] != false {
		t.Fatal("a path was accepted as a probe name")
	}
	if reply := call(t, d, map[string]any{"op": "identify", "probe": probe}); reply["code"] != "no-probe-match" {
		t.Fatalf("identified without a marker: %v", reply)
	}
	os.WriteFile(filepath.Join(plat.mount, probe), nil, 0o644)
	if reply := call(t, d, map[string]any{"op": "identify", "probe": probe}); reply["device"] != "disk4" || reply["volume"] != "disk4s1" {
		t.Fatalf("identify %v", reply)
	}
}

func TestReadinessOfSeveralCardsInOneCall(t *testing.T) {
	plat := newFake(t)
	plat.mounted, plat.label, plat.cluster = true, "A3EM", 4096
	d, _ := newDispatcher(t, plat)
	reply := call(t, d, map[string]any{"op": "readiness", "devices": []string{"disk4"}, "deep": true})
	reports, ok := reply["readiness"].([]any)
	if !ok || len(reports) != 1 {
		t.Fatalf("readiness %v", reply)
	}
	if reports[0].(map[string]any)["device"].(map[string]any)["id"] != "disk4" {
		t.Fatalf("report %v", reports[0])
	}
	if refused := call(t, d, map[string]any{"op": "readiness", "devices": []string{"disk4", "disk0"}}); refused["ok"] != false {
		t.Fatal("the startup disk was checked")
	}
}
