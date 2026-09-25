//go:build darwin

package platform

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vu-a3em/a3em-dashboard/card-helper/internal/blockdev"
)

/*
	macOS, through diskutil, fsck_exfat and system_profiler.

	What the manual pages do not lead you to, all confirmed against a card in the built-in
	SDXC slot and against hdiutil images:

	  - A card in a built-in reader is "Internal": the reader is. Whether the medium is the
	    computer's own storage is OSInternalMedia, which is false for any card.
	  - An external SSD is RemovableMediaOrExternalDevice and Ejectable, but not Removable or
	    RemovableMedia. Only the last two describe a card.
	  - VirtualOrPhysical is "Virtual" for APFS containers as well as disk images; only
	    BusProtocol "Disk Image" identifies an image.
	  - statfs does not report the cluster size: it gives 1 MiB for exFAT.
	    VolumeAllocationBlockSize does, without elevation.
	  - An exFAT partition's MBR type is shared with NTFS, so Content reads "Windows_NTFS" on
	    a good exFAT card. The filesystem comes from FilesystemType, never the partition type.
	  - A card's device node is root:operator, so raw reads and writes need the elevated
	    worker; a disk image's node belongs to whoever attached it, so tests need none.
	  - The built-in reader exposes the card's CID register — manufacturer, product, serial
	    and date — through system_profiler. A USB reader does not.
*/

type darwin struct{}

// Current is this operating system's platform.
func Current() Platform { return darwin{} }

func (darwin) ID() string { return "darwin" }

type diskutilList struct {
	AllDisksAndPartitions []struct {
		DeviceIdentifier   string
		Content            string
		Size               int64
		OSInternal         *bool
		APFSPhysicalStores []map[string]string
		Partitions         []struct{ DeviceIdentifier string }
	}
}

// infoConcurrency is how many diskutil queries run at once. Each takes about 90 ms, and a Mac with
// simulators and disk images installed can list twenty disks; asked one at a time, that was the
// several seconds before the dashboard could say whether card tools were ready.
const infoConcurrency = 8

type diskutilInfo struct {
	DeviceIdentifier               string
	DeviceNode                     string
	Size                           int64
	TotalSize                      int64
	Removable                      bool
	RemovableMedia                 bool
	RemovableMediaOrExternalDevice bool
	Ejectable                      bool
	Internal                       bool
	OSInternalMedia                *bool
	BusProtocol                    string
	Content                        string
	FilesystemType                 string
	VolumeName                     string
	MountPoint                     string
	VolumeAllocationBlockSize      int64
	DeviceBlockSize                int64
	ParentWholeDisk                string
	VirtualOrPhysical              string
	WritableMedia                  *bool
	PartitionMapPartitionOffset    *int64
	FreeSpace                      int64
	VolumeUUID                     string
	MediaName                      string
	IORegistryEntryName            string
	APFSPhysicalStores             []map[string]string
}

const apfsContainerScheme = "EF57347C-0000-11AA-AA11-00306543ECAC"

func plist(into any, args ...string) error {
	out, err := Run(0, "diskutil", args)
	if err != nil {
		return err
	}
	converted, err := runInput(out.Stdout, "plutil", "-convert", "json", "-o", "-", "-")
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(converted), into)
}

func info(identifier string) (diskutilInfo, error) {
	var i diskutilInfo
	err := plist(&i, "info", "-plist", identifier)
	return i, err
}

// Partition contents that are containers or metadata rather than a filesystem. They have no
// FilesystemType, which would otherwise read as a damaged card.
var containerContents = map[string]bool{
	"Apple_APFS": true, "Apple_APFS_Container": true, "Apple_APFS_ISC": true, "Apple_APFS_Recovery": true,
	"Apple_Boot": true, "Apple_CoreStorage": true, "EFI": true, "Linux_LVM": true, "Microsoft Reserved": true,
}

func volumeFrom(id string) (Volume, error) {
	i, err := info(id)
	if err != nil {
		return Volume{}, err
	}
	fs := strings.ToLower(i.FilesystemType)
	v := Volume{
		ID: id, Node: nonEmpty(i.DeviceNode, "/dev/"+id), Label: str(i.VolumeName), Filesystem: str(fs),
		SizeBytes: first(i.Size, i.TotalSize), MountPoint: str(i.MountPoint),
		Mountable: fs != "" || containerContents[i.Content], PartitionOffsetBytes: i.PartitionMapPartitionOffset,
		UUID: i.VolumeUUID,
	}
	if i.VolumeAllocationBlockSize > 0 {
		v.AllocationUnitBytes = i64(i.VolumeAllocationBlockSize)
	}
	if i.MountPoint != "" {
		v.FreeBytes = i64(i.FreeSpace)
	}
	return v, nil
}

func scheme(content string) PartitionScheme {
	switch content {
	case "FDisk_partition_scheme":
		return SchemeMBR
	case "GUID_partition_scheme":
		return SchemeGPT
	case "":
		return SchemeNone
	}
	return SchemeUnknown
}

func bootDisk() string {
	root, err := info("/")
	if err != nil {
		return ""
	}
	// The startup volume sits in an APFS container whose physical store is the real disk, so
	// one hop is not always enough.
	current := root.ParentWholeDisk
	for hop := 0; hop < 4 && current != ""; hop++ {
		next, err := info(current)
		if err != nil || next.ParentWholeDisk == "" || next.ParentWholeDisk == current {
			break
		}
		current = next.ParentWholeDisk
	}
	return current
}

func (darwin) ListDevices() ([]Device, error) {
	var list diskutilList
	if err := plist(&list, "list", "-plist"); err != nil {
		return nil, err
	}
	bootDone := make(chan string, 1)
	go func() { bootDone <- bootDisk() }()

	// Everything diskutil is asked, it is asked in parallel; a slot per disk keeps the order.
	slots := make([]*Device, len(list.AllDisksAndPartitions))
	limit := make(chan struct{}, infoConcurrency)
	var wait sync.WaitGroup
	for index, disk := range list.AllDisksAndPartitions {
		// A synthesized APFS container is a view of a partition on another disk, never a card:
		// the listing says so, so it is not worth asking about.
		if len(disk.APFSPhysicalStores) > 0 || disk.Content == apfsContainerScheme {
			continue
		}
		// The computer's own storage is never a card either. It is still listed, so a request
		// that names it is refused as internal rather than as unknown, but nothing more is asked.
		if disk.OSInternal != nil && *disk.OSInternal {
			slots[index] = &Device{
				ID: disk.DeviceIdentifier, Node: "/dev/" + disk.DeviceIdentifier, SizeBytes: disk.Size,
				Internal: true, Bus: "internal", PartitionScheme: scheme(disk.Content), Volumes: []Volume{},
			}
			continue
		}
		wait.Add(1)
		go func(index int, id string, partitions []string) {
			defer wait.Done()
			limit <- struct{}{}
			i, err := info(id)
			<-limit
			if err != nil {
				return // gone between the list and the info
			}
			if len(i.APFSPhysicalStores) > 0 || i.Content == apfsContainerScheme {
				return
			}
			internal := i.Internal
			if i.OSInternalMedia != nil {
				internal = *i.OSInternalMedia
			}
			d := Device{
				ID: id, Node: nonEmpty(i.DeviceNode, "/dev/"+id), SizeBytes: first(i.TotalSize, i.Size),
				// Removable media only. RemovableMediaOrExternalDevice and Ejectable are both true
				// for an external SSD, which must never be offered as a card.
				Removable: i.Removable || i.RemovableMedia,
				Internal:  internal, Bus: nonEmpty(i.BusProtocol, "unknown"),
				// VirtualOrPhysical is "Virtual" for APFS containers too; only a disk image is virtual here.
				Virtual:         i.BusProtocol == "Disk Image",
				PartitionScheme: scheme(i.Content), WriteProtected: i.WritableMedia != nil && !*i.WritableMedia,
				Volumes: make([]Volume, len(partitions)),
			}
			// Partitions are described only on a disk that could be offered as a card. Macs with
			// Xcode carry a disk image per simulator runtime, each with partitions of its own,
			// and asking about all of them was most of the wait.
			if internal || !(d.Removable || d.Virtual) || (d.Virtual && !VirtualAllowed()) {
				d.Volumes = []Volume{}
			} else {
				var parts sync.WaitGroup
				for n, partition := range partitions {
					parts.Add(1)
					go func(n int, partition string) {
						defer parts.Done()
						limit <- struct{}{}
						v, err := volumeFrom(partition)
						<-limit
						if err != nil {
							// An unreadable partition is the shape of the card this tool exists to recover,
							// so it is reported as unmountable rather than dropped.
							v = Volume{ID: partition, Node: "/dev/" + partition}
						}
						d.Volumes[n] = v
					}(n, partition)
				}
				parts.Wait()
			}
			slots[index] = &d
		}(index, disk.DeviceIdentifier, partitionIDs(disk.Partitions))
	}
	wait.Wait()
	boot := <-bootDone

	devices := []Device{}
	for _, d := range slots {
		if d == nil {
			continue
		}
		d.IsBootDevice = d.ID == boot
		devices = append(devices, *d)
	}
	return devices, nil
}

func partitionIDs(partitions []struct{ DeviceIdentifier string }) []string {
	ids := make([]string, len(partitions))
	for i, p := range partitions {
		ids[i] = p.DeviceIdentifier
	}
	return ids
}

func (p darwin) Inspect(volumeID string) (Geometry, error) {
	v, err := volumeFrom(volumeID)
	if err != nil {
		return Geometry{}, err
	}
	i, err := info(volumeID)
	if err != nil {
		return Geometry{}, err
	}
	disk, err := info(nonEmpty(i.ParentWholeDisk, volumeID))
	if err != nil {
		return Geometry{}, err
	}
	g := Geometry{PartitionScheme: scheme(disk.Content), Filesystem: v.Filesystem, AllocationUnitBytes: v.AllocationUnitBytes, Mountable: v.Mountable}
	if i.DeviceBlockSize > 0 {
		g.BytesPerSector = i64(i.DeviceBlockSize)
	}
	// fsck_exfat -q reports clean or dirty through its exit status without writing, but opens
	// the device, so it is only asked where that needs no prompt.
	if v.Filesystem != nil && *v.Filesystem == "exfat" && canOpen(p.VolumeRawPath(volumeID)) {
		if out, err := Run(time.Minute, "fsck_exfat", []string{"-q", p.VolumeRawPath(volumeID)}, 0, 1, 8); err == nil {
			dirty := out.Code != 0
			g.Dirty = &dirty
		}
	}
	return g, nil
}

func (darwin) Mount(volumeID string) error {
	_, err := Run(time.Minute, "diskutil", []string{"mount", volumeID})
	return err
}

func (darwin) Unmount(volumeID string) error {
	_, err := Run(time.Minute, "diskutil", []string{"unmount", volumeID})
	return err
}

// Rename needs no password: a removable card's volume belongs to the person using the computer,
// as it does when they rename it in the Finder. Its mount point changes with the name.
func (darwin) Rename(volumeID, label string) error {
	_, err := Run(time.Minute, "diskutil", []string{"rename", volumeID, label})
	return err
}

func (darwin) Eject(deviceID string) error {
	_, err := Run(time.Minute, "diskutil", []string{"eject", deviceID})
	return err
}

func fsckTool(volumeID string) string {
	if v, err := volumeFrom(volumeID); err == nil && v.Filesystem != nil && *v.Filesystem == "msdos" {
		return "fsck_msdos"
	}
	return "fsck_exfat"
}

func (p darwin) Diagnose(volumeID string) (FsckReport, error) { return p.fsck(volumeID, false) }

func (p darwin) Repair(volumeID string) (FsckReport, error) {
	Run(time.Minute, "diskutil", []string{"unmount", "force", volumeID})
	return p.fsck(volumeID, true)
}

// fsck runs the check on a descriptor this process opened — through authopen, for a card — and
// hands it over as /dev/fd/3, since fsck opening the device itself is refused by the privacy
// protection that authopen satisfies. -n opens nothing for writing and answers no to every
// repair; -y repairs, on a read-write descriptor.
func (p darwin) fsck(volumeID string, repair bool) (FsckReport, error) {
	device, err := blockdev.OpenForChild(p.VolumeRawPath(volumeID), repair)
	if err != nil {
		return FsckReport{}, err
	}
	defer device.Close()
	flag := "-n"
	if repair {
		flag = "-y"
	}
	out, err := RunAnyExit(2*time.Hour, []*os.File{device}, fsckTool(volumeID), []string{flag, "/dev/fd/3"})
	if err != nil {
		return FsckReport{}, err
	}
	// Not a finding about the filesystem: the check never saw it.
	if strings.Contains(out.Stdout+out.Stderr, "Operation not permitted") {
		return FsckReport{}, blockdev.ErrPermission
	}
	return fsckReport(out, repair), nil
}

func fsckReport(out Output, modified bool) FsckReport {
	code := out.Code
	return FsckReport{Clean: code == 0, Modified: modified, Output: strings.TrimSpace(out.Stdout + out.Stderr), ExitCode: &code}
}

type cardReaders struct {
	SPCardReaderDataType []struct {
		Items []map[string]any `json:"_items"`
	}
}

func (darwin) Identity(device Device) Identity {
	if out, err := Run(20*time.Second, "system_profiler", []string{"SPCardReaderDataType", "-json"}); err == nil {
		var readers cardReaders
		if json.Unmarshal([]byte(out.Stdout), &readers) == nil {
			for _, reader := range readers.SPCardReaderDataType {
				for _, card := range reader.Items {
					if card["bsd_name"] != device.ID {
						continue
					}
					get := func(key string) string {
						value, _ := card["spcardreader_card_"+key].(string)
						return strings.TrimSpace(value)
					}
					identity := Identity{Source: "card", Product: get("productname"), Serial: get("serialnumber"),
						Manufactured: get("manufacturing_date"), Reader: "Built-in SD card reader"}
					if id, err := strconv.ParseInt(strings.TrimPrefix(get("manufacturer-id"), "0x"), 16, 32); err == nil {
						identity.Manufacturer = ManufacturerName(int(id))
					}
					return identity
				}
			}
		}
	}
	i, _ := info(device.ID)
	return Identity{Source: "reader", Reader: nonEmpty(i.MediaName, i.IORegistryEntryName)}
}

func (darwin) RawPath(device Device) string         { return "/dev/r" + device.ID }
func (darwin) VolumeRawPath(volumeID string) string { return "/dev/r" + volumeID }

func (darwin) Release(device Device) (func(), error) {
	// Forced: the operation has been confirmed, and Spotlight holding a file open is not a
	// reason to leave a half-written card. A disk with nothing mounted also exits 0.
	if _, err := Run(time.Minute, "diskutil", []string{"unmountDisk", "force", device.ID}); err != nil {
		return func() {}, err
	}
	return func() {}, nil
}

// Reread is not needed: Disk Arbitration re-reads a disk's partition table when its raw
// device is closed after writing.
func (darwin) Reread(Device) error { return nil }

func (darwin) Settle(device Device) (string, error) {
	var partition string
	err := Wait(15*time.Second, func() error {
		var list diskutilList
		if err := plist(&list, "list", "-plist", device.ID); err != nil {
			return err
		}
		if len(list.AllDisksAndPartitions) == 0 || len(list.AllDisksAndPartitions[0].Partitions) == 0 {
			return fmt.Errorf("no partition has appeared on %s", device.ID)
		}
		partition = list.AllDisksAndPartitions[0].Partitions[0].DeviceIdentifier
		return nil
	})
	if err != nil {
		return "", err
	}
	err = Wait(15*time.Second, func() error {
		v, err := volumeFrom(partition)
		if err != nil {
			return err
		}
		if v.MountPoint != nil {
			return nil
		}
		_, err = Run(time.Minute, "diskutil", []string{"mount", partition})
		return err
	})
	return partition, err
}

func (darwin) Elevate(executable string, args []string, reason string) (Command, error) {
	parts := []string{ShellQuote(executable)}
	for _, arg := range args {
		parts = append(parts, ShellQuote(arg))
	}
	script := fmt.Sprintf("do shell script %s with administrator privileges with prompt %s",
		appleScriptQuote(strings.Join(parts, " ")), appleScriptQuote("A3EM Card Helper needs administrator access to "+reason+"."))
	return Command{Name: "osascript", Args: []string{"-e", script}}, nil
}

func appleScriptQuote(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`
}

func canOpen(path string) bool {
	file, err := os.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return false
	}
	file.Close()
	return true
}
