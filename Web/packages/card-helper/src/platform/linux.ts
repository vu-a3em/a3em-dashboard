import type { CardGeometry } from '@a3em/config-schema';
import {
  NotImplementedOnPlatform,
  type FsckReport,
  type ImageProgress,
  type ImageReport,
  type Platform,
  type RawDevice,
} from './types.js';

/**
 * Linux. **Not implemented — every method throws.**
 *
 * As with `win32.ts`, this is a specification rather than a placeholder: each method
 * names the command it is expected to run, and says so in the error. See that file's
 * header for the two traps worth carrying over from the macOS implementation — verify
 * the result rather than the exit code, and do not read a cluster size out of an API
 * that reports an I/O size.
 *
 * ## Elevation, which is different here
 *
 * Linux splits more cleanly than the other two:
 *
 *  - **`udisksctl` needs no root.** Mount, unmount, and power-off go through polkit,
 *    which prompts through the desktop's own agent. Prefer it for everything it covers.
 *  - **Formatting does need root.** udisks2's `Format` method does not expose a cluster
 *    size, which is the entire point of this feature, so `mkfs.exfat -c` under `pkexec`
 *    is the path — not udisks. This is the one place the udisks-first rule breaks.
 *
 * ## Dependencies that may be absent
 *
 * Unlike macOS and Windows, the tools are not guaranteed present. `mkfs.exfat` and
 * `fsck.exfat` come from `exfatprogs`, which is not installed by default on several
 * distributions, and `ddrescue` is almost never present. `toolExists` in `exec.ts` is
 * there for this: report a missing tool as a missing capability with its package name,
 * rather than failing at the moment someone tries to format a card.
 *
 * Note there are two competing exFAT userlands. `exfatprogs` provides `mkfs.exfat -c
 * <size>`; the older `exfat-utils` provides `mkexfatfs -s <sectors-per-cluster>`, which
 * takes sectors rather than bytes. Detect which is installed rather than assuming — the
 * argument means a different thing to each, and getting it wrong produces a card with a
 * 512-byte cluster size that will look like it worked.
 *
 * ## Identifier shape
 *
 * `RawDevice.id` should be the kernel name (`"sdb"`), `node` `/dev/sdb`, and
 * `RawVolume.id` the partition name (`"sdb1"`). `lsblk -J -O` gives all of it in one
 * call, including `rm` (removable), `hotplug`, `tran` (transport), and `pttype`.
 */

const PLATFORM = 'linux';

export class LinuxPlatform implements Platform {
  readonly id = 'linux' as const;

  listDevices(): Promise<RawDevice[]> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'listDevices',
      'lsblk -J -O -b — rm/hotplug to removable, tran to bus, pttype ("dos" = MBR, "gpt" = GPT) ' +
        'to partitionScheme, fstype to filesystem, mountpoint to mountPoint. ' +
        'isBootDevice: the disk holding the mountpoint "/"',
    );
  }

  inspect(_volumeId: string): Promise<CardGeometry> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'inspect',
      'lsblk -J -O -b for scheme and fstype; `tune.exfat` or `dump.exfat` for the cluster size, ' +
        'or read BytesPerSectorShift/SectorsPerClusterShift at offsets 108/109 of the exFAT boot sector; ' +
        'blockdev --getss for the logical sector size',
    );
  }

  findProbe(_fileName: string): Promise<string[]> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'findProbe',
      'stat(mountpoint + "/" + fileName) for each mounted removable volume — one syscall per volume, no walk',
    );
  }

  mount(_volumeId: string): Promise<void> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'mount',
      'udisksctl mount -b /dev/<volume> — polkit, no root',
    );
  }

  unmount(_volumeId: string): Promise<void> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'unmount',
      'udisksctl unmount -b /dev/<volume> — polkit, no root',
    );
  }

  eject(_deviceId: string): Promise<void> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'eject',
      'udisksctl unmount for each volume, then udisksctl power-off -b /dev/<disk>',
    );
  }

  diagnose(_volumeId: string): Promise<FsckReport> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'diagnose',
      'fsck.exfat -n /dev/<volume> (exfatprogs) — read-only, answers no to every prompt. ' +
        'Must not write: this is the pre-image diagnosis step',
    );
  }

  repair(_volumeId: string): Promise<FsckReport> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'repair',
      'pkexec fsck.exfat -r /dev/<volume>. Only after imaging — see Part 5 of NATIVE-HELPER-PLAN.md',
    );
  }

  image(
    _deviceId: string,
    _destinationPath: string,
    _onProgress: (progress: ImageProgress) => void,
  ): Promise<ImageReport> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'image',
      'ddrescue -d -r3 /dev/<disk> <dest> <dest>.map where installed (gddrescue package); ' +
        'otherwise the sector-stepping read loop from darwin.ts, which needs no extra package',
    );
  }

  format(_deviceId: string, _allocationUnitBytes: number, _label: string): Promise<CardGeometry> {
    throw new NotImplementedOnPlatform(
      PLATFORM,
      'format',
      'pkexec sfdisk --label dos /dev/<disk> with a single type-7 partition starting at 2048 sectors; ' +
        'then pkexec mkfs.exfat -c <bytes> -L <label> /dev/<disk>1 (exfatprogs — NOT mkexfatfs, ' +
        'whose -s takes sectors). Then RE-READ the cluster size and fail if it differs',
    );
  }
}
