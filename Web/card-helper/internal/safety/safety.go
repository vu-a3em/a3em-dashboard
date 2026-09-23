// Package safety decides which disks the helper may touch at all. A port of safety.ts.
//
// Ineligible devices are not merely refused: they never appear in a listing, so the page can
// never offer them. The rules live here rather than in a platform file so that they are
// testable on one operating system and identical on three.
package safety

import (
	"fmt"
	"os"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/platform"
)

const (
	MinCardBytes = int64(1) << 30
	MaxCardBytes = int64(2) << 40
)

// AllowVirtual includes disk images, which is how this is tested without risking a real card.
// A disk image is rarely marked removable (a Linux loop device or a Windows VHD never is), so
// with this set a virtual disk counts as removable.
func AllowVirtual() bool { return os.Getenv("A3EM_HELPER_ALLOW_VIRTUAL") == "1" || VirtualOnly() }

// VirtualOnly hides every real device, for testing on a computer with a real card attached.
func VirtualOnly() bool { return os.Getenv("A3EM_HELPER_VIRTUAL_ONLY") == "1" }

func removable(d platform.Device) bool { return d.Removable || (d.Virtual && AllowVirtual()) }

// Refused is a request the safety rules turned down.
type Refused struct{ Message, Code string }

func (r *Refused) Error() string { return r.Message }

// Eligible is whether a device may be listed at all.
func Eligible(d platform.Device) bool {
	return removable(d) && !d.Internal && !d.IsBootDevice && (AllowVirtual() || !d.Virtual) &&
		(d.Virtual || !VirtualOnly()) && d.SizeBytes >= MinCardBytes && d.SizeBytes <= MaxCardBytes
}

// RequireWritable returns why a device must not be written, or nil.
func RequireWritable(d *platform.Device, id string) error {
	switch {
	case d == nil:
		return &Refused{fmt.Sprintf("No removable device called %s is connected.", id), "unknown-device"}
	case d.IsBootDevice:
		return &Refused{fmt.Sprintf("%s is this computer's startup disk.", id), "boot-device"}
	case d.Virtual && !AllowVirtual():
		return &Refused{fmt.Sprintf("%s is a disk image, not a card.", id), "not-removable"}
	case !d.Virtual && VirtualOnly():
		return &Refused{fmt.Sprintf("%s is a real device, and this helper is running in test mode.", id), "not-removable"}
	case d.Internal:
		return &Refused{fmt.Sprintf("%s is an internal disk, not removable media.", id), "internal-device"}
	case !removable(*d):
		return &Refused{fmt.Sprintf("%s is not removable media.", id), "not-removable"}
	case d.SizeBytes < MinCardBytes:
		return &Refused{fmt.Sprintf("%s is %s, too small to be an SD card.", id, FormatSize(d.SizeBytes)), "implausible-size"}
	case d.SizeBytes > MaxCardBytes:
		return &Refused{fmt.Sprintf("%s is %s, far larger than any SD card — refusing in case it is a hard drive.", id, FormatSize(d.SizeBytes)), "implausible-size"}
	}
	return nil
}

// FormatSize is a capacity for a message, in the decimal units printed on a card.
func FormatSize(bytes int64) string {
	switch {
	case bytes >= 1e12:
		return fmt.Sprintf("%.1f TB", float64(bytes)/1e12)
	case bytes >= 1e9:
		return fmt.Sprintf("%.1f GB", float64(bytes)/1e9)
	case bytes >= 1e6:
		return fmt.Sprintf("%.0f MB", float64(bytes)/1e6)
	}
	return fmt.Sprintf("%d bytes", bytes)
}
