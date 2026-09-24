package destination

import (
	"errors"
	"os"
	"testing"
)

// TestTheRealPortal shows the desktop portal's save dialog, for a person — or a script driving
// the screen — to answer: A3EM_TEST_REAL_PORTAL=1 go test -run TestTheRealPortal -v. It starts in
// A3EM_TEST_PORTAL_DIR (the temporary folder otherwise) with "card.img" filled in, and says what
// was chosen, or that the dialog was closed.
func TestTheRealPortal(t *testing.T) {
	if os.Getenv("A3EM_TEST_REAL_PORTAL") != "1" {
		t.Skip("shows a dialog; set A3EM_TEST_REAL_PORTAL=1 on a desktop to run it")
	}
	dir := os.Getenv("A3EM_TEST_PORTAL_DIR")
	if dir == "" {
		dir = t.TempDir()
	}
	t.Logf("portal known to the bus: %v", HasPortal())
	path, err := choosePortal(dir, "card.img", "Where should the image of the test card be saved?")
	switch {
	case errors.Is(err, ErrCanceled):
		t.Log("result: canceled")
	case err != nil:
		t.Fatalf("result: error: %v", err)
	default:
		t.Logf("result: chosen %s", path)
	}
}
