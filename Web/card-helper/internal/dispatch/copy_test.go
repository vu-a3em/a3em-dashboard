package dispatch

import (
	"os"
	"path/filepath"
	"testing"
)

// mountedCard is a fake with its card mounted and a recording on it, plus a folder somewhere
// else to copy into.
func mountedCard(t *testing.T) (*Dispatcher, *fake, string) {
	t.Helper()
	plat := newFake(t)
	plat.mounted = true
	if err := os.MkdirAll(filepath.Join(plat.mount, "LBL/Activation_0001"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plat.mount, "LBL/Activation_0001/a.wav"), []byte("clip"), 0o644); err != nil {
		t.Fatal(err)
	}
	d, _ := newDispatcher(t, plat)
	return d, plat, t.TempDir()
}

// volumeID is what the fake calls its mounted volume.
func volumeID(t *testing.T, d *Dispatcher) string {
	t.Helper()
	devices, err := d.Plat.ListDevices()
	if err != nil {
		t.Fatal(err)
	}
	for _, device := range devices {
		for _, volume := range device.Volumes {
			if volume.MountPoint != nil {
				return volume.ID
			}
		}
	}
	t.Fatal("the fake card has no mounted volume")
	return ""
}

func file(from, to string, bytes int64) map[string]any {
	return map[string]any{"from": from, "to": to, "bytes": bytes}
}

func TestCopyMovesTheListedFiles(t *testing.T) {
	d, _, dest := mountedCard(t)
	reply := call(t, d, map[string]any{"op": "copy", "volume": volumeID(t, d), "destination": dest,
		"files": []any{file("LBL/Activation_0001/a.wav", "LBL/Activation_0001/a.wav", 4)}})

	if reply["ok"] != true {
		t.Fatalf("copy refused: %v", reply["error"])
	}
	body, err := os.ReadFile(filepath.Join(dest, "LBL/Activation_0001/a.wav"))
	if err != nil || string(body) != "clip" {
		t.Fatalf("the copy is %q (%v)", body, err)
	}
}

func TestCopyRefusesTheCardItComesFrom(t *testing.T) {
	/*
		Copying a card onto itself fills it with itself, and the free-space check cannot
		catch it: the space disappears as the copy consumes it.
	*/
	d, plat, _ := mountedCard(t)
	reply := call(t, d, map[string]any{"op": "copy", "volume": volumeID(t, d),
		"destination": filepath.Join(plat.mount, "backup"),
		"files":       []any{file("LBL/Activation_0001/a.wav", "a.wav", 4)}})

	if reply["ok"] == true {
		t.Fatal("a copy onto the source card was allowed")
	}
	if reply["code"] != "bad-destination" {
		t.Fatalf("refused with %v", reply["code"])
	}
}

func TestCopyRefusesARelativeDestination(t *testing.T) {
	d, _, _ := mountedCard(t)
	reply := call(t, d, map[string]any{"op": "copy", "volume": volumeID(t, d), "destination": "somewhere",
		"files": []any{file("a.wav", "a.wav", 4)}})

	if reply["ok"] == true || reply["code"] != "bad-destination" {
		t.Fatalf("relative destination gave %v / %v", reply["ok"], reply["code"])
	}
}

func TestCopyRefusesADestinationThatIsNotThere(t *testing.T) {
	d, _, dest := mountedCard(t)
	reply := call(t, d, map[string]any{"op": "copy", "volume": volumeID(t, d),
		"destination": filepath.Join(dest, "not-created"),
		"files":       []any{file("a.wav", "a.wav", 4)}})

	if reply["ok"] == true || reply["code"] != "bad-destination" {
		t.Fatalf("missing destination gave %v / %v", reply["ok"], reply["code"])
	}
}

func TestCopyRefusesAnEmptyList(t *testing.T) {
	// Not an error worth silence: a copy of nothing means the page and the helper disagree
	// about what is on the card.
	d, _, dest := mountedCard(t)
	reply := call(t, d, map[string]any{"op": "copy", "volume": volumeID(t, d), "destination": dest})

	if reply["ok"] == true || reply["code"] != "bad-request" {
		t.Fatalf("empty list gave %v / %v", reply["ok"], reply["code"])
	}
}

func TestCopyAcceptsAReportOnItsOwn(t *testing.T) {
	// The account of a copy depends on what the copy did, so it is deposited afterwards.
	d, _, dest := mountedCard(t)
	reply := call(t, d, map[string]any{"op": "copy", "volume": volumeID(t, d), "destination": dest,
		"report": "two files were skipped\n"})

	if reply["ok"] != true {
		t.Fatalf("report-only copy refused: %v", reply["error"])
	}
	body, err := os.ReadFile(filepath.Join(dest, "a3em-copy-report.txt"))
	if err != nil || string(body) != "two files were skipped\n" {
		t.Fatalf("report is %q (%v)", body, err)
	}
}

func TestCopyRefusesAnUnknownVolume(t *testing.T) {
	d, _, dest := mountedCard(t)
	reply := call(t, d, map[string]any{"op": "copy", "volume": "nowhere", "destination": dest,
		"files": []any{file("a.wav", "a.wav", 4)}})

	if reply["ok"] == true || reply["code"] != "unknown-device" {
		t.Fatalf("unknown volume gave %v / %v", reply["ok"], reply["code"])
	}
}

func TestCopyWritesItsReportBesideTheCopy(t *testing.T) {
	d, _, dest := mountedCard(t)
	reply := call(t, d, map[string]any{"op": "copy", "volume": volumeID(t, d), "destination": dest,
		"files":  []any{file("LBL/Activation_0001/a.wav", "a.wav", 4)},
		"report": "one file was skipped\n"})

	if reply["ok"] != true {
		t.Fatalf("copy refused: %v", reply["error"])
	}
	body, err := os.ReadFile(filepath.Join(dest, "a3em-copy-report.txt"))
	if err != nil || string(body) != "one file was skipped\n" {
		t.Fatalf("report is %q (%v)", body, err)
	}
}

func TestCopyReportsProgressWhileItRuns(t *testing.T) {
	plat := newFake(t)
	plat.mounted = true
	os.MkdirAll(filepath.Join(plat.mount, "d"), 0o755)
	os.WriteFile(filepath.Join(plat.mount, "d/a.wav"), []byte("clip"), 0o644)
	d, sent := newDispatcher(t, plat)

	reply := call(t, d, map[string]any{"op": "copy", "volume": volumeID(t, d), "destination": t.TempDir(),
		"files": []any{file("d/a.wav", "d/a.wav", 4)}})
	if reply["ok"] != true {
		t.Fatalf("copy refused: %v", reply["error"])
	}
	// The page times out on silence rather than duration, so something has to be said.
	if len(*sent) == 0 {
		t.Fatal("a copy reported no progress at all")
	}
}
