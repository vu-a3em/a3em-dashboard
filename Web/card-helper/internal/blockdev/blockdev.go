// Package blockdev is raw, uncached access to a card, or to a file standing in for one.
//
// Uncached matters more than it looks. The capacity probe writes a block and reads it back to
// see whether the card kept it; read through the operating system's cache, that read would be
// answered from memory and every counterfeit card would pass. So a device is opened with the
// platform's cache bypass (O_DIRECT on Linux, F_NOCACHE on macOS, FILE_FLAG_NO_BUFFERING on
// Windows), which in turn requires sector-aligned offsets, lengths, and memory — hence Aligned.
package blockdev

import (
	"errors"
	"io"
	"os"
	"unsafe"
)

// Alignment satisfies every platform's direct-I/O rules for 512-byte-sector media.
const Alignment = 4096

// Device is a card opened for raw access.
type Device interface {
	io.ReaderAt
	io.WriterAt
	// Size is the capacity in bytes, as the operating system reports it.
	Size() int64
	Sync() error
	Close() error
}

// ErrPermission is returned when the device exists but this process may not open it, which
// is the signal to retry through an elevated worker — or, on macOS, that the privacy settings
// refused it even with authorization.
var ErrPermission = errors.New("permission denied opening the raw device")

// Aligned returns a zeroed buffer of n bytes whose address is a multiple of Alignment.
func Aligned(n int) []byte {
	raw := make([]byte, n+Alignment)
	offset := int(uintptr(unsafe.Pointer(&raw[0])) & (Alignment - 1))
	if offset != 0 {
		offset = Alignment - offset
	}
	return raw[offset : offset+n : offset+n]
}

// file is a regular file used as a card, for tests and for disk images.
type file struct {
	*os.File
	size int64
}

func (f *file) Size() int64 { return f.size }

// OpenFile opens a regular file as a device.
func OpenFile(path string, write bool) (Device, error) {
	flag := os.O_RDONLY
	if write {
		flag = os.O_RDWR
	}
	handle, err := os.OpenFile(path, flag, 0)
	if err != nil {
		return nil, Classify(err)
	}
	info, err := handle.Stat()
	if err != nil {
		handle.Close()
		return nil, err
	}
	return &file{File: handle, size: info.Size()}, nil
}

// Open opens a raw device path — /dev/rdisk4, /dev/sdb, \\.\PhysicalDrive2 — or a regular file.
// sizeBytes is the capacity the platform reported, used where the device node cannot say.
func Open(path string, sizeBytes int64, write bool) (Device, error) {
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
		return OpenFile(path, write)
	}
	return openRaw(path, sizeBytes, write)
}

// WriteAll writes data at offset in aligned chunks, as direct I/O requires.
func WriteAll(dev Device, data []byte, offset int64, onChunk func(done int64)) error {
	const chunk = 1024 * 1024
	buffer := Aligned(chunk)
	for done := 0; done < len(data); done += chunk {
		n := copy(buffer, data[done:])
		if _, err := dev.WriteAt(buffer[:n], offset+int64(done)); err != nil {
			return err
		}
		if onChunk != nil {
			onChunk(int64(done + n))
		}
	}
	return nil
}

// ReadAll reads length bytes at offset in aligned chunks.
func ReadAll(dev Device, length int, offset int64) ([]byte, error) {
	const chunk = 1024 * 1024
	out := make([]byte, length)
	buffer := Aligned(chunk)
	for done := 0; done < length; done += chunk {
		n := chunk
		if length-done < n {
			n = length - done
		}
		if _, err := dev.ReadAt(buffer[:n], offset+int64(done)); err != nil {
			return nil, err
		}
		copy(out[done:], buffer[:n])
	}
	return out, nil
}

// ErrWriteProtected is returned when the card refuses writes: an SD card's lock switch, or a
// reader that reports the medium read-only.
var ErrWriteProtected = errors.New("the card is write-protected")

// Classify turns an open or write error into ErrPermission or ErrWriteProtected where it is
// one of those, and returns it unchanged otherwise.
func Classify(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrPermission), errors.Is(err, ErrWriteProtected):
		return err
	case isWriteProtect(err):
		return ErrWriteProtected
	case errors.Is(err, os.ErrPermission):
		return ErrPermission
	}
	return err
}
