// Package dbus is just enough of a D-Bus client to ask a Linux desktop's portal for its file
// chooser: connect to the session bus, call a method, and wait for a signal.
//
// It is written here rather than taken from a library because the helper has no dependencies
// outside Go's own, and what it needs is small. The wire format is the D-Bus specification's:
// each value aligned to its own size from the start of the message, strings with a length before
// and a NUL after, arrays with their byte length first, variants carrying their own signature.
package dbus

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"sort"
)

// ObjectPath is a value of D-Bus type o.
type ObjectPath string

// Variant is a value of D-Bus type v: a value with its own signature.
type Variant struct {
	Sig   string
	Value any
}

var errMalformed = errors.New("dbus: malformed message")

// first splits a signature into its first complete type and the rest.
func first(sig string) (string, string, error) {
	if sig == "" {
		return "", "", errMalformed
	}
	switch sig[0] {
	case 'a':
		elem, rest, err := first(sig[1:])
		return "a" + elem, rest, err
	case '(', '{':
		closing := byte(')')
		if sig[0] == '{' {
			closing = '}'
		}
		depth := 0
		for i := 0; i < len(sig); i++ {
			switch sig[i] {
			case '(', '{':
				depth++
			case ')', '}':
				depth--
				if depth == 0 {
					if sig[i] != closing {
						return "", "", errMalformed
					}
					return sig[:i+1], sig[i+1:], nil
				}
			}
		}
		return "", "", errMalformed
	}
	return sig[:1], sig[1:], nil
}

// split is a signature's complete types, in order.
func split(sig string) ([]string, error) {
	var types []string
	for sig != "" {
		t, rest, err := first(sig)
		if err != nil {
			return nil, err
		}
		types, sig = append(types, t), rest
	}
	return types, nil
}

func alignment(t string) int {
	switch t[0] {
	case 'y', 'g', 'v':
		return 1
	case 'n', 'q':
		return 2
	case 'x', 't', 'd', '(', '{':
		return 8
	}
	return 4
}

// --- Writing -----------------------------------------------------------------------------------

type encoder struct{ b []byte }

func (e *encoder) align(n int) {
	for len(e.b)%n != 0 {
		e.b = append(e.b, 0)
	}
}

func (e *encoder) u32(v uint32) {
	e.align(4)
	e.b = binary.LittleEndian.AppendUint32(e.b, v)
}

func (e *encoder) str(s string) {
	e.u32(uint32(len(s)))
	e.b = append(append(e.b, s...), 0)
}

func (e *encoder) signature(s string) {
	e.b = append(append(append(e.b, byte(len(s))), s...), 0)
}

// value writes v as type t. It takes the Go types this package reads back: byte, bool, int32,
// uint32, int64, uint64, float64, string, ObjectPath, Variant, []byte for ay, []string for as,
// map[string]Variant for a{sv}, []any for other arrays and for structs.
func (e *encoder) value(t string, v any) error {
	wrong := fmt.Errorf("dbus: %T cannot be written as %s", v, t)
	e.align(alignment(t))
	switch t[0] {
	case 'y':
		b, ok := v.(byte)
		if !ok {
			return wrong
		}
		e.b = append(e.b, b)
	case 'b':
		b, ok := v.(bool)
		if !ok {
			return wrong
		}
		if b {
			e.u32(1)
		} else {
			e.u32(0)
		}
	case 'i':
		n, ok := v.(int32)
		if !ok {
			return wrong
		}
		e.u32(uint32(n))
	case 'u':
		n, ok := v.(uint32)
		if !ok {
			return wrong
		}
		e.u32(n)
	case 'x', 't':
		var n uint64
		switch x := v.(type) {
		case int64:
			n = uint64(x)
		case uint64:
			n = x
		default:
			return wrong
		}
		e.b = binary.LittleEndian.AppendUint64(e.b, n)
	case 'd':
		f, ok := v.(float64)
		if !ok {
			return wrong
		}
		e.b = binary.LittleEndian.AppendUint64(e.b, math.Float64bits(f))
	case 's', 'o':
		switch s := v.(type) {
		case string:
			e.str(s)
		case ObjectPath:
			e.str(string(s))
		default:
			return wrong
		}
	case 'g':
		s, ok := v.(string)
		if !ok {
			return wrong
		}
		e.signature(s)
	case 'v':
		variant, ok := v.(Variant)
		if !ok {
			return wrong
		}
		e.signature(variant.Sig)
		return e.value(variant.Sig, variant.Value)
	case 'a':
		return e.array(t[1:], v, wrong)
	case '(':
		fields, ok := v.([]any)
		types, err := split(t[1 : len(t)-1])
		if !ok || err != nil || len(fields) != len(types) {
			return wrong
		}
		for i, field := range fields {
			if err := e.value(types[i], field); err != nil {
				return err
			}
		}
	default:
		return wrong
	}
	return nil
}

func (e *encoder) array(elem string, v any, wrong error) error {
	e.u32(0)
	at := len(e.b) - 4
	e.align(alignment(elem))
	start := len(e.b)
	switch {
	case elem == "y":
		b, ok := v.([]byte)
		if !ok {
			return wrong
		}
		e.b = append(e.b, b...)
	case elem == "s":
		list, ok := v.([]string)
		if !ok {
			return wrong
		}
		for _, s := range list {
			e.str(s)
		}
	case elem == "{sv}":
		dict, ok := v.(map[string]Variant)
		if !ok {
			return wrong
		}
		keys := make([]string, 0, len(dict))
		for key := range dict {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			e.align(8)
			e.str(key)
			if err := e.value("v", dict[key]); err != nil {
				return err
			}
		}
	default:
		list, ok := v.([]any)
		if !ok {
			return wrong
		}
		for _, item := range list {
			if err := e.value(elem, item); err != nil {
				return err
			}
		}
	}
	binary.LittleEndian.PutUint32(e.b[at:], uint32(len(e.b)-start))
	return nil
}

// --- Reading -----------------------------------------------------------------------------------

type decoder struct {
	b     []byte
	pos   int
	order binary.ByteOrder
}

func (d *decoder) align(n int) error {
	for d.pos%n != 0 {
		d.pos++
	}
	if d.pos > len(d.b) {
		return errMalformed
	}
	return nil
}

func (d *decoder) take(n int) ([]byte, error) {
	if n < 0 || d.pos+n > len(d.b) {
		return nil, errMalformed
	}
	out := d.b[d.pos : d.pos+n]
	d.pos += n
	return out, nil
}

func (d *decoder) u32() (uint32, error) {
	if err := d.align(4); err != nil {
		return 0, err
	}
	b, err := d.take(4)
	if err != nil {
		return 0, err
	}
	return d.order.Uint32(b), nil
}

func (d *decoder) str() (string, error) {
	n, err := d.u32()
	if err != nil {
		return "", err
	}
	b, err := d.take(int(n) + 1)
	if err != nil {
		return "", err
	}
	return string(b[:n]), nil
}

func (d *decoder) signature() (string, error) {
	n, err := d.take(1)
	if err != nil {
		return "", err
	}
	b, err := d.take(int(n[0]) + 1)
	if err != nil {
		return "", err
	}
	return string(b[:n[0]]), nil
}

// value reads a value of type t, as the Go types value writes, except that dictionaries other
// than a{sv} are map[any]any and ObjectPath comes back as a plain string.
func (d *decoder) value(t string, depth int) (any, error) {
	if depth > 32 {
		return nil, errMalformed
	}
	if err := d.align(alignment(t)); err != nil {
		return nil, err
	}
	switch t[0] {
	case 'y':
		b, err := d.take(1)
		if err != nil {
			return nil, err
		}
		return b[0], nil
	case 'b':
		n, err := d.u32()
		return n != 0, err
	case 'n', 'q':
		b, err := d.take(2)
		if err != nil {
			return nil, err
		}
		if t[0] == 'n' {
			return int16(d.order.Uint16(b)), nil
		}
		return d.order.Uint16(b), nil
	case 'i':
		n, err := d.u32()
		return int32(n), err
	case 'u', 'h':
		return d.u32()
	case 'x', 't', 'd':
		b, err := d.take(8)
		if err != nil {
			return nil, err
		}
		n := d.order.Uint64(b)
		switch t[0] {
		case 'x':
			return int64(n), nil
		case 'd':
			return math.Float64frombits(n), nil
		}
		return n, nil
	case 's', 'o':
		return d.str()
	case 'g':
		return d.signature()
	case 'v':
		sig, err := d.signature()
		if err != nil {
			return nil, err
		}
		if _, rest, err := first(sig); err != nil || rest != "" {
			return nil, errMalformed
		}
		value, err := d.value(sig, depth+1)
		return Variant{Sig: sig, Value: value}, err
	case 'a':
		return d.array(t[1:], depth)
	case '(':
		types, err := split(t[1 : len(t)-1])
		if err != nil {
			return nil, err
		}
		fields := make([]any, 0, len(types))
		for _, field := range types {
			value, err := d.value(field, depth+1)
			if err != nil {
				return nil, err
			}
			fields = append(fields, value)
		}
		return fields, nil
	}
	return nil, errMalformed
}

func (d *decoder) array(elem string, depth int) (any, error) {
	n, err := d.u32()
	if err != nil {
		return nil, err
	}
	if err := d.align(alignment(elem)); err != nil {
		return nil, err
	}
	end := d.pos + int(n)
	if end > len(d.b) {
		return nil, errMalformed
	}
	if elem == "y" {
		b, err := d.take(int(n))
		return append([]byte(nil), b...), err
	}
	if elem[0] == '{' {
		types, err := split(elem[1 : len(elem)-1])
		if err != nil || len(types) != 2 {
			return nil, errMalformed
		}
		named := map[string]any{}
		other := map[any]any{}
		for d.pos < end {
			if err := d.align(8); err != nil {
				return nil, err
			}
			key, err := d.value(types[0], depth+1)
			if err != nil {
				return nil, err
			}
			value, err := d.value(types[1], depth+1)
			if err != nil {
				return nil, err
			}
			if s, ok := key.(string); ok {
				named[s] = value
			} else {
				other[key] = value
			}
		}
		if len(other) > 0 {
			return other, nil
		}
		return named, nil
	}
	var list []any
	for d.pos < end {
		value, err := d.value(elem, depth+1)
		if err != nil {
			return nil, err
		}
		list = append(list, value)
	}
	if d.pos != end {
		return nil, errMalformed
	}
	if elem == "s" || elem == "o" {
		strs := make([]string, len(list))
		for i, item := range list {
			strs[i] = item.(string)
		}
		return strs, nil
	}
	return list, nil
}
