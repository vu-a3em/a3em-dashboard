//go:build linux

package platform

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/dbus"
)

/*
	Linux, through lsblk, udisksctl, exfatprogs and sysfs.

	  - udisksctl needs no root: mount, unmount and power-off go through polkit, which asks
	    the desktop's own agent. Raw writes need root, so they go to the worker under pkexec.
	  - A card in a native SD slot is /dev/mmcblkN, which the kernel does not mark removable.
	    /sys/block/mmcblkN/device/type is "SD" for a card and "MMC" for soldered eMMC, and the
	    card's CID register is readable beside it. A card in a USB reader is /dev/sdX.
	  - statfs reports the cluster size for exFAT and FAT (unlike macOS).
	  - Without udev (a container, or the moment after a format) lsblk reports no filesystem;
	    blkid -p reads the partition itself.
	  - exfatprogs, which provides fsck.exfat, is not installed everywhere. Its absence is
	    reported with the package name rather than as a bare failure.
*/

type linux struct{}

// Current is this operating system's platform.
func Current() Platform { return linux{} }

func (linux) ID() string { return "linux" }

type flexBool bool

func (b *flexBool) UnmarshalJSON(raw []byte) error {
	s := strings.Trim(string(raw), `"`)
	*b = flexBool(s == "true" || s == "1")
	return nil
}

type flexInt int64

func (n *flexInt) UnmarshalJSON(raw []byte) error {
	s := strings.Trim(string(raw), `"`)
	if s == "null" || s == "" {
		return nil
	}
	v, err := strconv.ParseInt(s, 10, 64)
	*n = flexInt(v)
	return err
}

type lsblkDevice struct {
	Name       string        `json:"name"`
	Size       flexInt       `json:"size"`
	RM         flexBool      `json:"rm"`
	Hotplug    flexBool      `json:"hotplug"`
	RO         flexBool      `json:"ro"`
	Tran       *string       `json:"tran"`
	Type       string        `json:"type"`
	PTType     *string       `json:"pttype"`
	FSType     *string       `json:"fstype"`
	Label      *string       `json:"label"`
	UUID       *string       `json:"uuid"`
	Mountpoint *string       `json:"mountpoint"`
	Model      *string       `json:"model"`
	Vendor     *string       `json:"vendor"`
	Children   []lsblkDevice `json:"children"`
}

func lsblk(args ...string) ([]lsblkDevice, error) {
	out, err := Run(time.Minute, "lsblk", append([]string{"-J", "-b", "-p", "-o",
		"NAME,SIZE,RM,HOTPLUG,RO,TRAN,TYPE,PTTYPE,FSTYPE,LABEL,UUID,MOUNTPOINT,MODEL,VENDOR"}, args...))
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Blockdevices []lsblkDevice `json:"blockdevices"`
	}
	if err := json.Unmarshal([]byte(out.Stdout), &parsed); err != nil {
		return nil, fmt.Errorf("could not read lsblk output: %w", err)
	}
	return parsed.Blockdevices, nil
}

func text(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}

func sysfs(name, file string) string {
	raw, _ := os.ReadFile(filepath.Join("/sys/block", name, file))
	return strings.TrimSpace(string(raw))
}

// holdsSystem is whether anything the running system depends on is mounted below this node.
func holdsSystem(d lsblkDevice) bool {
	switch text(d.Mountpoint) {
	case "/", "/boot", "/boot/efi", "/usr", "/var", "/home", "[SWAP]":
		return true
	}
	for _, child := range d.Children {
		if holdsSystem(child) {
			return true
		}
	}
	return false
}

func linuxScheme(pt string) PartitionScheme {
	switch pt {
	case "dos":
		return SchemeMBR
	case "gpt":
		return SchemeGPT
	case "":
		return SchemeNone
	}
	return SchemeUnknown
}

// probeScheme fills in the partition table type lsblk leaves empty without udev, as
// probeFilesystem does for filesystems. A disk the kernel found partitions on has a table even
// when nothing can say which, so it is unknown then, not absent: "no partition map" would tell
// the dashboard the card needs formatting.
func probeScheme(disk lsblkDevice) PartitionScheme {
	if pt := text(disk.PTType); pt != "" {
		return linuxScheme(pt)
	}
	if out, err := Run(30*time.Second, "blkid", []string{"-p", "-o", "export", disk.Name}, 0, 2); err == nil {
		for _, line := range strings.Split(out.Stdout, "\n") {
			if key, value, ok := strings.Cut(line, "="); ok && key == "PTTYPE" {
				return linuxScheme(strings.TrimSpace(value))
			}
		}
	}
	for _, child := range disk.Children {
		if child.Type == "part" {
			return SchemeUnknown
		}
	}
	return SchemeNone
}

func (linux) ListDevices() ([]Device, error) {
	tree, err := lsblk()
	if err != nil {
		return nil, err
	}
	var devices []Device
	for _, disk := range tree {
		if disk.Type != "disk" && disk.Type != "loop" {
			continue
		}
		name := filepath.Base(disk.Name)
		d := Device{
			ID: name, Node: disk.Name, SizeBytes: int64(disk.Size), Removable: bool(disk.RM) || bool(disk.Hotplug),
			Bus: nonEmpty(strings.ToUpper(text(disk.Tran)), "unknown"), IsBootDevice: holdsSystem(disk),
			Virtual:         disk.Type == "loop" || strings.HasPrefix(name, "nbd") || strings.HasPrefix(name, "zram") || strings.HasPrefix(name, "ram"),
			PartitionScheme: probeScheme(disk), WriteProtected: bool(disk.RO), Volumes: []Volume{},
		}
		if strings.HasPrefix(name, "mmcblk") {
			// The kernel does not mark an SD card removable; the card's own type says what it is.
			d.Removable = sysfs(name, "device/type") == "SD"
			d.Bus = "Secure Digital"
		}
		if d.Virtual {
			d.Bus = "Loop device"
		}
		for _, part := range disk.Children {
			if part.Type != "part" {
				continue
			}
			d.Volumes = append(d.Volumes, linuxVolume(name, part))
		}
		devices = append(devices, d)
	}
	return devices, nil
}

// probeFilesystem fills in what lsblk leaves empty without udev — in a container, or before
// udev has caught up — by asking blkid to read the partition itself, where this process may.
func probeFilesystem(part *lsblkDevice) {
	if text(part.FSType) != "" {
		return
	}
	if file, err := os.Open(part.Name); err == nil {
		file.Close()
	} else {
		return
	}
	out, err := Run(30*time.Second, "blkid", []string{"-p", "-o", "export", part.Name}, 0, 2)
	if err != nil {
		return
	}
	for _, line := range strings.Split(out.Stdout, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		switch key {
		case "TYPE":
			part.FSType = &value
		case "LABEL":
			part.Label = &value
		case "UUID":
			part.UUID = &value
		}
	}
}

func linuxVolume(disk string, part lsblkDevice) Volume {
	probeFilesystem(&part)
	id := filepath.Base(part.Name)
	fs := strings.ToLower(text(part.FSType))
	if fs == "vfat" {
		fs = "msdos"
	}
	v := Volume{ID: id, Node: part.Name, Label: str(text(part.Label)), Filesystem: str(fs), SizeBytes: int64(part.Size),
		MountPoint: str(text(part.Mountpoint)), Mountable: fs != "", UUID: text(part.UUID)}
	if start, err := strconv.ParseInt(sysfs(disk, id+"/start"), 10, 64); err == nil {
		v.PartitionOffsetBytes = i64(start * 512)
	}
	if v.MountPoint != nil {
		var stat syscall.Statfs_t
		if syscall.Statfs(*v.MountPoint, &stat) == nil {
			v.FreeBytes = i64(int64(stat.Bavail) * int64(stat.Bsize))
			if fs == "exfat" || fs == "msdos" {
				v.AllocationUnitBytes = i64(int64(stat.Bsize))
			}
		}
	}
	if v.AllocationUnitBytes == nil && fs == "exfat" {
		v.AllocationUnitBytes = exfatClusterFromBootSector(part.Name)
	}
	return v
}

// exfatClusterFromBootSector reads the cluster size an unmounted exFAT volume declares, where
// this process may read the partition.
func exfatClusterFromBootSector(node string) *int64 {
	file, err := os.Open(node)
	if err != nil {
		return nil
	}
	defer file.Close()
	sector := make([]byte, 512)
	if _, err := file.ReadAt(sector, 0); err != nil || string(sector[3:11]) != "EXFAT   " {
		return nil
	}
	return i64(int64(1) << (sector[108] + sector[109]))
}

func (p linux) find(volumeID string) (*Device, *Volume, error) {
	devices, err := p.ListDevices()
	if err != nil {
		return nil, nil, err
	}
	for i := range devices {
		for j := range devices[i].Volumes {
			if devices[i].Volumes[j].ID == volumeID {
				return &devices[i], &devices[i].Volumes[j], nil
			}
		}
	}
	return nil, nil, fmt.Errorf("no volume called %s", volumeID)
}

func (p linux) Inspect(volumeID string) (Geometry, error) {
	d, v, err := p.find(volumeID)
	if err != nil {
		return Geometry{}, err
	}
	g := Geometry{PartitionScheme: d.PartitionScheme, Filesystem: v.Filesystem, AllocationUnitBytes: v.AllocationUnitBytes, Mountable: v.Mountable}
	if size, err := strconv.ParseInt(sysfs(d.ID, "queue/logical_block_size"), 10, 64); err == nil {
		g.BytesPerSector = i64(size)
	}
	return g, nil
}

func have(tool string) bool {
	_, err := exec.LookPath(tool)
	return err == nil
}

func (p linux) Mount(volumeID string) error {
	node := "/dev/" + volumeID
	if have("udisksctl") && os.Geteuid() != 0 {
		_, err := Run(time.Minute, "udisksctl", []string{"mount", "-b", node})
		return explainMount(err)
	}
	if os.Geteuid() != 0 {
		return &CommandError{Message: "udisks2 is not installed, so the card cannot be mounted without root. Mount it from the file manager.", Command: "udisksctl"}
	}
	_, v, err := p.find(volumeID)
	if err != nil {
		return err
	}
	if v.MountPoint != nil {
		return nil
	}
	dir := filepath.Join("/run/media/a3em", volumeID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	_, err = Run(time.Minute, "mount", []string{node, dir})
	return explainMount(err)
}

// explainMount turns "unknown filesystem type" into what to install.
func explainMount(err error) error {
	if command, ok := err.(*CommandError); ok && strings.Contains(command.Output+command.Message, "unknown filesystem type") {
		command.Message = "This system cannot mount exFAT: its kernel has no exFAT driver. Install a kernel with one (5.4 or later), or the exfat-fuse package."
	}
	return err
}

func (p linux) Unmount(volumeID string) error {
	node := "/dev/" + volumeID
	if have("udisksctl") && os.Geteuid() != 0 {
		_, err := Run(time.Minute, "udisksctl", []string{"unmount", "-b", node})
		return err
	}
	_, err := Run(time.Minute, "umount", []string{node})
	return err
}

// Rename unmounts the card, names it, and mounts it again: exFAT cannot be renamed while
// mounted. As the person at the computer, udisks2 does it, which renames a removable card for
// them as it mounts one; its command-line tool has no command for it, so it is asked over D-Bus.
// As root, with no udisks2 to ask, the filesystem's own tool does it. The mount point changes
// with the name.
func (p linux) Rename(volumeID, label string) error {
	_, v, err := p.find(volumeID)
	if err != nil {
		return err
	}
	mounted := v.MountPoint != nil
	if mounted {
		if err := p.Unmount(volumeID); err != nil {
			return err
		}
	}
	if os.Geteuid() != 0 {
		err = udisksRename(volumeID, label)
	} else {
		err = relabel(volumeID, v, label)
	}
	if mounted {
		if again := p.Mount(volumeID); err == nil {
			err = again
		}
	}
	return err
}

func relabel(volumeID string, v *Volume, label string) error {
	filesystem := ""
	if v.Filesystem != nil {
		filesystem = *v.Filesystem
	}
	tool := map[string]string{"exfat": "exfatlabel", "vfat": "fatlabel"}[filesystem]
	if tool == "" || !have(tool) {
		return &CommandError{Message: "This computer has no tool to rename the card. Install exfatprogs.", Command: "exfatlabel"}
	}
	_, err := Run(time.Minute, tool, []string{"/dev/" + volumeID, label})
	return err
}

func udisksRename(volumeID, label string) error {
	bus, err := dbus.System()
	if err != nil {
		return &CommandError{Message: "udisks2 could not be reached to rename the card: " + err.Error(), Command: "udisks2"}
	}
	defer bus.Close()
	// Two minutes, for a password prompt if the system's policy asks for one.
	_, err = bus.Call("org.freedesktop.UDisks2", "/org/freedesktop/UDisks2/block_devices/"+udisksName(volumeID),
		"org.freedesktop.UDisks2.Filesystem", "SetLabel", 2*time.Minute, "sa{sv}", label, map[string]dbus.Variant{})
	if err != nil {
		return &CommandError{Message: "udisks2 did not rename the card: " + err.Error(), Command: "udisks2 SetLabel"}
	}
	return nil
}

// udisksName is a block device's name as udisks2 writes it in an object path: letters and
// digits as they are, anything else as _ and two hex digits.
func udisksName(name string) string {
	var out strings.Builder
	for _, b := range []byte(name) {
		if b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' {
			out.WriteByte(b)
		} else {
			fmt.Fprintf(&out, "_%02x", b)
		}
	}
	return out.String()
}

func (p linux) Eject(deviceID string) error {
	devices, err := p.ListDevices()
	if err != nil {
		return err
	}
	for _, d := range devices {
		if d.ID != deviceID {
			continue
		}
		for _, v := range d.Volumes {
			if v.MountPoint != nil {
				if err := p.Unmount(v.ID); err != nil {
					return err
				}
			}
		}
		if d.Virtual || !have("udisksctl") {
			Run(time.Minute, "sync", nil)
			return nil
		}
		_, err := Run(time.Minute, "udisksctl", []string{"power-off", "-b", d.Node})
		return err
	}
	return fmt.Errorf("no device called %s", deviceID)
}

func fsckFor(v *Volume) (string, error) {
	tool := "fsck.exfat"
	if v.Filesystem != nil && *v.Filesystem == "msdos" {
		tool = "fsck.vfat"
	}
	if !have(tool) {
		pkg := "exfatprogs"
		if tool == "fsck.vfat" {
			pkg = "dosfstools"
		}
		return "", &CommandError{Message: fmt.Sprintf("%s is not installed. Install the %s package.", tool, pkg), Command: tool}
	}
	return tool, nil
}

func (p linux) Diagnose(volumeID string) (FsckReport, error) {
	_, v, err := p.find(volumeID)
	if err != nil {
		return FsckReport{}, err
	}
	tool, err := fsckFor(v)
	if err != nil {
		return FsckReport{}, err
	}
	// -n: open read-only, answer no to everything. 4 means errors were found and left.
	out, err := Run(2*time.Hour, tool, []string{"-n", v.Node}, 0, 1, 4)
	if err != nil {
		return FsckReport{}, err
	}
	return fsckReport(out, false), nil
}

func (p linux) Repair(volumeID string) (FsckReport, error) {
	_, v, err := p.find(volumeID)
	if err != nil {
		return FsckReport{}, err
	}
	tool, err := fsckFor(v)
	if err != nil {
		return FsckReport{}, err
	}
	if v.MountPoint != nil {
		Run(time.Minute, "umount", []string{v.Node})
	}
	out, err := Run(2*time.Hour, tool, []string{"-y", v.Node}, 0, 1, 4)
	if err != nil {
		return FsckReport{}, err
	}
	return fsckReport(out, true), nil
}

// fsckReport is clean at 0 — and, after a repair, at 1, which is exfatprogs's "errors were
// corrected". Only 4, errors left uncorrected, or worse is a repair that did not finish the job.
func fsckReport(out Output, modified bool) FsckReport {
	code := out.Code
	clean := code == 0 || (modified && code == 1)
	return FsckReport{Clean: clean, Modified: modified, Output: strings.TrimSpace(out.Stdout + out.Stderr), ExitCode: &code}
}

func (linux) Identity(device Device) Identity {
	if strings.HasPrefix(device.ID, "mmcblk") && sysfs(device.ID, "device/type") == "SD" {
		identity := Identity{Source: "card", Product: sysfs(device.ID, "device/name"), Serial: sysfs(device.ID, "device/serial"),
			Reader: "Built-in SD card slot"}
		if id, err := strconv.ParseInt(strings.TrimPrefix(sysfs(device.ID, "device/manfid"), "0x"), 16, 32); err == nil {
			identity.Manufacturer = ManufacturerName(int(id))
		}
		// "MM/YYYY"
		if month, year, ok := strings.Cut(sysfs(device.ID, "device/date"), "/"); ok {
			identity.Manufactured = year + "-" + fmt.Sprintf("%02s", month)
		}
		return identity
	}
	reader := strings.TrimSpace(sysfs(device.ID, "device/vendor") + " " + sysfs(device.ID, "device/model"))
	return Identity{Source: "reader", Reader: reader}
}

func (linux) RawPath(device Device) string         { return device.Node }
func (linux) VolumeRawPath(volumeID string) string { return "/dev/" + volumeID }

func (p linux) Release(device Device) (func(), error) {
	devices, err := p.ListDevices()
	if err != nil {
		return func() {}, err
	}
	for _, d := range devices {
		if d.ID != device.ID {
			continue
		}
		for _, v := range d.Volumes {
			if v.MountPoint == nil {
				continue
			}
			// The format has been confirmed, so a lazy unmount is acceptable if a file manager
			// is holding the volume open.
			if _, err := Run(time.Minute, "umount", []string{v.Node}); err != nil {
				if _, err := Run(time.Minute, "umount", []string{"-l", v.Node}); err != nil {
					return func() {}, err
				}
			}
		}
	}
	return func() {}, nil
}

const blkrrpart = 0x125F

func (linux) Reread(device Device) error {
	file, err := os.Open(device.Node)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), blkrrpart, 0)
	file.Close()
	if errno != 0 {
		// Busy (something reopened a partition) or unsupported: partx asks per partition.
		if _, err := Run(time.Minute, "partx", []string{"-u", device.Node}); err != nil {
			return &CommandError{Message: "The system did not re-read the card's new partition table: " + errno.Error(), Command: "BLKRRPART"}
		}
	}
	return nil
}

func (p linux) Settle(device Device) (string, error) {
	var volume string
	err := Wait(20*time.Second, func() error {
		if have("udevadm") {
			Run(time.Minute, "udevadm", []string{"settle", "--timeout=5"})
		}
		devices, err := p.ListDevices()
		if err != nil {
			return err
		}
		for _, d := range devices {
			if d.ID == device.ID && len(d.Volumes) > 0 && d.Volumes[0].Filesystem != nil {
				volume = d.Volumes[0].ID
				if d.Volumes[0].MountPoint != nil {
					return nil
				}
				return p.Mount(volume)
			}
		}
		return fmt.Errorf("no exFAT partition has appeared on %s", device.ID)
	})
	return volume, err
}

func (linux) Elevate(executable string, args []string, reason string) (Command, error) {
	if !have("pkexec") {
		return Command{}, &CommandError{Message: "pkexec is not installed, so the helper cannot ask for administrator access. Install polkit, or run the helper as root.", Command: "pkexec"}
	}
	return Command{Name: "pkexec", Args: append([]string{executable}, args...)}, nil
}
