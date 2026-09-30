package copyout

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// card builds a source tree and returns its root.
func card(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, body := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func list(t *testing.T, root string, names ...string) []File {
	t.Helper()
	out := make([]File, 0, len(names))
	for _, name := range names {
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, File{From: name, To: name, Bytes: info.Size()})
	}
	return out
}

func read(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestCopiesTheListedFiles(t *testing.T) {
	src := card(t, map[string]string{
		"LBL/Activation_0001/1/2/a.wav": "aaaa",
		"LBL/Activation_0001/1/2/b.wav": "bbbbbb",
		"LBL/ignored.txt":               "no",
	})
	dst := t.TempDir()

	report, err := Run(list(t, src, "LBL/Activation_0001/1/2/a.wav", "LBL/Activation_0001/1/2/b.wav"),
		Options{Source: src, Destination: dst})
	if err != nil {
		t.Fatal(err)
	}
	if report.Copied != 2 || report.BytesCopied != 10 {
		t.Fatalf("copied %d files / %d bytes, want 2 / 10", report.Copied, report.BytesCopied)
	}
	if len(report.Skipped) != 0 {
		t.Fatalf("unexpected skips: %v", report.Skipped)
	}
	if got := read(t, filepath.Join(dst, "LBL/Activation_0001/1/2/a.wav")); got != "aaaa" {
		t.Fatalf("a.wav is %q", got)
	}
	// Only what was listed: the walk is the page's job, not this package's.
	if _, err := os.Stat(filepath.Join(dst, "LBL/ignored.txt")); !os.IsNotExist(err) {
		t.Fatal("copied a file that was not on the list")
	}
}

func TestRenamesOnTheWayOut(t *testing.T) {
	// A clock correction renames the copy and leaves the card as the device wrote it.
	src := card(t, map[string]string{"d/1790118900.wav": "clip"})
	dst := t.TempDir()
	files := []File{{From: "d/1790118900.wav", To: "d/1790118937.wav", Bytes: 4}}

	if _, err := Run(files, Options{Source: src, Destination: dst}); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dst, "d/1790118937.wav")); got != "clip" {
		t.Fatalf("renamed copy is %q", got)
	}
	if _, err := os.Stat(filepath.Join(src, "d/1790118900.wav")); err != nil {
		t.Fatal("the card's own file was disturbed")
	}
}

func TestSecondRunSkipsWhatIsAlreadyThere(t *testing.T) {
	src := card(t, map[string]string{"a.wav": "aaaa", "b.wav": "bb"})
	dst := t.TempDir()
	files := list(t, src, "a.wav", "b.wav")

	if _, err := Run(files, Options{Source: src, Destination: dst}); err != nil {
		t.Fatal(err)
	}
	second, err := Run(files, Options{Source: src, Destination: dst})
	if err != nil {
		t.Fatal(err)
	}
	if second.AlreadyPresent != 2 || second.Copied != 0 {
		t.Fatalf("resume copied %d and skipped %d, want 0 and 2", second.Copied, second.AlreadyPresent)
	}
}

func TestRewritesAFileLeftAtTheWrongLength(t *testing.T) {
	// A copy interrupted mid-file leaves a short one. Matching on length is what notices.
	src := card(t, map[string]string{"a.wav": "aaaa"})
	dst := t.TempDir()
	if err := os.WriteFile(filepath.Join(dst, "a.wav"), []byte("aa"), 0o644); err != nil {
		t.Fatal(err)
	}
	report, err := Run(list(t, src, "a.wav"), Options{Source: src, Destination: dst})
	if err != nil {
		t.Fatal(err)
	}
	if report.Copied != 1 {
		t.Fatalf("copied %d, want 1", report.Copied)
	}
	if got := read(t, filepath.Join(dst, "a.wav")); got != "aaaa" {
		t.Fatalf("short file was not replaced: %q", got)
	}
}

func TestAppendsWhatTheDeviceNeverWrote(t *testing.T) {
	src := card(t, map[string]string{"a.wav": "head"})
	dst := t.TempDir()
	files := []File{{From: "a.wav", To: "a.wav", Bytes: 4, Append: []byte("tail")}}

	report, err := Run(files, Options{Source: src, Destination: dst})
	if err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dst, "a.wav")); got != "headtail" {
		t.Fatalf("recovered copy is %q", got)
	}
	if len(report.Recovered) != 1 {
		t.Fatalf("recovered %v", report.Recovered)
	}
	// And the card itself is untouched, which is the whole point of doing it here.
	if got := read(t, filepath.Join(src, "a.wav")); got != "head" {
		t.Fatalf("the card was written to: %q", got)
	}
}

func TestReplaceWritesOnlyTheRecoveredBytes(t *testing.T) {
	src := card(t, map[string]string{"a.imu": "lie"})
	dst := t.TempDir()
	files := []File{{From: "a.imu", To: "a.imu", Bytes: 3, Append: []byte("whole"), Replace: true}}

	if _, err := Run(files, Options{Source: src, Destination: dst}); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dst, "a.imu")); got != "whole" {
		t.Fatalf("replaced copy is %q", got)
	}
}

func TestOneUnreadableFileDoesNotEndTheCopy(t *testing.T) {
	/*
		A card being copied is often a card with something wrong. Stopping at the first
		failure would abandon everything after it, which is the opposite of what a rescue
		copy is for.
	*/
	src := card(t, map[string]string{"a.wav": "aaaa", "c.wav": "cccc"})
	dst := t.TempDir()
	files := []File{
		{From: "a.wav", To: "a.wav", Bytes: 4},
		{From: "missing.wav", To: "missing.wav", Bytes: 4},
		{From: "c.wav", To: "c.wav", Bytes: 4},
	}

	report, err := Run(files, Options{Source: src, Destination: dst})
	if err != nil {
		t.Fatal(err)
	}
	if report.Copied != 2 {
		t.Fatalf("copied %d, want the two that could be read", report.Copied)
	}
	if len(report.Skipped) != 1 || report.Skipped[0].Path != "missing.wav" {
		t.Fatalf("skips are %v", report.Skipped)
	}
	if got := read(t, filepath.Join(dst, "c.wav")); got != "cccc" {
		t.Fatal("the file after the failure was not copied")
	}
}

func TestStopEndsTheCopyAndKeepsWhatLanded(t *testing.T) {
	src := card(t, map[string]string{"a.wav": "aaaa", "b.wav": "bbbb"})
	dst := t.TempDir()
	stop := make(chan struct{})
	close(stop)

	report, err := Run(list(t, src, "a.wav", "b.wav"), Options{Source: src, Destination: dst, Stop: stop})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Canceled {
		t.Fatal("a stopped copy did not report itself canceled")
	}
	if report.Copied != 0 {
		t.Fatalf("copied %d after being stopped before the first file", report.Copied)
	}
}

func TestRefusesAPathThatClimbsOutOfTheFolder(t *testing.T) {
	// The list comes from the page, so a name in it is not trusted to stay inside the
	// folder the person chose.
	src := card(t, map[string]string{"a.wav": "aaaa"})
	dst := t.TempDir()
	outside := filepath.Join(dst, "..", "escaped.wav")

	report, err := Run([]File{{From: "a.wav", To: "../escaped.wav", Bytes: 4}},
		Options{Source: src, Destination: dst})
	if err != nil {
		t.Fatal(err)
	}
	if report.Copied != 0 || len(report.Skipped) != 1 {
		t.Fatalf("copied %d, skipped %v", report.Copied, report.Skipped)
	}
	if !strings.Contains(report.Skipped[0].Reason, "outside") {
		t.Fatalf("reason was %q", report.Skipped[0].Reason)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatal("a file was written outside the destination")
	}
}

func TestLeavesNoPartialBehind(t *testing.T) {
	src := card(t, map[string]string{"a.wav": "aaaa"})
	dst := t.TempDir()
	if _, err := Run(list(t, src, "a.wav"), Options{Source: src, Destination: dst}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dst)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".a3em-partial") {
			t.Fatalf("a temporary was left behind: %s", entry.Name())
		}
	}
}

func TestReportsProgressAsItGoes(t *testing.T) {
	src := card(t, map[string]string{"a.wav": "aaaa", "b.wav": "bbbb"})
	dst := t.TempDir()
	var last Progress
	seen := 0

	if _, err := Run(list(t, src, "a.wav", "b.wav"), Options{Source: src, Destination: dst,
		Report: func(p Progress) { seen++; last = p }}); err != nil {
		t.Fatal(err)
	}
	if seen == 0 {
		t.Fatal("no progress was reported")
	}
	// The last word is always the finished one, so a caller can trust it to close the bar.
	if last.FilesDone != 2 || last.BytesDone != 8 || last.FilesTotal != 2 {
		t.Fatalf("final progress was %+v", last)
	}
}

func TestSkippedListIsBounded(t *testing.T) {
	// The reply has to fit in Chrome's 1 MB limit whatever the card does.
	src := t.TempDir()
	dst := t.TempDir()
	files := make([]File, maxSkipped+50)
	for i := range files {
		files[i] = File{From: "gone.wav", To: "gone.wav", Bytes: 1}
	}
	report, err := Run(files, Options{Source: src, Destination: dst})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Skipped) != maxSkipped || !report.SkippedTruncated {
		t.Fatalf("kept %d skips, truncated=%v", len(report.Skipped), report.SkippedTruncated)
	}
}

func TestMendsAHeaderTheDeviceNeverFinished(t *testing.T) {
	// A clip cut short carries zeros where its own length belongs. The page works out the
	// two numbers; this writes them into the copy and leaves the card's header alone.
	src := card(t, map[string]string{"a.wav": "RIFF\x00\x00\x00\x00rest"})
	dst := t.TempDir()
	files := []File{{From: "a.wav", To: "a.wav", Bytes: 12,
		Patch: []Patch{{Offset: 4, Bytes: []byte{4, 3, 2, 1}}}}}

	if _, err := Run(files, Options{Source: src, Destination: dst}); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dst, "a.wav")); got != "RIFF\x04\x03\x02\x01rest" {
		t.Fatalf("mended copy is %q", got)
	}
	if got := read(t, filepath.Join(src, "a.wav")); got != "RIFF\x00\x00\x00\x00rest" {
		t.Fatalf("the card's own header was written to: %q", got)
	}
}

func TestRefusesAPatchAtANegativeOffset(t *testing.T) {
	src := card(t, map[string]string{"a.wav": "abcd"})
	dst := t.TempDir()
	report, err := Run([]File{{From: "a.wav", To: "a.wav", Bytes: 4,
		Patch: []Patch{{Offset: -1, Bytes: []byte{0}}}}}, Options{Source: src, Destination: dst})
	if err != nil {
		t.Fatal(err)
	}
	if report.Copied != 0 || len(report.Skipped) != 1 {
		t.Fatalf("copied %d, skipped %v", report.Copied, report.Skipped)
	}
}
