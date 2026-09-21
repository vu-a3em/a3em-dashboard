import { createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { CardGeometry, PartitionScheme } from '@a3em/config-schema';
import { run, toolExists } from '../exec.js';
import {
  PlatformCommandError,
  type FsckReport,
  type ImageProgress,
  type ImageReport,
  type Platform,
  type RawDevice,
  type RawVolume,
} from './types.js';

/**
 * macOS, via `diskutil`, `newfs_exfat`, and `fsck_exfat`.
 *
 * Everything here was exercised against file-backed disk images on Darwin 25.6 before it
 * was written. Three behaviours it encodes that the manual pages do not lead you to:
 *
 *  - **`newfs_exfat` needs `-R` to change an existing volume's cluster size.** Without it
 *    the tool preserves the current geometry, prints "Cluster size differs from command
 *    line argument; skipping reformat", and **exits 0**. A format built on the exit code
 *    reports success having done nothing, on precisely the cards worth reformatting.
 *    Hence `verifyGeometry` below: the result is read back, never assumed.
 *  - **`statfs` does not report the cluster size.** `stat -f %k` on a mounted exFAT
 *    volume returns macOS's 1 MiB optimal I/O size. `diskutil info -plist`'s
 *    `VolumeAllocationBlockSize` is correct and needs no elevation.
 *  - **An exFAT partition's MBR type code is shared with NTFS**, so `Content` reads
 *    `Windows_NTFS` on a perfectly good exFAT card. The filesystem must come from
 *    `FilesystemType` on the partition, never from the partition type.
 *
 * Elevation: `diskutil`'s own paths go through `diskarbitrationd`, which authorizes the
 * console user for removable media, so mount, unmount, eject, and partitioning need no
 * administrator rights. `newfs_exfat` and `fsck_exfat` open the device node directly, and
 * a physical card's node is `root:operator` — so those are expected to need elevation
 * even though they did not against a user-owned disk image. See `ELEVATION_UNRESOLVED`.
 */

/**
 * Whether the direct-device tools need administrator rights on a physical card.
 *
 * Unresolved: testing was done against `hdiutil`-attached images, whose device nodes the
 * attaching user owns, so `newfs_exfat` succeeded unelevated in a way that probably does
 * not generalise. Until someone runs this against a real card, the implementation tries
 * unelevated first and escalates only on a permission error — which is correct either
 * way and costs one failed call in the case where elevation turns out to be needed.
 */
export const ELEVATION_UNRESOLVED = true;

interface DiskutilList {
  AllDisksAndPartitions?: Array<{
    DeviceIdentifier: string;
    Content?: string;
    Size?: number;
    Partitions?: Array<{ DeviceIdentifier: string; Content?: string; Size?: number; VolumeName?: string; MountPoint?: string }>;
    APFSVolumes?: Array<{ DeviceIdentifier: string }>;
  }>;
}

interface DiskutilInfo {
  DeviceIdentifier?: string;
  DeviceNode?: string;
  Size?: number;
  TotalSize?: number;
  Removable?: boolean;
  RemovableMedia?: boolean;
  RemovableMediaOrExternalDevice?: boolean;
  Internal?: boolean;
  BusProtocol?: string;
  Content?: string;
  FilesystemType?: string;
  FilesystemName?: string;
  VolumeName?: string;
  MountPoint?: string;
  VolumeAllocationBlockSize?: number;
  DeviceBlockSize?: number;
  ParentWholeDisk?: string;
  WholeDisk?: boolean;
  VirtualOrPhysical?: string;
}

export class DarwinPlatform implements Platform {
  readonly id = 'darwin' as const;

  async listDevices(): Promise<RawDevice[]> {
    const { stdout } = await run('diskutil', ['list', '-plist']);
    const list = await parsePlist<DiskutilList>(stdout);
    const bootDisk = await bootWholeDisk();

    const devices: RawDevice[] = [];
    for (const disk of list.AllDisksAndPartitions ?? []) {
      let info: DiskutilInfo;
      try {
        info = await infoFor(disk.DeviceIdentifier);
      } catch {
        continue; // a disk that vanished between the list and the info is simply gone
      }

      const volumes: RawVolume[] = [];
      for (const partition of disk.Partitions ?? []) {
        try {
          volumes.push(await volumeFrom(partition.DeviceIdentifier));
        } catch {
          // A partition whose info cannot be read is itself a finding: report it as an
          // unmountable volume rather than dropping it, because an unreadable partition
          // is the exact shape of the card this tool exists to recover.
          volumes.push({
            id: partition.DeviceIdentifier,
            node: `/dev/${partition.DeviceIdentifier}`,
            label: partition.VolumeName ?? null,
            filesystem: null,
            sizeBytes: partition.Size ?? 0,
            mountPoint: null,
            allocationUnitBytes: null,
            mountable: false,
          });
        }
      }

      devices.push({
        id: disk.DeviceIdentifier,
        node: info.DeviceNode ?? `/dev/${disk.DeviceIdentifier}`,
        sizeBytes: disk.Size ?? info.Size ?? 0,
        removable: Boolean(info.Removable ?? info.RemovableMedia ?? info.RemovableMediaOrExternalDevice),
        internal: Boolean(info.Internal),
        bus: info.BusProtocol ?? 'unknown',
        isBootDevice: disk.DeviceIdentifier === bootDisk,
        virtual: info.VirtualOrPhysical === 'Virtual' || info.BusProtocol === 'Disk Image',
        partitionScheme: schemeFrom(disk.Content),
        volumes,
      });
    }
    return devices;
  }

  async inspect(volumeId: string): Promise<CardGeometry> {
    const volume = await volumeFrom(volumeId);
    const parent = await infoFor(volumeId);
    const wholeDisk = parent.ParentWholeDisk ?? volumeId;
    const disk = await infoFor(wholeDisk);

    return {
      partitionScheme: schemeFrom(disk.Content),
      filesystem: volume.filesystem,
      bytesPerSector: parent.DeviceBlockSize ?? null,
      allocationUnitBytes: volume.allocationUnitBytes,
      mountable: volume.mountable,
      dirty: volume.filesystem === 'exfat' ? await isDirty(volumeId) : undefined,
    };
  }

  async findProbe(fileName: string): Promise<string[]> {
    const devices = await this.listDevices();
    const matches: string[] = [];
    for (const device of devices) {
      if (!device.removable || device.internal || device.isBootDevice) continue;
      for (const volume of device.volumes) {
        if (!volume.mountPoint) continue;
        try {
          await stat(`${volume.mountPoint}/${fileName}`);
          matches.push(volume.id);
        } catch {
          // Absent is the normal answer for every volume but one.
        }
      }
    }
    return matches;
  }

  async mount(volumeId: string): Promise<void> {
    await run('diskutil', ['mount', volumeId]);
  }

  async unmount(volumeId: string): Promise<void> {
    await run('diskutil', ['unmount', volumeId]);
  }

  async eject(deviceId: string): Promise<void> {
    await run('diskutil', ['eject', deviceId]);
  }

  async diagnose(volumeId: string): Promise<FsckReport> {
    // -n opens the device read-only and answers "no" to every repair prompt. The raw
    // character device is what fsck_exfat wants; it converts a block node itself, but
    // being explicit keeps the audit trail honest about what was touched.
    const result = await runMaybeElevated('fsck_exfat', ['-n', `/dev/r${volumeId}`], {
      okExitCodes: [0, 1, 8],
      reason: `check the filesystem on ${volumeId}`,
    });
    return {
      clean: result.exitCode === 0,
      modified: false,
      output: `${result.stdout}${result.stderr}`.trim(),
      exitCode: result.exitCode,
    };
  }

  async repair(volumeId: string): Promise<FsckReport> {
    // The volume must be unmounted for a repair to be meaningful; an unmountable card is
    // already there, which is why a failure to unmount is not itself an error.
    await this.unmount(volumeId).catch(() => undefined);
    const result = await runMaybeElevated('fsck_exfat', ['-y', `/dev/r${volumeId}`], {
      okExitCodes: [0, 1, 8],
      reason: `repair the filesystem on ${volumeId}`,
    });
    return {
      clean: result.exitCode === 0,
      modified: true,
      output: `${result.stdout}${result.stderr}`.trim(),
      exitCode: result.exitCode,
    };
  }

  async image(
    deviceId: string,
    destinationPath: string,
    onProgress: (progress: ImageProgress) => void,
  ): Promise<ImageReport> {
    const info = await infoFor(deviceId);
    const totalBytes = info.Size ?? info.TotalSize ?? 0;

    // ddrescue where it exists: it continues past unreadable sectors and keeps a map, so
    // a physically failing card yields everything still readable instead of stopping at
    // the first error. This is the same principle as scanCard recording unreadable
    // entries and carrying on rather than aborting the walk.
    if (await toolExists('ddrescue')) {
      return imageWithDdrescue(deviceId, destinationPath, totalBytes, onProgress);
    }
    return imageWithReadLoop(deviceId, destinationPath, totalBytes, onProgress);
  }

  async format(deviceId: string, allocationUnitBytes: number, label: string): Promise<CardGeometry> {
    // Two steps rather than `eraseDisk`, because `eraseDisk` gives no way to choose the
    // allocation unit and the allocation unit is the entire point. partitionDisk lays
    // down the MBR scheme the firmware requires and places the partition at 1 MiB on any
    // realistically sized card; newfs_exfat then sets the geometry we actually want.
    //
    // `%noformat%` in the volume-name slot tells partitionDisk to write the partition
    // table and stop, rather than running its own newfs first. Without it the card is
    // formatted twice — once at whatever cluster size macOS defaults to (128 kB on a
    // 128 GB card) and again at the size actually requested. Verified that the partition
    // type code and the 1 MiB offset are identical either way.
    await run('diskutil', ['partitionDisk', deviceId, 'MBR', 'ExFAT', '%noformat%', '100%'], {
      timeoutMs: 15 * 60 * 1000,
    });

    const volumeId = await firstPartitionOf(deviceId);
    await run('diskutil', ['unmount', volumeId]).catch(() => undefined);

    await runMaybeElevated(
      'newfs_exfat',
      ['-R', '-b', String(allocationUnitBytes), '-v', label, `/dev/${volumeId}`],
      { reason: `format ${deviceId} with a ${allocationUnitBytes}-byte allocation unit` },
    );

    await run('diskutil', ['mount', volumeId]).catch(() => undefined);
    return verifyGeometry(this, volumeId, allocationUnitBytes);
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Reads back what a format actually produced and refuses to call it a success otherwise.
 *
 * This exists because of the `-R` trap: `newfs_exfat` will exit 0 having declined to do
 * the work. An exit code is not evidence here; the geometry is.
 */
async function verifyGeometry(
  platform: Platform,
  volumeId: string,
  expectedAllocationUnitBytes: number,
): Promise<CardGeometry> {
  const geometry = await platform.inspect(volumeId);
  if (geometry.allocationUnitBytes !== expectedAllocationUnitBytes) {
    throw new PlatformCommandError(
      `The card reports a ${geometry.allocationUnitBytes}-byte allocation unit after formatting, ` +
        `not the ${expectedAllocationUnitBytes} requested. The card has not been formatted as asked.`,
      'newfs_exfat',
      0,
      '',
    );
  }
  if (geometry.filesystem !== 'exfat') {
    throw new PlatformCommandError(
      `The card reports filesystem "${geometry.filesystem}" after formatting, not exFAT.`,
      'newfs_exfat',
      0,
      '',
    );
  }
  return geometry;
}

// ---------------------------------------------------------------------------
// diskutil plumbing
// ---------------------------------------------------------------------------

/**
 * plist to JSON via `plutil`, which ships with macOS.
 *
 * Saves taking an XML parser dependency into a process whose job is to be small enough
 * that someone can read all of it before trusting it with a disk.
 */
async function parsePlist<T>(xml: string): Promise<T> {
  return JSON.parse(await plutilConvert(xml)) as T;
}

async function plutilConvert(xml: string): Promise<string> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('plutil', ['-convert', 'json', '-o', '-', '-']);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`plutil failed: ${err.trim()}`)),
    );
    child.stdin.end(xml);
  });
}

async function infoFor(identifier: string): Promise<DiskutilInfo> {
  const { stdout } = await run('diskutil', ['info', '-plist', identifier]);
  return JSON.parse(await plutilConvert(stdout)) as DiskutilInfo;
}

/**
 * Partition contents that are containers or metadata rather than a mountable filesystem.
 *
 * These have no `FilesystemType`, which would otherwise read as "damaged" — an APFS
 * container's physical store is a perfectly healthy partition that simply is not itself a
 * volume. Calling that a damaged card would send an operator to the recovery flow for a
 * disk that is fine.
 */
const NON_FILESYSTEM_CONTENTS = new Set([
  'Apple_APFS',
  'Apple_APFS_Container',
  'Apple_APFS_ISC',
  'Apple_APFS_Recovery',
  'Apple_Boot',
  'Apple_CoreStorage',
  'EFI',
  'Linux_LVM',
  'Microsoft Reserved',
]);

async function volumeFrom(volumeId: string): Promise<RawVolume> {
  const info = await infoFor(volumeId);
  const filesystem = info.FilesystemType?.toLowerCase() ?? null;
  const isContainer = info.Content ? NON_FILESYSTEM_CONTENTS.has(info.Content) : false;
  return {
    id: volumeId,
    node: info.DeviceNode ?? `/dev/${volumeId}`,
    label: info.VolumeName || null,
    filesystem,
    sizeBytes: info.Size ?? info.TotalSize ?? 0,
    mountPoint: info.MountPoint || null,
    allocationUnitBytes: info.VolumeAllocationBlockSize ?? null,
    // A volume macOS recognises but has not mounted is still mountable; one it cannot
    // identify at all is not. `FilesystemType` absent alongside a real partition is the
    // signature of the damaged card this tool exists to recover — but only when the
    // partition was supposed to hold a filesystem in the first place.
    mountable: filesystem !== null || isContainer,
  };
}

function schemeFrom(content: string | undefined): PartitionScheme {
  if (content === 'FDisk_partition_scheme') return 'mbr';
  if (content === 'GUID_partition_scheme') return 'gpt';
  if (content === 'Apple_partition_scheme') return 'unknown';
  if (!content) return 'none';
  return 'unknown';
}

async function firstPartitionOf(deviceId: string): Promise<string> {
  const { stdout } = await run('diskutil', ['list', '-plist', deviceId]);
  const list = JSON.parse(await plutilConvert(stdout)) as DiskutilList;
  const partition = list.AllDisksAndPartitions?.[0]?.Partitions?.[0]?.DeviceIdentifier;
  if (!partition) throw new PlatformCommandError(`No partition found on ${deviceId} after formatting.`, 'diskutil list', 0, stdout);
  return partition;
}

async function bootWholeDisk(): Promise<string | null> {
  try {
    const info = await infoFor('/');
    const parent = info.ParentWholeDisk;
    if (!parent) return null;
    // The boot volume sits inside an APFS container whose physical store is the real
    // disk, so one hop up is not always enough. Resolve until the answer stops changing.
    let current = parent;
    for (let hop = 0; hop < 4; hop++) {
      const next = await infoFor(current);
      const up = next.ParentWholeDisk;
      if (!up || up === current) break;
      current = up;
    }
    return current;
  } catch {
    return null;
  }
}

async function isDirty(volumeId: string): Promise<boolean> {
  try {
    // -q reports clean/dirty through the exit status without touching the volume.
    const result = await runMaybeElevated('fsck_exfat', ['-q', `/dev/r${volumeId}`], {
      okExitCodes: [0, 1, 8],
      reason: `check whether ${volumeId} was unmounted cleanly`,
    });
    return result.exitCode !== 0;
  } catch {
    return false; // not knowing is not the same as dirty
  }
}

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/**
 * Runs a tool, escalating to an administrator prompt only if the unelevated call was
 * refused for permissions.
 *
 * Try-then-escalate rather than always-elevate because the privilege question is not
 * settled (see `ELEVATION_UNRESOLVED`) and because an authorization dialog the operator
 * did not need is a cost worth avoiding on a tool used dozens of times in a batch. Where
 * elevation is needed, `osascript`'s `with administrator privileges` raises the standard
 * macOS dialog and needs no code signing — the proper `SMAppService` helper is hardening
 * to do once the requirement is actually known.
 */
async function runMaybeElevated(
  command: string,
  args: string[],
  options: { okExitCodes?: number[]; reason: string },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    return await run(command, args, { okExitCodes: options.okExitCodes });
  } catch (error) {
    if (!isPermissionFailure(error)) throw error;
    const script =
      `do shell script ${quoteForAppleScript(`${command} ${args.map(shellQuote).join(' ')}`)} ` +
      `with administrator privileges with prompt ${quoteForAppleScript(
        `A3EM card helper needs administrator access to ${options.reason}.`,
      )}`;
    const result = await run('osascript', ['-e', script], { okExitCodes: options.okExitCodes });
    return result;
  }
}

function isPermissionFailure(error: unknown): boolean {
  if (!(error instanceof PlatformCommandError)) return false;
  return /permission denied|not permitted|EACCES|EPERM/i.test(error.output || error.message);
}

/** Quotes for AppleScript's string literal syntax, which escapes with backslashes. */
function quoteForAppleScript(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Quotes for the shell `do shell script` runs.
 *
 * Reached only on the elevation path, and only with arguments this program built —
 * labels are restricted by `validateFormatRequest` and device identifiers come from
 * `diskutil` — but a single-quoted form costs nothing and removes the question.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Imaging
// ---------------------------------------------------------------------------

async function imageWithDdrescue(
  deviceId: string,
  destinationPath: string,
  totalBytes: number,
  onProgress: (progress: ImageProgress) => void,
): Promise<ImageReport> {
  const { spawn } = await import('node:child_process');
  const mapPath = `${destinationPath}.map`;

  return new Promise((resolve, reject) => {
    const child = spawn('ddrescue', ['-d', '-r3', `/dev/r${deviceId}`, destinationPath, mapPath]);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const rescued = /rescued:\s+([\d.]+)\s*(\w+)/.exec(output.slice(-400));
      if (rescued) {
        onProgress({
          bytesCopied: scaleUnit(Number(rescued[1]), rescued[2] ?? 'B'),
          totalBytes,
          badSectors: 0,
        });
      }
    });
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const errors = /errsize:\s+([\d.]+)\s*(\w+)/.exec(output);
      const badBytes = errors ? scaleUnit(Number(errors[1]), errors[2] ?? 'B') : 0;
      resolve({
        destinationPath,
        bytesCopied: totalBytes - badBytes,
        badSectors: Math.ceil(badBytes / 512),
        complete: code === 0 && badBytes === 0,
      });
    });
  });
}

function scaleUnit(value: number, unit: string): number {
  const factors: Record<string, number> = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
  return Math.round(value * (factors[unit] ?? 1));
}

/**
 * Imaging without `ddrescue`, reading block by block and zero-filling what will not read.
 *
 * Deliberately not `dd conv=noerror,sync` in a shell: doing it here means the bad-sector
 * count is a number this program knows rather than something parsed back out of a status
 * line, and progress is reported continuously instead of on a signal.
 */
async function imageWithReadLoop(
  deviceId: string,
  destinationPath: string,
  totalBytes: number,
  onProgress: (progress: ImageProgress) => void,
): Promise<ImageReport> {
  const CHUNK = 4 * 1024 * 1024;
  const SECTOR = 512;

  const source = await open(`/dev/r${deviceId}`, 'r');
  const sink = createWriteStream(destinationPath);
  const buffer = Buffer.allocUnsafe(CHUNK);
  let position = 0;
  let badSectors = 0;

  try {
    while (position < totalBytes) {
      const want = Math.min(CHUNK, totalBytes - position);
      let read = 0;
      try {
        ({ bytesRead: read } = await source.read(buffer, 0, want, position));
      } catch {
        // Re-read the failed span a sector at a time so one bad sector costs one sector,
        // not the whole 4 MB chunk. This is the difference between losing a clip and
        // losing a day.
        read = want;
        for (let offset = 0; offset < want; offset += SECTOR) {
          const length = Math.min(SECTOR, want - offset);
          try {
            await source.read(buffer, offset, length, position + offset);
          } catch {
            buffer.fill(0, offset, offset + length);
            badSectors++;
          }
        }
      }
      if (read === 0) break;
      if (!sink.write(Buffer.from(buffer.subarray(0, read)))) {
        await new Promise<void>((resolve) => {
          sink.once('drain', () => resolve());
        });
      }
      position += read;
      onProgress({ bytesCopied: position, totalBytes, badSectors });
    }
  } finally {
    await source.close();
    await new Promise<void>((resolve, reject) => {
      sink.end((error?: Error) => (error ? reject(error) : resolve()));
    });
  }

  return {
    destinationPath,
    bytesCopied: position,
    badSectors,
    complete: badSectors === 0 && position === totalBytes,
  };
}
