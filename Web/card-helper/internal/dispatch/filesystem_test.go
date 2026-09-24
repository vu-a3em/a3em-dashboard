package dispatch

import (
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/exfat"
	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/protocol"
)

// prepared is the fake card as the helper's own preparation leaves it, and open.
func prepared(t *testing.T) (*fake, *Dispatcher) {
	t.Helper()
	plat := newFake(t)
	d, _ := newDispatcher(t, plat)
	challenge := call(t, d, map[string]any{"op": "challenge", "device": "disk4", "operation": "prepare"})
	target := map[string]any{"device": "disk4", "grant": challenge["token"], "allocationUnitBytes": 4096, "label": "FIELD1", "config": "DEVICE_LABEL = FIELD1\n"}
	if reply := call(t, d, map[string]any{"op": "prepare", "targets": []any{target}}); reply["ok"] != true {
		t.Fatalf("prepare failed: %v", reply)
	}
	return plat, d
}

func TestTheCheckIsTheHelpersOwn(t *testing.T) {
	_, d := prepared(t)
	reply := call(t, d, map[string]any{"op": "diagnose", "volume": "disk4s1"})
	report, ok := reply["report"].(map[string]any)
	if !ok || report["engine"] != "a3em" || report["clean"] != true {
		t.Fatalf("want a clean report from the helper's own check: %v", reply)
	}
}

func TestADamagedBootRegionIsRepairedHereAndWhatItReplacedIsSaved(t *testing.T) {
	plat, d := prepared(t)
	// The main boot region's checksum sector, zeroed: the card would not open.
	file, err := os.OpenFile(plat.image, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	file.WriteAt(make([]byte, 512), (exfat.PartitionStartSector+11)*512)
	file.Close()

	check := call(t, d, map[string]any{"op": "diagnose", "volume": "disk4s1"})["report"].(map[string]any)
	findings, _ := check["findings"].([]any)
	if check["clean"] != false || check["fixableHere"] != true || len(findings) != 1 || findings[0].(map[string]any)["kind"] != "boot-region" {
		t.Fatalf("want one boot-region finding, fixable here: %v", check)
	}

	challenge := call(t, d, map[string]any{"op": "challenge", "device": "disk4", "operation": "repair"})
	reply := call(t, d, map[string]any{"op": "repair", "device": "disk4", "volume": "disk4s1", "grant": challenge["token"]})
	report, ok := reply["report"].(map[string]any)
	if !ok || report["engine"] != "a3em" || report["modified"] != true || report["clean"] != true {
		t.Fatalf("want the helper's own repair to leave the card clean: %v", reply)
	}
	if repaired, _ := report["repaired"].([]any); len(repaired) != 1 || repaired[0] != "boot" {
		t.Fatalf("repaired %v", report["repaired"])
	}
	saved, _ := report["saved"].([]any)
	if len(saved) != 1 {
		t.Fatalf("saved %v", report["saved"])
	}
	if data, err := os.ReadFile(saved[0].(string)); err != nil || len(data) != 12*512 {
		t.Fatalf("the damaged boot region should be saved, twelve sectors: %d bytes, %v", len(data), err)
	}
	if again := call(t, d, map[string]any{"op": "diagnose", "volume": "disk4s1"})["report"].(map[string]any); again["clean"] != true {
		t.Fatalf("still damaged after the repair: %v", again)
	}
}

func TestStopReachesOnlyWhatIsRunning(t *testing.T) {
	d, _ := newDispatcher(t, newFake(t))
	stop, done := d.stoppable("copy-1")
	defer done()
	if reply := call(t, d, map[string]any{"op": "stop", "target": "nothing"}); reply["stopping"] != false {
		t.Fatalf("stopping nothing: %v", reply)
	}
	if reply := call(t, d, map[string]any{"op": "stop", "target": "copy-1"}); reply["stopping"] != true {
		t.Fatalf("stop: %v", reply)
	}
	select {
	case <-stop:
	default:
		t.Fatal("the running request was not told to stop")
	}
	// Twice is harmless.
	if reply := call(t, d, map[string]any{"op": "stop", "target": "copy-1"}); reply["stopping"] != false {
		t.Fatalf("second stop: %v", reply)
	}
}

func TestAStoppedImageLeavesNothingBehind(t *testing.T) {
	plat := newFake(t)
	d, _ := newDispatcher(t, plat)
	// Stopped as soon as the copy is under way, from the progress it reports.
	var once sync.Once
	d.Send = func(message any) {
		if progress, ok := message.(protocol.Progress); ok && progress.Progress.BytesCopied > 0 {
			once.Do(func() { d.Stop("t") })
		}
	}
	target := filepath.Join(t.TempDir(), "card.img")
	reply := call(t, d, map[string]any{"op": "image", "device": "disk4", "destination": target})
	if reply["ok"] != false || reply["code"] != "stopped" {
		t.Fatalf("want the copy stopped: %v", reply)
	}
	for _, path := range []string{target, target + ".partial"} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s was left behind", filepath.Base(path))
		}
	}
}
