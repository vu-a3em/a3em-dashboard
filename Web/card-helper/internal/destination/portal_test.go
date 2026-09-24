package destination

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/dbus"
)

// portal stands in for the session bus and a portal on it.
type portal struct {
	matches []string
	calls   []string
	options map[string]dbus.Variant
	// answer is the portal's reply to SaveFile, given the request path it was asked for.
	answer func(requested string) ([]any, error)
	// response is the signal that follows, if any.
	response func(handle string) *dbus.Message
	handle   string
}

func (p *portal) Name() string { return ":1.42" }

func (p *portal) AddMatch(rule string) error {
	p.matches = append(p.matches, rule)
	return nil
}

func (p *portal) Call(destination, path, iface, member string, timeout time.Duration, sig string, args ...any) ([]any, error) {
	p.calls = append(p.calls, member+" "+path)
	switch member {
	case "SaveFile":
		p.options = args[2].(map[string]dbus.Variant)
		p.handle = requestPath(p.Name(), p.options["handle_token"].Value.(string))
		return p.answer(p.handle)
	case "NameHasOwner":
		return []any{false}, nil
	case "ListActivatableNames":
		return []any{[]string{"org.freedesktop.Notifications", portalName}}, nil
	}
	return nil, nil
}

func (p *portal) WaitSignal(match func(*dbus.Message) bool, timeout time.Duration) (*dbus.Message, error) {
	if p.response != nil {
		// Another request's answer first, which must be passed over.
		if stray := p.response(portalPath + "/request/1_42/someone_else"); stray != nil && match(stray) {
			return stray, nil
		}
		if m := p.response(p.handle); m != nil && match(m) {
			return m, nil
		}
	}
	return nil, dbus.ErrTimeout
}

func answered(code uint32, uris ...string) func(string) *dbus.Message {
	return func(handle string) *dbus.Message {
		return &dbus.Message{Path: handle, Interface: requestInterface, Member: "Response",
			Body: []any{code, map[string]any{"uris": dbus.Variant{Sig: "as", Value: uris}}}}
	}
}

func asked(handle string) ([]any, error) { return []any{handle}, nil }

func TestThePortalsChoiceIsTheFileChosen(t *testing.T) {
	p := &portal{answer: asked, response: answered(0, "file:///media/pat/Backup%20drive/OWL_01%202026.img")}
	path, err := saveFile(p, "/home/pat/Documents", "OWL_01 2026.img", "Where should the image be saved?", time.Second)
	if err != nil || path != "/media/pat/Backup drive/OWL_01 2026.img" {
		t.Fatalf("%q %v", path, err)
	}
	if len(p.matches) != 1 || !strings.Contains(p.matches[0], "path='"+p.handle+"'") {
		t.Fatalf("the response must be listened for, on its own path, before asking: %v", p.matches)
	}
	if !strings.HasPrefix(p.handle, portalPath+"/request/1_42/a3em") {
		t.Fatalf("request path %s", p.handle)
	}
	if folder := p.options["current_folder"].Value.([]byte); string(folder) != "/home/pat/Documents\x00" {
		t.Fatalf("the folder is a NUL-terminated byte string: %q", folder)
	}
	if p.options["current_name"].Value != "OWL_01 2026.img" {
		t.Fatalf("options %v", p.options)
	}
}

func TestClosingThePortalsDialogIsACancel(t *testing.T) {
	// Cancel, and Escape or the close button, which GNOME's dialog reports as "other".
	for _, code := range []uint32{1, 2} {
		p := &portal{answer: asked, response: answered(code)}
		if _, err := saveFile(p, "/home/pat", "a.img", "?", time.Second); !errors.Is(err, ErrCanceled) {
			t.Fatalf("response %d: want ErrCanceled: %v", code, err)
		}
	}
}

func TestWithoutAPortalAnotherDialogIsTried(t *testing.T) {
	p := &portal{answer: func(string) ([]any, error) {
		return nil, &dbus.Error{Name: "org.freedesktop.DBus.Error.ServiceUnknown"}
	}}
	if _, err := saveFile(p, "/home/pat", "a.img", "?", time.Second); !errors.Is(err, errNoPortal) {
		t.Fatalf("want errNoPortal: %v", err)
	}
}

func TestAnOldPortalsOwnRequestPathIsListenedTo(t *testing.T) {
	own := portalPath + "/request/1_42/t7"
	p := &portal{answer: func(string) ([]any, error) { return []any{own}, nil }}
	p.response = func(handle string) *dbus.Message {
		if handle == own || handle == p.handle {
			return answered(0, "file:///tmp/card.img")(own)
		}
		return nil
	}
	path, err := saveFile(p, "/tmp", "card.img", "?", time.Second)
	if err != nil || path != "/tmp/card.img" {
		t.Fatalf("%q %v", path, err)
	}
	if len(p.matches) != 2 || !strings.Contains(p.matches[1], own) {
		t.Fatalf("matches %v", p.matches)
	}
}

func TestADialogLeftOpenIsTakenDown(t *testing.T) {
	p := &portal{answer: asked}
	if _, err := saveFile(p, "/tmp", "card.img", "?", time.Millisecond); !errors.Is(err, ErrCanceled) {
		t.Fatalf("want ErrCanceled after the wait: %v", err)
	}
	if last := p.calls[len(p.calls)-1]; last != "Close "+p.handle {
		t.Fatalf("the request should be closed: %v", p.calls)
	}
}

func TestFilePaths(t *testing.T) {
	for uri, want := range map[string]string{
		"file:///home/pat/a.img":             "/home/pat/a.img",
		"file://localhost/home/pat/a.img":    "/home/pat/a.img",
		"file:///home/pat/%C3%A9t%C3%A9.img": "/home/pat/été.img",
	} {
		if got, err := filePath(uri); err != nil || got != want {
			t.Errorf("%s: %q %v", uri, got, err)
		}
	}
	for _, uri := range []string{"https://example.com/a.img", "file:relative.img"} {
		if _, err := filePath(uri); err == nil {
			t.Errorf("%s was accepted", uri)
		}
	}
}

func TestAPortalReadyToStartCounts(t *testing.T) {
	if !portalKnown(&portal{}) {
		t.Fatal("an activatable portal should count")
	}
}
