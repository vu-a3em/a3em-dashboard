// Package protocol is Chrome's native messaging framing and the messages this helper speaks.
//
// Each message is a 32-bit length in native byte order followed by that many bytes of UTF-8
// JSON. Chrome caps host-to-extension messages at 1 MB, which is why replies carry verdicts
// and progress rather than payloads: audio and file data travel through the File System
// Access API in the page, never through here.
//
// stdout is the wire. Anything else written to it desynchronizes the framing, so every
// diagnostic goes to stderr, which Chrome captures into the extension's console.
package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unsafe"
)

// MaxMessageBytes is Chrome's limit on a single host-to-extension message.
const MaxMessageBytes = 1024 * 1024

// maxIncomingBytes guards against a desynchronized stream: nothing legitimate is this large,
// and a length this wrong means continuing would allocate against garbage.
const maxIncomingBytes = 64 * MaxMessageBytes

// HeartbeatIntervalMs is how often a long operation reports that it is still alive.
const HeartbeatIntervalMs = 2000

var nativeOrder binary.ByteOrder = func() binary.ByteOrder {
	probe := uint16(1)
	if *(*byte)(unsafe.Pointer(&probe)) == 1 {
		return binary.LittleEndian
	}
	return binary.BigEndian
}()

// ErrTooLarge is returned when a reply would exceed Chrome's message limit.
var ErrTooLarge = errors.New("response exceeds the 1 MB native messaging limit; summarize or page it")

// Encode frames one message.
func Encode(value any) ([]byte, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(body) > MaxMessageBytes {
		return nil, ErrTooLarge
	}
	frame := make([]byte, 4+len(body))
	nativeOrder.PutUint32(frame, uint32(len(body)))
	copy(frame[4:], body)
	return frame, nil
}

// Read reads one framed message, returning io.EOF when the extension closes the port.
func Read(r io.Reader) (json.RawMessage, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return nil, err
	}
	length := nativeOrder.Uint32(header[:])
	if length > maxIncomingBytes {
		return nil, fmt.Errorf("refusing a %d-byte message: the stream is not framed correctly", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	return json.RawMessage(body), nil
}

// Request is every field any operation accepts. Operations read only their own.
type Request struct {
	ID          string `json:"id"`
	Op          string `json:"op"`
	Probe       string `json:"probe,omitempty"`
	Volume      string `json:"volume,omitempty"`
	Device      string `json:"device,omitempty"`
	Operation   string `json:"operation,omitempty"`
	Grant       string `json:"grant,omitempty"`
	Destination string `json:"destination,omitempty"`
	// Replace lets an image overwrite a file already at Destination, which the person agreed
	// to in the save dialog. The old file is replaced only once the copy is finished.
	Replace bool `json:"replace,omitempty"`
	// Target is the request a stop request asks to stop.
	Target                string          `json:"target,omitempty"`
	AllocationUnitBytes   int64           `json:"allocationUnitBytes,omitempty"`
	Label                 string          `json:"label,omitempty"`
	Text                  string          `json:"text,omitempty"`
	Targets               []PrepareTarget `json:"targets,omitempty"`
	SkipCapacityProbe     bool            `json:"skipCapacityProbe,omitempty"`
	SkipLatencyTest       bool            `json:"skipLatencyTest,omitempty"`
	RecommendedAllocation int64           `json:"recommendedAllocationUnitBytes,omitempty"`
	// Deep asks a readiness check to compare the card's raw layout with the reference, which
	// may need an administrator prompt.
	Deep bool `json:"deep,omitempty"`
	// Devices asks a readiness check about several cards at once, so that reading all their
	// layouts costs one administrator prompt.
	Devices []string `json:"devices,omitempty"`
}

// PrepareTarget is one card in a prepare request: the device, its grant, and what to put on it.
type PrepareTarget struct {
	Device              string `json:"device"`
	Grant               string `json:"grant"`
	AllocationUnitBytes int64  `json:"allocationUnitBytes"`
	Label               string `json:"label"`
	// Config is the configuration file to write once the card is formatted, or empty for none.
	Config string `json:"config,omitempty"`
}

// Failure is the reply to anything that did not succeed.
type Failure struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Error  string `json:"error"`
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
}

// Progress is a heartbeat or progress report for a long operation.
type Progress struct {
	ID       string       `json:"id"`
	Progress TaskProgress `json:"progress"`
}

// TaskProgress is what a long operation says about itself while it runs.
type TaskProgress struct {
	Op          string `json:"op"`
	Note        string `json:"note"`
	Stage       string `json:"stage,omitempty"`
	Device      string `json:"device,omitempty"`
	BytesCopied int64  `json:"bytesCopied,omitempty"`
	TotalBytes  int64  `json:"totalBytes,omitempty"`
	BadSectors  int64  `json:"badSectors,omitempty"`
	ElapsedMs   int64  `json:"elapsedMs"`
}
