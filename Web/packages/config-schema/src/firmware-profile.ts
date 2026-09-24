/**
 * Firmware capability profiles.
 *
 * CONFIGURATION always targets current firmware. Every device from here on runs it, so
 * there is no reason to write a card for the older behavior, and defaulting to it only
 * produced warnings about situations that cannot arise.
 *
 * The legacy profile remains because CARDS from older firmware still have to be READ.
 * Those differences are detected from the data itself rather than from a profile — the
 * IMU header size follows from the file length, and the log format from the shape of
 * its lines — so the profile mainly documents what changed and labels a device whose
 * card reports an older version.
 *
 * There are exactly TWO profiles, and no plan for a third. A card either comes from the
 * firmware in this repository or it predates it, and the two are told apart by evidence
 * on the card rather than by a version string: current firmware writes a device file at
 * the root on every boot, so its absence beside real recordings dates the card. Pinning
 * profiles to release numbers meant every new build looked unrecognised and fell back to
 * a stale entry, which is worse than having no version check at all.
 */

export interface FirmwareCapabilities {
  /**
   * FINDING 1. `AUDIO_MAX_CLIPS_NUMBER = 0` no longer silently stops the device
   * recording. On legacy firmware it meant "never arm the trigger"; current firmware
   * rewrites it to a single clip per window and reports the file as corrected. Neither
   * is what zero implies, so the editor refuses to write it either way — this flag now
   * only selects which explanation the user is given. It has never meant "unlimited" on
   * any shipped build, which is what the old name for this flag claimed.
   *
   * Before: `if (num_clips_stored < max_clips)` never passes when max_clips is 0.
   */
  zeroClipCapIsRewritten: boolean;

  /**
   * FINDING 2. `parse_line()` bounds-checks the phase and schedule arrays instead
   * of writing past the end of them.
   *
   * Either way the app must respect the 6-phase / 12-window ceilings; this flag
   * only changes whether exceeding them corrupts memory or is merely ignored.
   */
  boundsCheckedArrays: boolean;

  /**
   * FINDING 9. The WAV `data` chunk size is written correctly rather than four
   * bytes over. Readers must stay tolerant regardless — cards written by older
   * firmware are not going away.
   */
  correctWavChunkSize: boolean;

  /**
   * FINDING 5. `IMU_TRIGGER_THRESHOLD` actually reaches the sensor, as a fraction of
   * the accelerometer full scale.
   */
  adjustableMotionThreshold: boolean;

  /**
   * Writes `_a3em.dev` at the card root on every boot, so the app can identify the
   * device and resolve its firmware profile without parsing the log.
   */
  writesDeviceInfoFile: boolean;

  /**
   * One log file per 4-hour directory rather than a single deployment-long file, and
   * every log line carries a `[epoch]` prefix.
   */
  perDirectoryTimestampedLogs: boolean;

  /**
   * The IMU header is a fixed 8 bytes (two uint32s). Older firmware wrote
   * `sizeof(time_t)` for the timestamp, which was 8 bytes on the production
   * toolchain and made the header 12. Readers must handle both — see
   * `imu-file.ts`, which detects it from the file size.
   */
  eightByteImuHeader: boolean;
}

export interface FirmwareProfile {
  id: string;
  label: string;
  /** Shown next to the profile picker so the choice is explicable. */
  notes: string;
  capabilities: FirmwareCapabilities;
}

/** Every unit built before the 2026-08 fixes. Read-side only; nothing targets it. */
export const FIRMWARE_LEGACY: FirmwareProfile = {
  id: 'legacy',
  label: 'Original firmware',
  notes:
    'Retained for reading older cards. A clip cap of zero disabled sound-triggered ' +
    'recording entirely on these units, exceeding the phase or recording-period limits ' +
    'corrupted device memory, and the motion threshold had no effect. Cards carry a ' +
    'single deployment-long log and a 12-byte IMU header.',
  capabilities: {
    zeroClipCapIsRewritten: false,
    boundsCheckedArrays: false,
    correctWavChunkSize: false,
    adjustableMotionThreshold: false,
    writesDeviceInfoFile: false,
    perDirectoryTimestampedLogs: false,
    eightByteImuHeader: false,
  },
};

/**
 * The firmware in this repository.
 *
 * Every device runs this, and every card that reports a version at all came from it.
 * The version string is still recorded and displayed — it is how a card is traced back
 * to the build that wrote it — but it does not select behavior.
 */
export const FIRMWARE_CURRENT: FirmwareProfile = {
  id: 'current',
  label: 'Current firmware',
  notes:
    'A clip cap of zero is corrected to one on device. Array limits are enforced on device. WAV ' +
    'headers are correct, the motion threshold reaches the sensor, and the card carries ' +
    'a device info file plus timestamped per-directory logs.',
  capabilities: {
    zeroClipCapIsRewritten: true,
    boundsCheckedArrays: true,
    correctWavChunkSize: true,
    adjustableMotionThreshold: true,
    writesDeviceInfoFile: true,
    perDirectoryTimestampedLogs: true,
    eightByteImuHeader: true,
  },
};

export const FIRMWARE_PROFILES = [FIRMWARE_LEGACY, FIRMWARE_CURRENT] as const;

/**
 * What a newly written configuration targets.
 *
 * Always the current firmware. Reading an old card does not go through here: those
 * formats are detected from the data itself.
 */
export const DEFAULT_FIRMWARE_PROFILE = FIRMWARE_CURRENT;

/**
 * Resolves a profile from what the card reports.
 *
 * A reported version means the card came from firmware that writes one, which is the
 * current firmware — whatever release it happens to be. Only the absence of a version
 * selects the legacy profile, and that is decided by `cardFirmwareProfile()` from the
 * device file rather than here.
 */
export function firmwareProfileById(id: string | undefined): FirmwareProfile {
  return id && id.trim() ? FIRMWARE_CURRENT : DEFAULT_FIRMWARE_PROFILE;
}
