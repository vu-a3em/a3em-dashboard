//go:build unix

package dbus

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestAMessageReadsBackAsWritten(t *testing.T) {
	options := map[string]Variant{
		"handle_token":   {"s", "a3em1"},
		"modal":          {"b", true},
		"current_folder": {"ay", []byte("/home/pat\x00")},
		"filters":        {"a(sa(us))", []any{[]any{"Images", []any{[]any{uint32(0), "*.img"}}}}},
		"count":          {"t", uint64(1) << 40},
	}
	sent := &Message{Type: typeCall, Serial: 7, Destination: "org.freedesktop.portal.Desktop", Path: "/org/freedesktop/portal/desktop",
		Interface: "org.freedesktop.portal.FileChooser", Member: "SaveFile", Signature: "ssa{sv}as", Body: []any{"", "Save the image", options, []string{"a", "bc"}}}
	raw, err := sent.encode()
	if err != nil {
		t.Fatal(err)
	}
	// The body starts on an eight-byte boundary after the header.
	header := 16 + int(binary.LittleEndian.Uint32(raw[12:]))
	if (header+7)&^7+int(binary.LittleEndian.Uint32(raw[4:])) != len(raw) {
		t.Fatal("the header must be padded to eight bytes")
	}
	got, err := readMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if got.Member != "SaveFile" || got.Serial != 7 || got.Path != sent.Path || got.Signature != "ssa{sv}as" {
		t.Fatalf("header %+v", got)
	}
	dict := got.Body[2].(map[string]any)
	for key, want := range options {
		if !reflect.DeepEqual(dict[key], want) {
			t.Errorf("%s: got %#v, want %#v", key, dict[key], want)
		}
	}
	if !reflect.DeepEqual(got.Body[3], []string{"a", "bc"}) || got.Body[1] != "Save the image" {
		t.Errorf("body %#v", got.Body)
	}
}

func TestABigEndianMessageIsRead(t *testing.T) {
	// A method return, serial 2, replying to 1, with body "s" = "hi", written big-endian by hand.
	var m []byte
	m = append(m, 'B', typeReturn, 0, 1)
	m = binary.BigEndian.AppendUint32(m, 7) // body: length 2, "hi", NUL
	m = binary.BigEndian.AppendUint32(m, 2)
	fields := []byte{
		fieldReplySerial, 1, 'u', 0, 0, 0, 0, 1,
		fieldSignature, 1, 'g', 0, 1, 's', 0,
	}
	m = binary.BigEndian.AppendUint32(m, uint32(len(fields)))
	m = append(m, fields...)
	for len(m)%8 != 0 {
		m = append(m, 0)
	}
	m = binary.BigEndian.AppendUint32(m, 2)
	m = append(m, 'h', 'i', 0)
	got, err := readMessage(bytes.NewReader(m))
	if err != nil {
		t.Fatal(err)
	}
	if got.ReplySerial != 1 || len(got.Body) != 1 || got.Body[0] != "hi" {
		t.Fatalf("%+v", got)
	}
}

func TestMalformedMessagesAreRefused(t *testing.T) {
	good, _ := (&Message{Type: typeSignal, Serial: 1, Path: "/a", Interface: "a.b", Member: "C", Signature: "as", Body: []any{[]string{"x"}}}).encode()
	for cut := 1; cut < len(good); cut++ {
		if _, err := readMessage(bytes.NewReader(good[:cut])); err == nil {
			t.Fatalf("a message cut to %d bytes was read", cut)
		}
	}
	bad := bytes.Clone(good)
	bad[0] = 'x'
	if _, err := readMessage(bytes.NewReader(bad)); err == nil {
		t.Fatal("an unknown byte order was read")
	}
}

func TestBusAddresses(t *testing.T) {
	got := socketPaths("unix:path=/run/user/1000/bus;tcp:host=x,port=1;unix:abstract=/tmp/dbus-AB%2cC,guid=12")
	if !reflect.DeepEqual(got, []string{"/run/user/1000/bus", "@/tmp/dbus-AB,C"}) {
		t.Fatalf("%q", got)
	}
}

// fakeBus is the other end of a connection: it answers the handshake, then hands every message
// to serve, which replies through the writer.
func fakeBus(t *testing.T, serve func(m *Message, reply func(*Message))) *Conn {
	t.Helper()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, fd := range fds {
		syscall.SetNonblock(fd, true)
	}
	ours, theirs := os.NewFile(uintptr(fds[0]), "client"), os.NewFile(uintptr(fds[1]), "bus")
	t.Cleanup(func() { ours.Close(); theirs.Close() })
	go func() {
		r := bufio.NewReader(theirs)
		auth, _ := r.ReadString('\n')
		if !strings.HasPrefix(auth, "\x00AUTH EXTERNAL ") {
			theirs.WriteString("REJECTED EXTERNAL\r\n")
			return
		}
		theirs.WriteString("OK 0123456789abcdef\r\n")
		if begin, _ := r.ReadString('\n'); begin != "BEGIN\r\n" {
			return
		}
		serial := uint32(100)
		reply := func(m *Message) {
			serial++
			m.Serial = serial
			raw, err := m.encode()
			if err != nil {
				t.Error(err)
				return
			}
			theirs.Write(raw)
		}
		for {
			m, err := readMessage(r)
			if err != nil {
				return
			}
			if m.Member == "Hello" {
				reply(&Message{Type: typeReturn, ReplySerial: m.Serial, Signature: "s", Body: []any{":1.42"}})
				continue
			}
			serve(m, reply)
		}
	}()
	conn, err := open(ours, ours.SetReadDeadline, 1000)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func TestACallGetsItsReplyAndSignalsWaitTheirTurn(t *testing.T) {
	conn := fakeBus(t, func(m *Message, reply func(*Message)) {
		switch m.Member {
		case "Ping":
			// A signal first, then a reply to something else, then the reply.
			reply(&Message{Type: typeSignal, Path: "/x", Interface: "a.b", Member: "Changed", Signature: "u", Body: []any{uint32(5)}})
			reply(&Message{Type: typeReturn, ReplySerial: 999})
			reply(&Message{Type: typeReturn, ReplySerial: m.Serial, Signature: "s", Body: []any{"pong " + m.Body[0].(string)}})
		case "Fail":
			reply(&Message{Type: typeError, ReplySerial: m.Serial, ErrorName: "org.freedesktop.DBus.Error.ServiceUnknown", Signature: "s", Body: []any{"nobody"}})
		}
	})
	if conn.Name() != ":1.42" {
		t.Fatalf("name %q", conn.Name())
	}
	got, err := conn.Call("a.b", "/", "a.b", "Ping", time.Second, "s", "hello")
	if err != nil || got[0] != "pong hello" {
		t.Fatalf("%v %v", got, err)
	}
	signal, err := conn.WaitSignal(func(m *Message) bool { return m.Member == "Changed" }, time.Second)
	if err != nil || signal.Body[0] != uint32(5) {
		t.Fatalf("the signal that came during the call: %v %v", signal, err)
	}
	var failure *Error
	if _, err := conn.Call("a.b", "/", "a.b", "Fail", time.Second, ""); !errors.As(err, &failure) || failure.Name != "org.freedesktop.DBus.Error.ServiceUnknown" {
		t.Fatalf("want the error reply: %v", err)
	}
	if _, err := conn.WaitSignal(func(*Message) bool { return true }, 50*time.Millisecond); !errors.Is(err, ErrTimeout) {
		t.Fatalf("want a timeout: %v", err)
	}
}
