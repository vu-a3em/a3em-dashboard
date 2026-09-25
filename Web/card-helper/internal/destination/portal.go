package destination

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/dbus"
)

/*
	The desktop's own save dialog on Linux, through the XDG desktop portal.

	Linux has no one save dialog a program can call, the way AppleScript and Windows Forms give
	one on the other two. What modern desktops share is the portal: a service on the session bus
	that shows GNOME's dialog on GNOME, KDE's on KDE, and the like elsewhere, with nothing extra
	to install. So it comes first, and zenity or kdialog only where there is no portal.

	A portal answers a call at once with a request's path, and the choice later, as a signal on
	that path. The path is made from this connection's name and a token of its own, so the
	signal is subscribed to before the call is made and cannot arrive unheard.
*/

const (
	portalName       = "org.freedesktop.portal.Desktop"
	portalPath       = "/org/freedesktop/portal/desktop"
	chooserInterface = "org.freedesktop.portal.FileChooser"
	requestInterface = "org.freedesktop.portal.Request"
	busName          = "org.freedesktop.DBus"
	busPath          = "/org/freedesktop/DBus"
)

// errNoPortal is a session without a portal file chooser, where another dialog is tried.
var errNoPortal = errors.New("no desktop portal file chooser")

// How long the person has to choose; the page waits half an hour.
const choosingTime = 29 * time.Minute

// bus is what the portal is asked through: a *dbus.Conn, or a test's stand-in.
type bus interface {
	Name() string
	AddMatch(rule string) error
	Call(destination, path, iface, member string, timeout time.Duration, sig string, args ...any) ([]any, error)
	WaitSignal(match func(*dbus.Message) bool, timeout time.Duration) (*dbus.Message, error)
}

// choosePortal shows the portal's save dialog, starting in dir with name filled in.
func choosePortal(dir, name, prompt string) (string, error) {
	conn, err := dbus.Session()
	if err != nil {
		return "", errNoPortal
	}
	defer conn.Close()
	return saveFile(conn, dir, name, prompt, choosingTime)
}

func saveFile(b bus, dir, name, prompt string, wait time.Duration) (string, error) {
	token := requestToken()
	handle := requestPath(b.Name(), token)
	if err := b.AddMatch(responseRule(handle)); err != nil {
		return "", errNoPortal
	}
	options := map[string]dbus.Variant{
		"handle_token":   {Sig: "s", Value: token},
		"modal":          {Sig: "b", Value: true},
		"current_name":   {Sig: "s", Value: name},
		"current_folder": {Sig: "ay", Value: append([]byte(dir), 0)},
	}
	reply, err := b.Call(portalName, portalPath, chooserInterface, "SaveFile", time.Minute, "ssa{sv}", "", prompt, options)
	if err != nil {
		// No portal, or one without a file chooser, as some desktops' are.
		return "", errNoPortal
	}
	if got, _ := reply[0].(string); got != "" && got != handle {
		// Portals before 0.9 choose the request's path themselves.
		handle = got
		if err := b.AddMatch(responseRule(handle)); err != nil {
			return "", err
		}
	}
	response, err := b.WaitSignal(func(m *dbus.Message) bool {
		return m.Path == handle && m.Interface == requestInterface && m.Member == "Response"
	}, wait)
	if err != nil {
		// Taken down, rather than left on the screen for a copy nobody is waiting for.
		b.Call(portalName, handle, requestInterface, "Close", 5*time.Second, "")
		if errors.Is(err, dbus.ErrTimeout) {
			return "", ErrCanceled
		}
		return "", err
	}
	if len(response.Body) != 2 {
		return "", errors.New("the save dialog answered in a way the A3EM Card Helper cannot read")
	}
	// 1 is Cancel; 2, "ended some other way", is how GNOME's dialog reports Escape or its close
	// button. Either way nothing was chosen.
	if code, _ := response.Body[0].(uint32); code != 0 {
		return "", ErrCanceled
	}
	results, _ := response.Body[1].(map[string]any)
	uris, _ := results["uris"].(dbus.Variant)
	list, _ := uris.Value.([]string)
	if len(list) == 0 {
		return "", errors.New("the save dialog chose nothing")
	}
	return filePath(list[0])
}

// HasPortal is whether this session has a desktop portal, running or ready to start, for the
// save dialog. It asks the bus without starting the portal.
func HasPortal() bool {
	conn, err := dbus.Session()
	if err != nil {
		return false
	}
	defer conn.Close()
	return portalKnown(conn)
}

func portalKnown(b bus) bool {
	if reply, err := b.Call(busName, busPath, busName, "NameHasOwner", 3*time.Second, "s", portalName); err == nil {
		if owned, _ := reply[0].(bool); owned {
			return true
		}
	}
	reply, err := b.Call(busName, busPath, busName, "ListActivatableNames", 3*time.Second, "")
	if err != nil {
		return false
	}
	names, _ := reply[0].([]string)
	for _, name := range names {
		if name == portalName {
			return true
		}
	}
	return false
}

func requestToken() string {
	b := make([]byte, 8)
	rand.Read(b)
	return "a3em" + hex.EncodeToString(b)
}

// requestPath is where the portal puts a request made with this token: the connection's name,
// ":1.42", becomes "1_42".
func requestPath(connection, token string) string {
	sender := strings.ReplaceAll(strings.TrimPrefix(connection, ":"), ".", "_")
	return portalPath + "/request/" + sender + "/" + token
}

func responseRule(path string) string {
	return "type='signal',interface='" + requestInterface + "',member='Response',path='" + path + "'"
}

// filePath is the path a file:// URI names.
func filePath(uri string) (string, error) {
	rest, ok := strings.CutPrefix(uri, "file://")
	if !ok {
		return "", errors.New("the save dialog chose somewhere that is not a file: " + uri)
	}
	// An authority, if any: "localhost", or empty.
	if slash := strings.IndexByte(rest, '/'); slash > 0 {
		rest = rest[slash:]
	}
	var out strings.Builder
	for i := 0; i < len(rest); i++ {
		if rest[i] == '%' && i+2 < len(rest) {
			if b, err := strconv.ParseUint(rest[i+1:i+3], 16, 8); err == nil {
				out.WriteByte(byte(b))
				i += 2
				continue
			}
		}
		out.WriteByte(rest[i])
	}
	if !strings.HasPrefix(out.String(), "/") {
		return "", errors.New("the save dialog chose somewhere that is not a file: " + uri)
	}
	return out.String(), nil
}
