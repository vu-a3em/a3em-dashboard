import { SD_CARD_ALLOCATION_UNIT_BYTES } from './firmware-constants.js';
import { ALLOCATION_UNIT_CHOICES_BYTES, formatAllocationUnit } from './allocation-unit.js';

/**
 * What the firmware requires of a card's filesystem, and how to judge a real one.
 *
 * Separate from `allocation-unit.ts`, which answers "what cluster size should this
 * deployment use" — a tuning question with a spectrum of defensible answers. This module
 * answers "will the device read this card at all", which is a contract with exactly one
 * correct side, read out of the firmware's FatFs build configuration.
 *
 * It lives here rather than in the helper because both need it: the helper to refuse or
 * warn, and the app to explain. Nothing here performs I/O, so all of it is testable
 * without a card.
 */

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * Partition scheme the firmware can find a volume inside.
 *
 * `ffconf.h` sets `FF_LBA64 = 0`, which compiles out the whole GPT branch of
 * `find_volume()` (`ff.c:3347`). Without it, FatFs reads a GPT disk's protective MBR,
 * follows its first entry to the GPT header, finds no volume boot record there, and
 * reports `FR_NO_FILESYSTEM` — see `REQUIRED_PARTITION_SCHEME` users below for why that
 * particular failure is so costly.
 */
export const REQUIRED_PARTITION_SCHEME = 'mbr';

/** `f_mkfs` is called with `FM_EXFAT` (`storage.c:777`) and nothing else is mounted. */
export const REQUIRED_FILESYSTEM = 'exfat';

/**
 * Logical sector size, fixed at build time.
 *
 * `FF_MIN_SS` and `FF_MAX_SS` are both 512 (`ffconf.h:196`). When they are equal FatFs
 * skips the `GET_SECTOR_SIZE` ioctl entirely and assumes the constant, so a 4Kn device
 * is not detected and misread — it is simply wrong about every address.
 */
export const REQUIRED_BYTES_PER_SECTOR = 512;

/**
 * The unit the device formats with when it formats a card itself.
 *
 * Re-exported from the firmware constants so callers reasoning about card format have
 * one import rather than two.
 */
export const DEVICE_FORMAT_ALLOCATION_UNIT_BYTES = SD_CARD_ALLOCATION_UNIT_BYTES;

// ---------------------------------------------------------------------------
// What we are judging
// ---------------------------------------------------------------------------

export type PartitionScheme = 'mbr' | 'gpt' | 'none' | 'unknown';

/** A card's filesystem geometry, as any platform's tooling reports it. */
export interface CardGeometry {
  partitionScheme: PartitionScheme;
  /** Lower-case filesystem identifier, or null when nothing is recognised. */
  filesystem: string | null;
  bytesPerSector: number | null;
  allocationUnitBytes: number | null;
  /** False when the volume exists but the OS could not mount it. */
  mountable: boolean;
  /** True when the filesystem is flagged dirty — unmounted uncleanly. */
  dirty?: boolean;
}

export type CompatibilitySeverity =
  /** The device cannot use this card, and using it anyway destroys data. */
  | 'critical'
  /** The device works, but something is wrong enough to say so. */
  | 'warning'
  /** Tuning, not correctness. */
  | 'advisory';

export interface CompatibilityIssue {
  code:
    | 'gpt-will-be-erased'
    | 'no-filesystem'
    | 'not-exfat'
    | 'wrong-sector-size'
    | 'unmountable'
    | 'dirty'
    | 'allocation-unit';
  severity: CompatibilitySeverity;
  /** One sentence, addressed to the operator. */
  message: string;
  /** What to do about it, where there is something to do. */
  remedy?: string;
}

export interface CompatibilityReport {
  /** True when the device will read this card and nothing is destroyed by trying. */
  usable: boolean;
  /** True when inserting the card into a device destroys what is on it. */
  destructiveOnInsert: boolean;
  issues: CompatibilityIssue[];
}

/**
 * Judges a card against the firmware contract.
 *
 * The ordering matters: `destructiveOnInsert` is checked and reported first because it is
 * the only finding where the correct next action is "do not put this card in a device",
 * and it is invisible to every other tool the operator has. Finder shows a healthy card.
 *
 * `recommendedAllocationUnitBytes` is optional because the allocation unit is a
 * deployment-specific tuning question — when no deployment is in hand there is nothing to
 * compare against and the advisory is simply omitted.
 */
export function judgeCardFormat(
  geometry: CardGeometry,
  recommendedAllocationUnitBytes?: number | null,
): CompatibilityReport {
  const issues: CompatibilityIssue[] = [];
  let destructiveOnInsert = false;

  if (geometry.partitionScheme === 'gpt') {
    destructiveOnInsert = true;
    issues.push({
      code: 'gpt-will-be-erased',
      severity: 'critical',
      message:
        'This card uses a GUID partition map, which the firmware cannot read. Inserting it ' +
        'into a device will not fail — the device will reformat the card and erase everything on it.',
      remedy: 'Reformat with an MBR partition map before using this card, or copy its contents off first.',
    });
  } else if (geometry.partitionScheme === 'none') {
    // Not destructive in the sense above: there is nothing here to destroy. The device
    // will format it and get on with the deployment, which is usually what was wanted.
    issues.push({
      code: 'no-filesystem',
      severity: 'warning',
      message: 'This card has no partition map. A device will format it automatically on first use.',
      remedy: `Formatting it here instead lets you choose the allocation unit; the device always uses ${formatAllocationUnit(
        DEVICE_FORMAT_ALLOCATION_UNIT_BYTES,
      )}.`,
    });
  }

  if (geometry.filesystem !== null && geometry.filesystem !== REQUIRED_FILESYSTEM) {
    destructiveOnInsert = true;
    issues.push({
      code: 'not-exfat',
      severity: 'critical',
      message:
        `This card is formatted ${geometry.filesystem.toUpperCase()}, not exFAT. The firmware reads only ` +
        'exFAT and will reformat the card, erasing everything on it.',
      remedy: 'Reformat as exFAT, or copy its contents off first.',
    });
  }

  if (geometry.bytesPerSector !== null && geometry.bytesPerSector !== REQUIRED_BYTES_PER_SECTOR) {
    issues.push({
      code: 'wrong-sector-size',
      severity: 'critical',
      message:
        `This card reports ${geometry.bytesPerSector}-byte sectors. The firmware is built for ` +
        `${REQUIRED_BYTES_PER_SECTOR}-byte sectors only and will misread it.`,
      remedy: 'Use a different card. This is a property of the media and cannot be reformatted away.',
    });
  }

  if (!geometry.mountable && geometry.partitionScheme !== 'none') {
    issues.push({
      code: 'unmountable',
      severity: 'critical',
      message: 'This card has a partition but its filesystem could not be mounted, which means it is damaged.',
      remedy: 'Image the card, then attempt a filesystem repair. Do not put it back in a device — it will be reformatted.',
    });
    destructiveOnInsert = true;
  } else if (geometry.dirty) {
    issues.push({
      code: 'dirty',
      severity: 'warning',
      message: 'This card was not unmounted cleanly. Its filesystem may have inconsistencies.',
      remedy: 'Run a check before relying on it.',
    });
  }

  if (
    recommendedAllocationUnitBytes != null &&
    geometry.allocationUnitBytes != null &&
    geometry.mountable
  ) {
    const actual = geometry.allocationUnitBytes;
    const wanted = recommendedAllocationUnitBytes;
    // Same one-doubling tolerance `allocation-unit.ts` applies: reformatting erases the
    // card, so the advice has to be worth that.
    if (actual < wanted / 2 || actual > wanted * 2) {
      issues.push({
        code: 'allocation-unit',
        severity: 'advisory',
        message: `This card's allocation unit is ${formatAllocationUnit(
          actual,
        )}; this deployment wants ${formatAllocationUnit(wanted)}.`,
        remedy: 'Reformatting is optional and erases the card.',
      });
    }
  }

  return {
    usable: !issues.some((issue) => issue.severity === 'critical'),
    destructiveOnInsert,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface FormatRequest {
  /** Whole-disk identifier, platform-shaped: `disk4`, `\\.\PHYSICALDRIVE2`, `/dev/sdb`. */
  device: string;
  allocationUnitBytes: number;
  /** Volume label. exFAT permits 11 UTF-16 units; longer is rejected rather than truncated. */
  label: string;
}

export const VOLUME_LABEL_MAX_LEN = 11;

/**
 * Rejects a format request that could not produce a working card.
 *
 * Checked here, before any platform code runs, so every OS refuses identically and the
 * refusals are testable without a card.
 */
export function validateFormatRequest(request: FormatRequest): string[] {
  const errors: string[] = [];

  if (!ALLOCATION_UNIT_CHOICES_BYTES.includes(request.allocationUnitBytes as never)) {
    errors.push(
      `Allocation unit must be one of ${ALLOCATION_UNIT_CHOICES_BYTES.map(formatAllocationUnit).join(', ')}.`,
    );
  }

  const label = request.label.trim();
  if (!label) {
    errors.push('A volume label is required.');
  } else if (label.length > VOLUME_LABEL_MAX_LEN) {
    errors.push(`Volume label must be ${VOLUME_LABEL_MAX_LEN} characters or fewer.`);
  } else if (!/^[A-Za-z0-9 _-]+$/.test(label)) {
    // The label becomes a filesystem name on three operating systems and is echoed into
    // shell arguments on two of them. Restricting it is cheaper than escaping it.
    errors.push('Volume label may contain only letters, digits, spaces, hyphens, and underscores.');
  }

  return errors;
}
