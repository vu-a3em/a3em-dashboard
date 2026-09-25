import {
  DEFAULT_FIRMWARE_PROFILE,
  FIRMWARE_LEGACY,
  firmwareProfileById,
  type FirmwareProfile,
} from './firmware-profile.js';

/**
 * Reader for `_a3em.dev`, the device info file written at the card root on every boot
 * by firmware 2026.08.1 and newer.
 *
 * This is how the app identifies a device and picks the right firmware capability
 * profile without parsing a multi-megabyte log. It also answers, at connect time,
 * "which device was this card in, and how did it leave off?"
 *
 * Same `KEY = "value"` grammar as the configuration file. Absent on legacy cards, in which case
 * everything falls back to the conservative legacy profile.
 */

export const DEVICE_INFO_FILE_NAME = '_a3em.dev';

/**
 * Why the device last stopped, exactly as `reset_reason_name()` in the firmware spells it.
 *
 * These are the firmware's own strings rather than a vocabulary of our own. An earlier
 * set of friendlier names meant every real card coerced to UNKNOWN and reported "stopped
 * for an unrecorded reason", which was worse than useless — it hid a reason the device
 * had gone to the trouble of recording.
 */
export type DeactivationReason =
  | 'POWER-ON'
  | 'MAGNET-ON'
  | 'MAGNET-OFF'
  | 'PHASE-DONE'
  | 'CYCLE'
  | 'BATTERY-LOW'
  | 'RTC-STOPPED'
  | 'SD-FAILURE'
  | 'AUDIO-ERROR'
  | 'NO-CONFIG'
  | 'HARD-FAULT'
  | 'PERIPH-TIMEOUT'
  | 'UNKNOWN';

/** Plain-language explanation for each stop reason, for the review workspace. */
export const DEACTIVATION_REASON_LABELS: Record<DeactivationReason, string> = {
  'POWER-ON': 'Powered on from cold',
  'MAGNET-ON': 'Switched on with the magnet',
  'MAGNET-OFF': 'Switched off with the magnet',
  'PHASE-DONE': 'Recording phase reached its end time',
  CYCLE: 'Restarted itself to begin the next phase',
  'BATTERY-LOW': 'Battery fell below the cutoff',
  'RTC-STOPPED': 'Clock stopped ticking — the device reset itself',
  'SD-FAILURE': 'SD card could not be written to',
  'AUDIO-ERROR': 'The audio subsystem failed',
  'NO-CONFIG': 'No usable configuration file was found',
  'HARD-FAULT': 'The firmware crashed',
  'PERIPH-TIMEOUT': 'A component stopped responding',
  UNKNOWN: 'Stopped for an unrecorded reason',
};

/**
 * Stop reasons that mean the deployment ended earlier than planned.
 *
 * A magnet switch-off and a completed phase are how a deployment is *supposed* to end,
 * so neither belongs here. Everything else represents recordings that were not made.
 */
export const UNPLANNED_STOP_REASONS: ReadonlySet<DeactivationReason> = new Set<DeactivationReason>([
  'BATTERY-LOW',
  'RTC-STOPPED',
  'SD-FAILURE',
  'AUDIO-ERROR',
  'NO-CONFIG',
  'HARD-FAULT',
  'PERIPH-TIMEOUT',
]);

export interface DeviceInfo {
  firmwareVersion: string;
  hardwareRevision: string;
  buildDatetime: string;
  /** Hardware UID — stable device identity, independent of the user-assigned label. */
  deviceUid: string;
  activationNumber: number;
  /** Last timestamp the device recorded, as an ISO instant. Null if never set. */
  lastTimestamp: string | null;
  lastBatteryMv: number;
  lastDeactivationReason: DeactivationReason;
  /**
   * Whether the device came back up cleanly after that stop.
   *
   * The difference between "this unit crashed" and "this unit crashed and carried on",
   * which is the difference between a lost deployment and a blip.
   */
  recoveredFromLastStop: boolean | null;

  /**
   * Allocation unit (cluster size) of the card, in bytes. Null on firmware that predates the field.
   *
   * Worth recording because it is not recoverable from the card's contents and it governs both how much slack every
   * file carries and how many write transactions a clip costs. A card formatted on a computer is typically 4 kB
   * regardless of what the device would have chosen.
   */
  cardAllocationUnitBytes: number | null;
  /** Total usable size of the card in bytes, as the device measured it. Null on older firmware. */
  cardCapacityBytes: number | null;
  /** Free space at the moment the file was written. Null on older firmware. */
  cardFreeBytes: number | null;

  /** Resolved from `firmwareVersion`. */
  firmwareProfile: FirmwareProfile;
}

export function parseDeviceInfo(text: string): DeviceInfo | null {
  const values = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const quoted = line.slice(eq + 1).trim();
    if (!quoted.startsWith('"') || !quoted.endsWith('"') || quoted.length < 2) continue;
    values.set(key, quoted.slice(1, -1));
  }

  const firmwareVersion = values.get('FW_VERSION');
  const deviceUid = values.get('DEVICE_UID');
  // Without these two the file tells us nothing worth acting on.
  if (!firmwareVersion || !deviceUid) return null;

  const lastTimestampSeconds = Number(values.get('LAST_TIMESTAMP') ?? '0');

  return {
    firmwareVersion,
    hardwareRevision: values.get('HW_REVISION') ?? 'unknown',
    buildDatetime: values.get('BUILD_DATETIME') ?? '',
    deviceUid,
    activationNumber: Number(values.get('ACTIVATION_NUMBER') ?? '0'),
    lastTimestamp: lastTimestampSeconds > 0 ? new Date(lastTimestampSeconds * 1000).toISOString() : null,
    lastBatteryMv: Number(values.get('LAST_BATTERY_MV') ?? '0'),
    lastDeactivationReason: coerceReason(values.get('LAST_STOP_REASON')),
    recoveredFromLastStop: values.has('LAST_STOP_RECOVERED')
      ? values.get('LAST_STOP_RECOVERED') === 'True'
      : null,
    cardAllocationUnitBytes: positiveOrNull(values.get('CARD_ALLOCATION_UNIT_BYTES')),
    cardCapacityBytes: megabytesToBytes(values.get('CARD_CAPACITY_MB')),
    cardFreeBytes: megabytesToBytes(values.get('CARD_FREE_MB')),
    firmwareProfile: firmwareProfileById(firmwareVersion),
  };
}

/** The device writes 0 when it cannot determine a value, which means "unknown", not zero. */
function positiveOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function megabytesToBytes(value: string | undefined): number | null {
  const mb = positiveOrNull(value);
  return mb === null ? null : mb * 1024 * 1024;
}

function coerceReason(value: string | undefined): DeactivationReason {
  return value && value in DEACTIVATION_REASON_LABELS ? (value as DeactivationReason) : 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Which firmware to reason about
// ---------------------------------------------------------------------------

/**
 * The firmware that WROTE what is on this card.
 *
 * Used for interpreting the card's contents — whether a WAV chunk size is expected to
 * be four bytes over, how to read an IMU header, what shape the log takes.
 *
 * A missing device info file is positive evidence, not merely an absence: firmware from
 * 2026.08.1 writes `_a3em.dev` at every boot and at every directory rollover, so a card
 * carrying recordings but no such file cannot have come from it.
 */
/**
 * The firmware that wrote this card.
 *
 * The inference is ONE-WAY and the fallback is a guess, not a deduction:
 *
 *  - `_a3em.dev` present PROVES current firmware, because only current firmware writes it.
 *  - `_a3em.dev` absent proves nothing. It is missing from a legacy card, and equally from
 *    a partial copy, a card whose root was cleaned up, or one recovered file-by-file.
 *
 * Legacy is returned anyway because it is the FORGIVING answer for the one thing that
 * consumes this — `correctWavChunkSize`, which decides how a WAV's declared length is
 * read. Judged legacy, a current-firmware clip still reads `ok`; judged current, a legacy
 * clip reads `truncated`. So the unsound direction produces a false all-clear rather than
 * a false alarm, and a card of perfectly good recordings is never condemned.
 *
 * That is luck, not design. Before adding a second consumer, check that "legacy" is the
 * safe assumption for it too — and if it is not, take the undetermined case as null and
 * make the caller decide, the way `detectImuHeaderBytes` does.
 */
export function cardFirmwareProfile(deviceInfo: DeviceInfo | null): FirmwareProfile {
  return deviceInfo?.firmwareProfile ?? FIRMWARE_LEGACY;
}

/**
 * The firmware a configuration written now will RUN on.
 *
 * A different question from what wrote the card, and the two only coincide by accident.
 * An old card put into a current device runs current firmware; a blank card has no
 * history at all. Where the card reports a device version that is the answer, and
 * otherwise it is current firmware, because that is what every device now runs.
 */
export function targetFirmwareProfile(deviceInfo: DeviceInfo | null): FirmwareProfile {
  return deviceInfo?.firmwareProfile ?? DEFAULT_FIRMWARE_PROFILE;
}
