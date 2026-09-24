//go:build windows

package platform

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

/*
	Windows, through the Storage module's cmdlets, chkdsk and the disk IOCTLs.

	  - A USB card reader and a USB hard drive both have BusType USB. Win32_DiskDrive's
	    MediaType tells them apart: "Removable Media" for a card, "External hard disk media"
	    for a drive.
	  - Windows refuses raw writes into a mounted volume's sectors, so every volume on the card
	    is locked and dismounted (FSCTL_LOCK_VOLUME, FSCTL_DISMOUNT_VOLUME) for as long as the
	    format runs, and IOCTL_DISK_UPDATE_PROPERTIES makes it read the new partition table.
	  - chkdsk needs an elevated token even to only check, so diagnose goes to the worker too.
	  - Get-Volume reports AllocationUnitSize correctly, without elevation.
*/

type windows struct{}

// Current is this operating system's platform.
func Current() Platform { return windows{} }

func (windows) ID() string { return "win32" }

const listScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$media = @{}
Get-CimInstance Win32_DiskDrive | ForEach-Object { $media[[int]$_.Index] = [string]$_.MediaType }
$disks = @(Get-Disk | ForEach-Object {
  $d = $_
  $parts = @(Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue | ForEach-Object {
    $p = $_
    $v = $null
    try { $v = Get-Volume -Partition $p -ErrorAction Stop } catch {}
    $letter = ''
    if ([int]$p.DriveLetter -ne 0) { $letter = [string]$p.DriveLetter }
    [pscustomobject]@{
      Number = [int]$p.PartitionNumber; Offset = [int64]$p.Offset; Size = [int64]$p.Size; DriveLetter = $letter
      FileSystem = $(if ($v) { [string]$v.FileSystem } else { '' })
      Label = $(if ($v) { [string]$v.FileSystemLabel } else { '' })
      AllocationUnitSize = $(if ($v) { [int64]$v.AllocationUnitSize } else { 0 })
      SizeRemaining = $(if ($v) { [int64]$v.SizeRemaining } else { -1 })
      UniqueId = $(if ($v) { [string]$v.UniqueId } else { '' })
    }
  })
  [pscustomobject]@{
    Number = [int]$d.Number; FriendlyName = [string]$d.FriendlyName; Model = [string]$d.Model
    Size = [int64]$d.Size; BusType = [string]$d.BusType; PartitionStyle = [string]$d.PartitionStyle
    IsBoot = [bool]$d.IsBoot; IsSystem = [bool]$d.IsSystem; IsReadOnly = [bool]$d.IsReadOnly
    LogicalSectorSize = [int64]$d.LogicalSectorSize; MediaType = [string]$media[[int]$d.Number]
    Parts = $parts
  }
})
ConvertTo-Json -InputObject $disks -Depth 5 -Compress
`

type winPart struct {
	Number             int
	Offset, Size       int64
	DriveLetter        string
	FileSystem, Label  string
	AllocationUnitSize int64
	SizeRemaining      int64
	UniqueId           string
}

type winDisk struct {
	Number                       int
	FriendlyName, Model          string
	Size                         int64
	BusType, PartitionStyle      string
	IsBoot, IsSystem, IsReadOnly bool
	LogicalSectorSize            int64
	MediaType                    string
	Parts                        []winPart
}

func powershell(timeout time.Duration, script string) (Output, error) {
	return Run(timeout, "powershell.exe", []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script})
}

func psQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }

func listDisks() ([]winDisk, error) {
	out, err := powershell(2*time.Minute, listScript)
	if err != nil {
		return nil, err
	}
	var disks []winDisk
	if err := json.Unmarshal([]byte(strings.TrimSpace(out.Stdout)), &disks); err != nil {
		return nil, &CommandError{Message: "Could not read the disk listing: " + err.Error(), Command: "Get-Disk", Output: out.Stdout}
	}
	return disks, nil
}

func winFilesystem(fs string) string {
	switch strings.ToUpper(fs) {
	case "":
		return ""
	case "FAT32", "FAT", "FAT16":
		return "msdos"
	}
	return strings.ToLower(fs)
}

func volumeID(disk winDisk, part winPart) string {
	if part.DriveLetter != "" {
		return part.DriveLetter + ":"
	}
	return fmt.Sprintf("disk%dp%d", disk.Number, part.Number)
}

func winVolume(disk winDisk, part winPart) Volume {
	fs := winFilesystem(part.FileSystem)
	id := volumeID(disk, part)
	v := Volume{ID: id, Node: id, Label: str(part.Label), Filesystem: str(fs), SizeBytes: part.Size, Mountable: fs != "",
		PartitionOffsetBytes: i64(part.Offset), UUID: part.UniqueId}
	if part.DriveLetter != "" {
		mount := part.DriveLetter + `:\`
		v.MountPoint = &mount
		if serial, ok := volumeSerial(mount); ok {
			v.UUID = serial
		}
	}
	if part.AllocationUnitSize > 0 {
		v.AllocationUnitBytes = i64(part.AllocationUnitSize)
	}
	if part.SizeRemaining >= 0 && part.DriveLetter != "" {
		v.FreeBytes = i64(part.SizeRemaining)
	}
	return v
}

func (windows) ListDevices() ([]Device, error) {
	disks, err := listDisks()
	if err != nil {
		return nil, err
	}
	var devices []Device
	for _, disk := range disks {
		scheme := SchemeUnknown
		switch strings.ToUpper(disk.PartitionStyle) {
		case "MBR":
			scheme = SchemeMBR
		case "GPT":
			scheme = SchemeGPT
		case "RAW":
			scheme = SchemeNone
		}
		bus := disk.BusType
		d := Device{
			ID: strconv.Itoa(disk.Number), Node: fmt.Sprintf(`\\.\PhysicalDrive%d`, disk.Number), SizeBytes: disk.Size,
			Removable: strings.Contains(strings.ToLower(disk.MediaType), "removable") || bus == "SD" || bus == "MMC",
			Bus:       nonEmpty(bus, "unknown"), IsBootDevice: disk.IsBoot || disk.IsSystem,
			Virtual:         bus == "File Backed Virtual" || bus == "Virtual",
			PartitionScheme: scheme, WriteProtected: disk.IsReadOnly, Volumes: []Volume{},
		}
		if bus == "SD" || bus == "MMC" {
			d.Bus = "Secure Digital"
		}
		for _, part := range disk.Parts {
			d.Volumes = append(d.Volumes, winVolume(disk, part))
		}
		devices = append(devices, d)
	}
	return devices, nil
}

// locate finds a volume's disk and partition.
func locate(volumeID string) (winDisk, winPart, error) {
	disks, err := listDisks()
	if err != nil {
		return winDisk{}, winPart{}, err
	}
	for _, disk := range disks {
		for _, part := range disk.Parts {
			if strings.EqualFold(volumeID, volumeIDOf(disk, part)) {
				return disk, part, nil
			}
		}
	}
	return winDisk{}, winPart{}, fmt.Errorf("no volume called %s", volumeID)
}

func volumeIDOf(disk winDisk, part winPart) string { return volumeID(disk, part) }

func (windows) Inspect(volumeID string) (Geometry, error) {
	disk, part, err := locate(volumeID)
	if err != nil {
		return Geometry{}, err
	}
	v := winVolume(disk, part)
	scheme := SchemeUnknown
	switch strings.ToUpper(disk.PartitionStyle) {
	case "MBR":
		scheme = SchemeMBR
	case "GPT":
		scheme = SchemeGPT
	case "RAW":
		scheme = SchemeNone
	}
	g := Geometry{PartitionScheme: scheme, Filesystem: v.Filesystem, AllocationUnitBytes: v.AllocationUnitBytes, Mountable: v.Mountable}
	if disk.LogicalSectorSize > 0 {
		g.BytesPerSector = i64(disk.LogicalSectorSize)
	}
	return g, nil
}

func (windows) Mount(volumeID string) error {
	disk, part, err := locate(volumeID)
	if err != nil {
		return err
	}
	if part.DriveLetter != "" {
		return nil
	}
	_, err = powershell(time.Minute, fmt.Sprintf("Add-PartitionAccessPath -DiskNumber %d -PartitionNumber %d -AssignDriveLetter", disk.Number, part.Number))
	return err
}

func (windows) Unmount(volumeID string) error {
	disk, part, err := locate(volumeID)
	if err != nil {
		return err
	}
	if part.DriveLetter == "" {
		return nil
	}
	_, err = powershell(time.Minute, fmt.Sprintf("Remove-PartitionAccessPath -DiskNumber %d -PartitionNumber %d -AccessPath %s",
		disk.Number, part.Number, psQuote(part.DriveLetter+`:\`)))
	return err
}

func (windows) Eject(deviceID string) error {
	disks, err := listDisks()
	if err != nil {
		return err
	}
	for _, disk := range disks {
		if strconv.Itoa(disk.Number) != deviceID {
			continue
		}
		for _, part := range disk.Parts {
			if part.DriveLetter == "" {
				continue
			}
			// The Explorer "Eject" verb: flushes and dismounts removable media without elevation.
			script := fmt.Sprintf("(New-Object -ComObject Shell.Application).Namespace(17).ParseName(%s).InvokeVerb('Eject')", psQuote(part.DriveLetter+":"))
			if _, err := powershell(time.Minute, script); err != nil {
				return err
			}
		}
		return nil
	}
	return fmt.Errorf("no disk %s", deviceID)
}

func chkdskTarget(volumeID string) (string, error) {
	disk, part, err := locate(volumeID)
	if err != nil {
		return "", err
	}
	if part.DriveLetter != "" {
		return part.DriveLetter + ":", nil
	}
	if part.UniqueId != "" {
		return strings.TrimSuffix(part.UniqueId, `\`), nil
	}
	return "", fmt.Errorf("disk %d partition %d has no volume to check", disk.Number, part.Number)
}

func (windows) Diagnose(volumeID string) (FsckReport, error) {
	target, err := chkdskTarget(volumeID)
	if err != nil {
		return FsckReport{}, err
	}
	// Without /f, chkdsk only reads. 0 is clean; 3 means problems it was not allowed to fix.
	out, err := Run(2*time.Hour, "chkdsk.exe", []string{target}, 0, 1, 2, 3)
	if err != nil {
		return FsckReport{}, err
	}
	return fsckReport(out, false), nil
}

func (windows) Repair(volumeID string) (FsckReport, error) {
	target, err := chkdskTarget(volumeID)
	if err != nil {
		return FsckReport{}, err
	}
	out, err := Run(2*time.Hour, "chkdsk.exe", []string{target, "/f", "/x"}, 0, 1, 2, 3)
	if err != nil {
		return FsckReport{}, err
	}
	return fsckReport(out, true), nil
}

// fsckReport is clean at 0 — and, after chkdsk /f, at 1 (errors found and fixed) or 2 (cleanup
// performed). 3 is a check that could not finish or errors it could not fix.
func fsckReport(out Output, modified bool) FsckReport {
	code := out.Code
	clean := code == 0 || (modified && (code == 1 || code == 2))
	return FsckReport{Clean: clean, Modified: modified, Output: strings.TrimSpace(out.Stdout + out.Stderr), ExitCode: &code}
}

// Identity is the reader only: Windows does not pass a card's CID register through a USB reader.
func (windows) Identity(device Device) Identity {
	disks, _ := listDisks()
	for _, disk := range disks {
		if strconv.Itoa(disk.Number) == device.ID {
			return Identity{Source: "reader", Reader: nonEmpty(disk.FriendlyName, disk.Model)}
		}
	}
	return Identity{Source: "reader"}
}

func (windows) RawPath(device Device) string { return device.Node }

func (windows) VolumeRawPath(volumeID string) string {
	if len(volumeID) == 2 && volumeID[1] == ':' {
		return `\\.\` + volumeID
	}
	if _, part, err := locate(volumeID); err == nil && part.UniqueId != "" {
		return strings.TrimSuffix(part.UniqueId, `\`)
	}
	return `\\.\` + volumeID
}

const (
	fsctlLockVolume           = 0x00090018
	fsctlUnlockVolume         = 0x0009001C
	fsctlDismountVolume       = 0x00090020
	ioctlDiskUpdateProperties = 0x00070140
)

func ioctl(handle syscall.Handle, code uint32) error {
	var returned uint32
	return syscall.DeviceIoControl(handle, code, nil, 0, nil, 0, &returned, nil)
}

func openVolume(path string) (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	return syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE,
		nil, syscall.OPEN_EXISTING, 0, 0)
}

// Release locks and dismounts every volume on the disk, and keeps them locked until the
// returned function runs, so Windows can neither refuse the writes nor remount mid-format.
func (w windows) Release(device Device) (func(), error) {
	disks, err := listDisks()
	if err != nil {
		return func() {}, err
	}
	var held []syscall.Handle
	release := func() {
		for _, handle := range held {
			ioctl(handle, fsctlUnlockVolume)
			syscall.CloseHandle(handle)
		}
	}
	for _, disk := range disks {
		if strconv.Itoa(disk.Number) != device.ID {
			continue
		}
		for _, part := range disk.Parts {
			path := ""
			switch {
			case part.DriveLetter != "":
				path = `\\.\` + part.DriveLetter + ":"
			case part.UniqueId != "":
				path = strings.TrimSuffix(part.UniqueId, `\`)
			default:
				continue
			}
			handle, err := openVolume(path)
			if err != nil {
				release()
				return func() {}, &CommandError{Message: fmt.Sprintf("Could not open %s to release it: %v", path, err), Command: "CreateFile"}
			}
			// A lock fails if another program has a file open; the dismount still invalidates
			// its handles, which is acceptable for a card that is about to be erased.
			ioctl(handle, fsctlLockVolume)
			if err := ioctl(handle, fsctlDismountVolume); err != nil {
				syscall.CloseHandle(handle)
				release()
				return func() {}, &CommandError{Message: fmt.Sprintf("Windows would not release %s: %v", path, err), Command: "FSCTL_DISMOUNT_VOLUME"}
			}
			held = append(held, handle)
		}
	}
	return release, nil
}

func (windows) Reread(device Device) error {
	handle, err := openVolume(device.Node)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	if err := ioctl(handle, ioctlDiskUpdateProperties); err != nil {
		return &CommandError{Message: "Windows did not re-read the card's new partition table: " + err.Error(), Command: "IOCTL_DISK_UPDATE_PROPERTIES"}
	}
	return nil
}

func (w windows) Settle(device Device) (string, error) {
	var volume string
	started := time.Now()
	err := Wait(30*time.Second, func() error {
		disks, err := listDisks()
		if err != nil {
			return err
		}
		for _, disk := range disks {
			if strconv.Itoa(disk.Number) != device.ID || len(disk.Parts) == 0 {
				continue
			}
			part := disk.Parts[0]
			if winFilesystem(part.FileSystem) != "exfat" {
				return fmt.Errorf("the new exFAT volume has not appeared on disk %s", device.ID)
			}
			if part.DriveLetter != "" {
				volume = part.DriveLetter + ":"
				return nil
			}
			// Removable media gets a letter by itself; give it a moment before asking.
			if time.Since(started) > 5*time.Second {
				powershell(time.Minute, fmt.Sprintf("Add-PartitionAccessPath -DiskNumber %d -PartitionNumber %d -AssignDriveLetter", disk.Number, part.Number))
			}
			return fmt.Errorf("the new volume on disk %s has no drive letter", device.ID)
		}
		return fmt.Errorf("disk %s has no partition", device.ID)
	})
	return volume, err
}

func (windows) Elevate(executable string, args []string, reason string) (Command, error) {
	quoted := make([]string, len(args))
	for i, arg := range args {
		// Start-Process joins its argument list with spaces and no quoting of its own.
		quoted[i] = psQuote(`"` + arg + `"`)
	}
	script := fmt.Sprintf("$p = Start-Process -FilePath %s -ArgumentList %s -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode",
		psQuote(executable), strings.Join(quoted, ","))
	return Command{Name: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script}}, nil
}

var getVolumeInformation = syscall.NewLazyDLL("kernel32.dll").NewProc("GetVolumeInformationW")

// volumeSerial is the volume serial number, as "XXXX-XXXX", which a new format changes.
func volumeSerial(root string) (string, bool) {
	name, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return "", false
	}
	var serial, maxComponent, flags uint32
	ok, _, _ := getVolumeInformation.Call(uintptr(unsafe.Pointer(name)), 0, 0,
		uintptr(unsafe.Pointer(&serial)), uintptr(unsafe.Pointer(&maxComponent)), uintptr(unsafe.Pointer(&flags)), 0, 0)
	if ok == 0 {
		return "", false
	}
	return fmt.Sprintf("%04X-%04X", serial>>16, serial&0xffff), true
}
