package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	frame, err := Encode(map[string]any{"id": "1", "op": "hello"})
	if err != nil {
		t.Fatal(err)
	}
	reader := bytes.NewReader(append(frame, frame...))
	for i := 0; i < 2; i++ {
		body, err := Read(reader)
		if err != nil {
			t.Fatal(err)
		}
		var request Request
		if err := json.Unmarshal(body, &request); err != nil || request.Op != "hello" {
			t.Fatalf("read %q", body)
		}
	}
	if _, err := Read(reader); !errors.Is(err, io.EOF) {
		t.Fatalf("expected EOF, got %v", err)
	}
}

func TestRefusesOversizedReply(t *testing.T) {
	if _, err := Encode(map[string]string{"blob": strings.Repeat("x", MaxMessageBytes)}); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected ErrTooLarge, got %v", err)
	}
}

func TestRefusesAnAbsurdLength(t *testing.T) {
	header := make([]byte, 4)
	nativeOrder.PutUint32(header, 0xffffffff)
	if _, err := Read(bytes.NewReader(header)); err == nil {
		t.Fatal("expected an error for a desynchronized stream")
	}
}
