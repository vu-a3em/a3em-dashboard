package destination

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheck(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "card.img")

	if space := Check(path, 1<<20); !space.Fits || space.Exists || space.Problem != "" {
		t.Errorf("a small image in an empty folder should fit: %+v", space)
	}
	// Nothing has a petabyte free.
	if space := Check(path, 1<<50); space.Fits || !strings.Contains(space.Problem, "free there") {
		t.Errorf("an image larger than the drive should not fit, and say why: %+v", space)
	}
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if space := Check(path, 1<<20); !space.Exists {
		t.Errorf("a file already there should be reported: %+v", space)
	}
	if space := Check(filepath.Join(dir, "missing", "card.img"), 1<<20); space.Fits || space.Problem == "" {
		t.Errorf("a folder that does not exist cannot be used: %+v", space)
	}
}

func TestChosenAddsTheExtension(t *testing.T) {
	for in, want := range map[string]string{"/a/card": "/a/card.img", "/a/card.img": "/a/card.img", "/a/card.IMG": "/a/card.IMG", " ": ""} {
		if got := Chosen(in); got != want {
			t.Errorf("Chosen(%q) = %q, want %q", in, got, want)
		}
	}
}
