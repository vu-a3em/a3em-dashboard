// Package platform is everything that differs between macOS, Windows and Linux: finding
// cards, mounting them, and getting raw access to them. Everything above it — safety rules,
// grants, formatting, probing — is shared and tested on one machine for all three.
package platform

import "fmt"

// PartitionScheme matches the dashboard schema's PartitionScheme.
type PartitionScheme string

const (
	SchemeMBR     PartitionScheme = "mbr"
	SchemeGPT     PartitionScheme = "gpt"
	SchemeNone    PartitionScheme = "none"
	SchemeUnknown PartitionScheme = "unknown"
)

// Device is a whole disk as the operating system describes it.
type Device struct {
	ID              string          `json:"id"`
	Node            string          `json:"node"`
	SizeBytes       int64           `json:"sizeBytes"`
	Removable       bool            `json:"removable"`
	Internal        bool            `json:"internal"`
	Bus             string          `json:"bus"`
	IsBootDevice    bool            `json:"isBootDevice"`
	Virtual         bool            `json:"virtual"`
	PartitionScheme PartitionScheme `json:"partitionScheme"`
	WriteProtected  bool            `json:"writeProtected"`
	Volumes         []Volume        `json:"volumes"`
}

// Volume is one partition and the filesystem on it.
type Volume struct {
	ID                  string  `json:"id"`
	Node                string  `json:"node"`
	Label               *string `json:"label"`
	Filesystem          *string `json:"filesystem"`
	SizeBytes           int64   `json:"sizeBytes"`
	MountPoint          *string `json:"mountPoint"`
	AllocationUnitBytes *int64  `json:"allocationUnitBytes"`
	Mountable           bool    `json:"mountable"`
	// PartitionOffsetBytes is where the partition starts, when the platform says.
	PartitionOffsetBytes *int64 `json:"partitionOffsetBytes,omitempty"`
	FreeBytes            *int64 `json:"freeBytes,omitempty"`
	// UUID is the stable identifier the system derives from the volume's serial number. A new
	// format gives a new one, so it tells a re-formatted card from the one that was tested.
	UUID string `json:"uuid,omitempty"`
}

// Geometry matches the dashboard schema's CardGeometry, which judges it.
type Geometry struct {
	PartitionScheme     PartitionScheme `json:"partitionScheme"`
	Filesystem          *string         `json:"filesystem"`
	BytesPerSector      *int64          `json:"bytesPerSector"`
	AllocationUnitBytes *int64          `json:"allocationUnitBytes"`
	Mountable           bool            `json:"mountable"`
	Dirty               *bool           `json:"dirty,omitempty"`
}

// Identity is what can be learned about the card itself, or failing that, the reader.
//
// Through a USB reader the card's own registers are out of reach, so Source says which it
// is: "card" (from its CID register — manufacturer, serial, date) or "reader".
type Identity struct {
	Source       string `json:"source"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Product      string `json:"product,omitempty"`
	Serial       string `json:"serial,omitempty"`
	Manufactured string `json:"manufactured,omitempty"`
	Reader       string `json:"reader,omitempty"`
}

// FsckReport is the result of a filesystem check or repair.
type FsckReport struct {
	Clean    bool   `json:"clean"`
	Modified bool   `json:"modified"`
	Output   string `json:"output"`
	ExitCode *int   `json:"exitCode"`
}

// Platform is one operating system's implementation.
type Platform interface {
	ID() string
	ListDevices() ([]Device, error)
	Inspect(volumeID string) (Geometry, error)
	Mount(volumeID string) error
	Unmount(volumeID string) error
	Eject(deviceID string) error
	// Rename gives a volume a new name, leaving it mounted as it was. On Windows that takes
	// administrator rights, so there it runs in the elevated worker.
	Rename(volumeID, label string) error
	Diagnose(volumeID string) (FsckReport, error)
	Repair(volumeID string) (FsckReport, error)
	Identity(device Device) Identity

	// RawPath is the node raw I/O goes through: /dev/rdiskN, /dev/sdX, \\.\PhysicalDriveN.
	RawPath(device Device) string
	// VolumeRawPath is the node a filesystem check opens for one volume.
	VolumeRawPath(volumeID string) string
	// Release makes the whole disk safe to write raw: nothing mounted, nothing held. It runs
	// in the process doing the writing, which may be the elevated worker. The returned function
	// is called once writing is finished.
	Release(device Device) (func(), error)
	// Reread tells the system the partition table changed. Same process as Release.
	Reread(device Device) error
	// Settle waits for the system to see the new volume, mounts it, and returns its ID. It runs
	// in the unprivileged helper, so the mounted volume belongs to the user.
	Settle(device Device) (string, error)
	// Elevate returns the command that runs this executable's worker mode with administrator
	// rights, prompting the user in whatever way the platform does.
	Elevate(executable string, args []string, reason string) (Command, error)
}

// Command is a prepared process: the program and its arguments.
type Command struct {
	Name string
	Args []string
}

// CommandError is a platform tool that failed, with its output for the report.
type CommandError struct {
	Message string
	Command string
	Code    int
	Output  string
}

func (e *CommandError) Error() string { return e.Message }

// NotImplemented is an operation a platform does not offer yet.
type NotImplemented struct{ Platform, Operation, Plan string }

func (e *NotImplemented) Error() string {
	return fmt.Sprintf("%s is not implemented on %s yet. Planned implementation: %s", e.Operation, e.Platform, e.Plan)
}

func str(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func i64(value int64) *int64 { return &value }
