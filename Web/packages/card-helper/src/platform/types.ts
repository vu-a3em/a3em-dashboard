import type { CardGeometry, PartitionScheme } from '@a3em/config-schema';

/**
 * The contract every operating system implements.
 *
 * This is the whole porting surface. `darwin.ts` implements it against `diskutil`,
 * `newfs_exfat`, and `fsck_exfat`; `win32.ts` and `linux.ts` are stubs that declare the
 * commands they will use and throw until someone runs them on a real machine. Everything
 * above this interface — refusals, challenges, the firmware verdict, the message loop —
 * is platform-independent and already tested, so filling a stub in is a matter of
 * producing these shapes and nothing more.
 *
 * Implementations must not decide policy. They enumerate, read, and act; whether an
 * action is *permitted* is settled in `safety.ts` before they are called. An
 * implementation that refuses on its own would make the refusals untestable on the other
 * two platforms.
 */
export interface Platform {
  readonly id: 'darwin' | 'win32' | 'linux';

  /** Every block device the OS will admit to, filtered to removable media by the caller. */
  listDevices(): Promise<RawDevice[]>;

  /** Geometry of one volume, for the firmware verdict. */
  inspect(volumeId: string): Promise<CardGeometry>;

  /**
   * Volume identifiers whose root holds a file of this name.
   *
   * Searches mounted removable volumes only, and stats the one name rather than listing
   * directories — a full card holds a quarter of a million files and must cost one
   * syscall, not a walk.
   */
  findProbe(fileName: string): Promise<string[]>;

  mount(volumeId: string): Promise<void>;
  unmount(volumeId: string): Promise<void>;
  /** Unmount every volume and power the device down for physical removal. */
  eject(deviceId: string): Promise<void>;

  /** Read-only filesystem check. Must not write to the card under any circumstances. */
  diagnose(volumeId: string): Promise<FsckReport>;

  /** Filesystem check with repair. Writes to the card. */
  repair(volumeId: string): Promise<FsckReport>;

  /**
   * Sector-level copy of a whole device to a file.
   *
   * Must continue past unreadable sectors rather than stopping — a failing card is
   * precisely when this runs, and stopping at the first bad sector abandons everything
   * after it.
   */
  image(deviceId: string, destinationPath: string, onProgress: (progress: ImageProgress) => void): Promise<ImageReport>;

  /**
   * Partition as MBR and lay down one exFAT volume at the given allocation unit.
   *
   * Must verify by re-reading the geometry and must fail if what landed is not what was
   * asked for. On macOS `newfs_exfat` exits 0 while doing nothing when `-R` is omitted;
   * trusting an exit code here is how a format silently does not happen.
   */
  format(deviceId: string, allocationUnitBytes: number, label: string): Promise<CardGeometry>;
}

/** A whole disk as the OS describes it, before any policy is applied. */
export interface RawDevice {
  /** Platform-shaped whole-disk identifier: `disk4`, `2` (Windows disk number), `sdb`. */
  id: string;
  /** Path for display and for passing to tools. */
  node: string;
  sizeBytes: number;
  removable: boolean;
  internal: boolean;
  /** `USB`, `Secure Digital`, `Disk Image`, … — free text, for display and for refusals. */
  bus: string;
  /** True when the OS considers this the running system's boot device. */
  isBootDevice: boolean;
  /**
   * True for disk images, loopback devices, and anything else not backed by real media.
   *
   * Reported rather than hidden because the difference is invisible otherwise: an
   * attached disk image is removable, non-internal, and plausibly card-sized, so it is
   * indistinguishable from a card on every other field. A developer machine accumulates
   * dozens of them — a laptop with Xcode installed lists a simulator image per runtime —
   * and every one of them would otherwise appear as a card the operator could format.
   */
  virtual: boolean;
  partitionScheme: PartitionScheme;
  volumes: RawVolume[];
}

export interface RawVolume {
  id: string;
  node: string;
  label: string | null;
  /** Lower-case, `exfat` | `ntfs` | `msdos` | … Null when unrecognised. */
  filesystem: string | null;
  sizeBytes: number;
  mountPoint: string | null;
  allocationUnitBytes: number | null;
  mountable: boolean;
}

export interface FsckReport {
  /** True when the filesystem is structurally sound. */
  clean: boolean;
  /** True when this run modified the card. */
  modified: boolean;
  /** Tool output, trimmed. Kept because a repair's detail is the audit trail. */
  output: string;
  /** Exit status, for the cases where the tool says more in the code than in the text. */
  exitCode: number | null;
}

export interface ImageProgress {
  bytesCopied: number;
  totalBytes: number;
  /** Sectors that could not be read and were zero-filled. */
  badSectors: number;
}

export interface ImageReport {
  destinationPath: string;
  bytesCopied: number;
  badSectors: number;
  /** True when every sector was read without error. */
  complete: boolean;
}

/**
 * Thrown by a platform method that has not been implemented yet.
 *
 * Carries the command the implementation is expected to run, so the gap is
 * self-documenting: the error a caller sees on Windows names the PowerShell that needs
 * writing, rather than saying only that something is missing.
 */
export class NotImplementedOnPlatform extends Error {
  constructor(
    readonly platform: string,
    readonly operation: string,
    readonly plannedCommand: string,
  ) {
    super(
      `${operation} is not implemented on ${platform} yet. Planned implementation: ${plannedCommand}`,
    );
    this.name = 'NotImplementedOnPlatform';
  }
}

/** A platform tool failed. Distinct from a refusal, which never reaches a platform. */
export class PlatformCommandError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly output: string,
  ) {
    super(message);
    this.name = 'PlatformCommandError';
  }
}
