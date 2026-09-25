package dbus

import (
	"bufio"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// Message types.
const (
	typeCall   = 1
	typeReturn = 2
	typeError  = 3
	typeSignal = 4
)

// Header field codes.
const (
	fieldPath        = 1
	fieldInterface   = 2
	fieldMember      = 3
	fieldErrorName   = 4
	fieldReplySerial = 5
	fieldDestination = 6
	fieldSender      = 7
	fieldSignature   = 8
)

// A message's header and body together may not exceed this, by the specification.
const maxMessage = 128 << 20

// Message is one D-Bus message, as read or to be sent.
type Message struct {
	Type        byte
	Serial      uint32
	ReplySerial uint32
	Path        string
	Interface   string
	Member      string
	ErrorName   string
	Destination string
	Sender      string
	Signature   string
	Body        []any
}

// Error is an error reply.
type Error struct {
	Name    string
	Message string
}

func (e *Error) Error() string {
	if e.Message == "" {
		return e.Name
	}
	return e.Name + ": " + e.Message
}

// ErrTimeout is returned when nothing arrives in the time allowed.
var ErrTimeout = errors.New("dbus: no reply in time")

func (m *Message) encode() ([]byte, error) {
	var body encoder
	types, err := split(m.Signature)
	if err != nil {
		return nil, err
	}
	if len(types) != len(m.Body) {
		return nil, fmt.Errorf("dbus: %d values for signature %q", len(m.Body), m.Signature)
	}
	for i, t := range types {
		if err := body.value(t, m.Body[i]); err != nil {
			return nil, err
		}
	}
	var fields []any
	add := func(code byte, sig string, value any) { fields = append(fields, []any{code, Variant{sig, value}}) }
	if m.Path != "" {
		add(fieldPath, "o", ObjectPath(m.Path))
	}
	if m.Interface != "" {
		add(fieldInterface, "s", m.Interface)
	}
	if m.Member != "" {
		add(fieldMember, "s", m.Member)
	}
	if m.ErrorName != "" {
		add(fieldErrorName, "s", m.ErrorName)
	}
	if m.ReplySerial != 0 {
		add(fieldReplySerial, "u", m.ReplySerial)
	}
	if m.Destination != "" {
		add(fieldDestination, "s", m.Destination)
	}
	if m.Sender != "" {
		add(fieldSender, "s", m.Sender)
	}
	if m.Signature != "" {
		add(fieldSignature, "g", m.Signature)
	}
	head := encoder{b: []byte{'l', m.Type, 0, 1}}
	head.u32(uint32(len(body.b)))
	head.u32(m.Serial)
	if err := head.value("a(yv)", fields); err != nil {
		return nil, err
	}
	head.align(8)
	return append(head.b, body.b...), nil
}

// readMessage reads one message from the stream.
func readMessage(r io.Reader) (*Message, error) {
	fixed := make([]byte, 16)
	if _, err := io.ReadFull(r, fixed); err != nil {
		return nil, err
	}
	var order binary.ByteOrder
	switch fixed[0] {
	case 'l':
		order = binary.LittleEndian
	case 'B':
		order = binary.BigEndian
	default:
		return nil, errMalformed
	}
	bodyLength, fieldsLength := int64(order.Uint32(fixed[4:])), int64(order.Uint32(fixed[12:]))
	headerLength := 16 + fieldsLength
	padded := (headerLength + 7) &^ 7
	if padded+bodyLength > maxMessage {
		return nil, errMalformed
	}
	whole := make([]byte, padded+bodyLength)
	copy(whole, fixed)
	if _, err := io.ReadFull(r, whole[16:]); err != nil {
		return nil, err
	}
	m := &Message{Type: fixed[1], Serial: order.Uint32(fixed[8:])}
	head := decoder{b: whole[:headerLength], pos: 12, order: order}
	raw, err := head.value("a(yv)", 0)
	if err != nil {
		return nil, err
	}
	fields, _ := raw.([]any)
	for _, field := range fields {
		pair, _ := field.([]any)
		if len(pair) != 2 {
			return nil, errMalformed
		}
		code, _ := pair[0].(byte)
		variant, _ := pair[1].(Variant)
		text, _ := variant.Value.(string)
		switch code {
		case fieldPath:
			m.Path = text
		case fieldInterface:
			m.Interface = text
		case fieldMember:
			m.Member = text
		case fieldErrorName:
			m.ErrorName = text
		case fieldReplySerial:
			m.ReplySerial, _ = variant.Value.(uint32)
		case fieldDestination:
			m.Destination = text
		case fieldSender:
			m.Sender = text
		case fieldSignature:
			m.Signature = text
		}
	}
	types, err := split(m.Signature)
	if err != nil {
		return nil, err
	}
	body := decoder{b: whole[padded:], order: order}
	for _, t := range types {
		value, err := body.value(t, 0)
		if err != nil {
			return nil, err
		}
		m.Body = append(m.Body, value)
	}
	return m, nil
}

// Conn is a connection to a message bus.
type Conn struct {
	rw       io.ReadWriteCloser
	reader   *bufio.Reader
	deadline func(time.Time) error
	serial   uint32
	name     string
	// Signals that arrived while waiting for a reply, kept for WaitSignal.
	queue []*Message
}

// Session connects to this login session's bus.
func Session() (*Conn, error) {
	address := os.Getenv("DBUS_SESSION_BUS_ADDRESS")
	if address == "" {
		runtime := os.Getenv("XDG_RUNTIME_DIR")
		if runtime == "" {
			return nil, errors.New("dbus: no session bus address")
		}
		address = "unix:path=" + runtime + "/bus"
	}
	return dial(address)
}

// System connects to the system bus, where udisks2 answers.
func System() (*Conn, error) {
	address := os.Getenv("DBUS_SYSTEM_BUS_ADDRESS")
	if address == "" {
		address = "unix:path=/var/run/dbus/system_bus_socket"
	}
	return dial(address)
}

// dial connects to the first address in a bus address that answers.
func dial(address string) (*Conn, error) {
	var last error = errors.New("dbus: no usable address in " + address)
	for _, path := range socketPaths(address) {
		file, err := dialUnix(path)
		if err != nil {
			last = err
			continue
		}
		conn, err := open(file, file.SetReadDeadline, os.Getuid())
		if err != nil {
			file.Close()
			last = err
			continue
		}
		return conn, nil
	}
	return nil, last
}

// socketPaths are the Unix socket addresses in a bus address, in order: unix:path=… as is,
// unix:abstract=… with the "@" that names an abstract socket. Other transports are skipped.
func socketPaths(address string) []string {
	var paths []string
	for _, entry := range strings.Split(address, ";") {
		transport, options, ok := strings.Cut(entry, ":")
		if !ok || transport != "unix" {
			continue
		}
		for _, option := range strings.Split(options, ",") {
			key, value, _ := strings.Cut(option, "=")
			value = unescape(value)
			switch key {
			case "path":
				paths = append(paths, value)
			case "abstract":
				paths = append(paths, "@"+value)
			}
		}
	}
	return paths
}

// unescape undoes a bus address's %XX escapes.
func unescape(value string) string {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '%' && i+2 < len(value) {
			if b, err := strconv.ParseUint(value[i+1:i+3], 16, 8); err == nil {
				out.WriteByte(byte(b))
				i += 2
				continue
			}
		}
		out.WriteByte(value[i])
	}
	return out.String()
}

// open authenticates as uid on a fresh connection and says hello to the bus.
func open(rw io.ReadWriteCloser, deadline func(time.Time) error, uid int) (*Conn, error) {
	c := &Conn{rw: rw, reader: bufio.NewReader(rw), deadline: deadline}
	c.setDeadline(10 * time.Second)
	id := hex.EncodeToString([]byte(strconv.Itoa(uid)))
	if _, err := io.WriteString(rw, "\x00AUTH EXTERNAL "+id+"\r\n"); err != nil {
		return nil, err
	}
	line, err := c.reader.ReadString('\n')
	if err != nil {
		return nil, fmt.Errorf("dbus: authentication: %w", err)
	}
	if !strings.HasPrefix(line, "OK ") {
		return nil, fmt.Errorf("dbus: authentication refused: %s", strings.TrimSpace(line))
	}
	if _, err := io.WriteString(rw, "BEGIN\r\n"); err != nil {
		return nil, err
	}
	reply, err := c.Call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", 10*time.Second, "")
	if err != nil {
		return nil, err
	}
	c.name, _ = reply[0].(string)
	return c, nil
}

func (c *Conn) setDeadline(timeout time.Duration) {
	if c.deadline != nil {
		c.deadline(time.Now().Add(timeout))
	}
}

// Name is the bus's name for this connection, such as ":1.42".
func (c *Conn) Name() string { return c.name }

// Close ends the connection.
func (c *Conn) Close() error { return c.rw.Close() }

func (c *Conn) read(timeout time.Duration) (*Message, error) {
	c.setDeadline(timeout)
	m, err := readMessage(c.reader)
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return nil, ErrTimeout
	}
	return m, err
}

// Call calls a method and waits up to timeout for its reply.
func (c *Conn) Call(destination, path, iface, member string, timeout time.Duration, sig string, args ...any) ([]any, error) {
	c.serial++
	m := &Message{Type: typeCall, Serial: c.serial, Destination: destination, Path: path, Interface: iface, Member: member, Signature: sig, Body: args}
	raw, err := m.encode()
	if err != nil {
		return nil, err
	}
	if _, err := c.rw.Write(raw); err != nil {
		return nil, err
	}
	until := time.Now().Add(timeout)
	for {
		reply, err := c.read(time.Until(until))
		if err != nil {
			return nil, err
		}
		switch {
		case reply.Type == typeSignal:
			c.queue = append(c.queue, reply)
		case reply.ReplySerial != m.Serial:
			// Something else's reply, or a call to this connection, which it does not serve.
		case reply.Type == typeError:
			text := ""
			if len(reply.Body) > 0 {
				text, _ = reply.Body[0].(string)
			}
			return nil, &Error{Name: reply.ErrorName, Message: text}
		default:
			return reply.Body, nil
		}
	}
}

// AddMatch asks the bus to send this connection the signals a match rule describes.
func (c *Conn) AddMatch(rule string) error {
	_, err := c.Call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch", 10*time.Second, "s", rule)
	return err
}

// WaitSignal waits up to timeout for a signal that match accepts.
func (c *Conn) WaitSignal(match func(*Message) bool, timeout time.Duration) (*Message, error) {
	for i, m := range c.queue {
		if match(m) {
			c.queue = append(c.queue[:i], c.queue[i+1:]...)
			return m, nil
		}
	}
	until := time.Now().Add(timeout)
	for {
		m, err := c.read(time.Until(until))
		if err != nil {
			return nil, err
		}
		if m.Type == typeSignal && match(m) {
			return m, nil
		}
	}
}
