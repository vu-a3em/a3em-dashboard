package grant

import (
	"strings"
	"testing"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
)

func card() platform.Device {
	return platform.Device{ID: "disk4", Node: "/dev/disk4", SizeBytes: 64 << 30, Bus: "USB", Removable: true}
}

func TestAGrantWorksOnceAcrossProcesses(t *testing.T) {
	dir := t.TempDir()
	issuer := &Store{Dir: dir, Now: time.Now}
	token, description, _, err := issuer.Issue(card(), "prepare")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(description, "/dev/disk4") {
		t.Fatalf("description %q does not name the disk", description)
	}
	// A different Store over the same directory stands in for the next helper process.
	redeemer := &Store{Dir: dir, Now: time.Now}
	if err := redeemer.Redeem(token, "prepare", card()); err != nil {
		t.Fatal(err)
	}
	if err := redeemer.Redeem(token, "prepare", card()); err == nil {
		t.Fatal("a grant was accepted twice")
	}
}

func TestAGrantIsBoundToItsTerms(t *testing.T) {
	store := &Store{Dir: t.TempDir(), Now: time.Now}
	token, _, _, _ := store.Issue(card(), "format")
	if store.Redeem(token, "repair", card()) == nil {
		t.Fatal("a format grant redeemed a repair")
	}
	token, _, _, _ = store.Issue(card(), "format")
	swapped := card()
	swapped.SizeBytes = 128 << 30
	if store.Redeem(token, "format", swapped) == nil {
		t.Fatal("a grant survived a card swap")
	}
	token, _, _, _ = store.Issue(card(), "format")
	if store.Redeem(token[:len(token)-2]+"xx", "format", card()) == nil {
		t.Fatal("a forged signature was accepted")
	}
	later := &Store{Dir: store.Dir, Now: func() time.Time { return time.Now().Add(2 * TTL) }}
	token, _, _, _ = store.Issue(card(), "format")
	if later.Redeem(token, "format", card()) == nil {
		t.Fatal("an expired grant was accepted")
	}
}
