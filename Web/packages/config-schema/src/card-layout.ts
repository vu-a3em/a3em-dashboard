import { NUM_HOURS_PER_AUDIO_DIRECTORY } from './firmware-constants.js';
import { SELF_TEST_CLIP_FILE_NAME } from './self-test.js';

/**
 * Understanding what is on a card, across both naming schemes.
 *
 * From firmware 2026.08.1 files and directories are zero-padded UTC epochs:
 *
 *   SAM_elephant_10/Activation_0001/1770336000/1770350400/1770368424.wav
 *
 * Before that they were rendered dates:
 *
 *   SAM_elephant_10/Activation_0001/2026-02-06/08/2026-02-06 09-00-24.wav
 *
 * Both encode the DEVICE's clock, which is set from the configured deployment start at
 * magnet activation. Unless activation happened exactly on schedule, every one of these
 * is offset from real time — that is the whole reason the epoch scheme exists, since a
 * rendered date looks authoritative while being wrong.
 *
 * Nothing here renames anything. The clock offset is applied when times are displayed,
 * and renaming is a separate, explicit action.
 */

export type CardFileKind =
  | 'audio'
  | 'imu'
  | 'log'
  | 'config'
  | 'device-info'
  | 'self-test'
  /** The microphone self-test capture at the card root — a diagnostic, not a recording. */
  | 'self-test-clip'
  | 'other';

export interface CardFile {
  /** Path relative to the card root, using forward slashes. */
  path: string;
  name: string;
  kind: CardFileKind;
  sizeBytes: number;
  /** Device-clock instant parsed from the name, or null if the name carries none. */
  deviceTime: string | null;
  /** Activation folder this belongs to, if any. */
  activationNumber: number | null;
}

export interface CardLayout {
  deviceLabel: string | null;
  /** True when names are epochs rather than rendered dates. */
  epochNaming: boolean;
  activations: number[];
  files: CardFile[];
  audioCount: number;
  imuCount: number;
  totalAudioBytes: number;
  /** Earliest and latest DEVICE-clock instants seen, before any correction. */
  firstDeviceTime: string | null;
  lastDeviceTime: string | null;
}

const EPOCH_NAME = /^(\d{10,})$/;
const RENDERED_NAME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})$/;
const ACTIVATION_DIR = /^Activation_(\d+)$/;

/**
 * The activation a path belongs to, or null if it sits outside one.
 *
 * The only reliable way to separate activations. A device configured to set its clock at
 * activation starts EVERY run at the same configured time, so successive activations
 * produce overlapping — often identical — timestamps. Times cannot tell them apart; the
 * directory the device wrote them into can.
 */
export function activationFromPath(path: string): number | null {
  for (const segment of path.split('/')) {
    const match = ACTIVATION_DIR.exec(segment);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Device-clock instant encoded in a file's base name, under either scheme. */
export function parseFileTimestamp(baseName: string): string | null {
  const epoch = EPOCH_NAME.exec(baseName);
  if (epoch) {
    const seconds = Number(epoch[1]);
    // Reject values that cannot be a plausible deployment time, so a zero-padded
    // sequence number is never mistaken for an epoch.
    if (seconds < 946_684_800 || seconds > 4_102_444_800) return null;
    return new Date(seconds * 1000).toISOString();
  }
  const rendered = RENDERED_NAME.exec(baseName);
  if (rendered) {
    const [, y, mo, d, h, mi, s] = rendered;
    return new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    ).toISOString();
  }
  return null;
}

export function classifyFile(name: string): CardFileKind {
  const lower = name.toLowerCase();
  // Checked before the audio extensions: it IS a wav, but counting the self-test capture
  // as a deployment recording inflates every clip total by one and puts a file the device
  // never scheduled into the clip browser under its own 'Undated' day.
  if (lower === SELF_TEST_CLIP_FILE_NAME) return 'self-test-clip';
  if (lower.endsWith('.wav') || lower.endsWith('.opus') || lower.endsWith('.ogg')) return 'audio';
  if (lower.endsWith('.imu')) return 'imu';
  if (lower === '_a3em.cfg') return 'config';
  if (lower === '_a3em.dev') return 'device-info';
  if (lower === '_a3em.test.results') return 'self-test';
  // a3em.log, and the a3em.N.log alternatives written when a log cannot be reopened
  if (/^a3em(\.\d+)?\.log$/.test(lower)) return 'log';
  return 'other';
}

/** What only a recorder writes: once any of it is on a card, the card has been deployed. */
const RECORDER_KINDS = new Set<CardFileKind>(['audio', 'imu', 'log', 'device-info', 'self-test', 'self-test-clip']);

/**
 * How far a card has got: `deployed` once a recorder has written to it — a recording, a log, its
 * device information or its self-test — `prepared` while it holds a configuration and nothing a
 * recorder wrote, and `blank` with neither. Other files count toward neither: a card may carry a
 * computer's leftovers, or notes of someone's own.
 */
export type CardStage = 'deployed' | 'prepared' | 'blank';

export function cardStage(layout: CardLayout): CardStage {
  if (layout.files.some((file) => RECORDER_KINDS.has(file.kind))) return 'deployed';
  return layout.files.some((file) => file.kind === 'config') ? 'prepared' : 'blank';
}

/**
 * Builds a picture of the card from a flat listing.
 *
 * Takes paths and sizes only — no file contents — so it stays fast on a card holding
 * hundreds of thousands of files.
 */
export function readCardLayout(entries: Array<{ path: string; sizeBytes: number }>): CardLayout {
  const files: CardFile[] = [];
  const activations = new Set<number>();
  let deviceLabel: string | null = null;
  let epochNamed = 0;
  let renderedNamed = 0;

  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = path.split('/');
    const name = segments[segments.length - 1];
    if (!name || name.startsWith('.')) continue; // skip .DS_Store and friends

    const kind = classifyFile(name);
    const baseName = name.replace(/\.[^.]+$/, '');
    const deviceTime = kind === 'audio' || kind === 'imu' ? parseFileTimestamp(baseName) : null;

    if (deviceTime) {
      if (EPOCH_NAME.test(baseName)) epochNamed++;
      else renderedNamed++;
    }

    let activationNumber: number | null = null;
    for (const [index, segment] of segments.entries()) {
      const match = ACTIVATION_DIR.exec(segment);
      if (match) {
        activationNumber = Number(match[1]);
        activations.add(activationNumber);
        // The label is whatever directory holds the activation folders
        if (index > 0 && !deviceLabel) deviceLabel = segments[index - 1];
        break;
      }
    }

    files.push({ path, name, kind, sizeBytes: entry.sizeBytes, deviceTime, activationNumber });
  }

  const audio = files.filter((f) => f.kind === 'audio');
  const timestamps = files
    .map((f) => f.deviceTime)
    .filter((t): t is string => t !== null)
    .sort();

  return {
    deviceLabel,
    epochNaming: epochNamed > renderedNamed,
    activations: [...activations].sort((a, b) => a - b),
    files,
    audioCount: audio.length,
    imuCount: files.filter((f) => f.kind === 'imu').length,
    totalAudioBytes: audio.reduce((sum, f) => sum + f.sizeBytes, 0),
    firstDeviceTime: timestamps[0] ?? null,
    lastDeviceTime: timestamps.at(-1) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Clock correction
// ---------------------------------------------------------------------------

export type CorrectionMethod = 'activation' | 'deactivation' | 'gps' | 'manual';

export interface CorrectionSegment {
  /** Device-clock instant this segment begins at. Null means from the beginning. */
  fromDeviceTime: string | null;
  /** Seconds to add to a device-clock instant within this segment. */
  offsetSeconds: number;
}

export interface ClockCorrection {
  /**
   * The offset that applies to the bulk of the deployment. Present for display and for
   * the simple single-offset methods; `segments` is what actually gets applied.
   */
  offsetSeconds: number;
  method: CorrectionMethod;
  /** Worst-case error in the offset itself, in seconds. */
  accuracySeconds: number;
  /**
   * Piecewise correction, earliest first.
   *
   * A GPS unit corrects its own clock partway through a deployment, so recordings made
   * before that carry the activation error while everything after is already true UTC.
   * A single offset cannot express that; the other methods simply produce one segment.
   */
  segments: CorrectionSegment[];
}

export interface CorrectionOption {
  method: CorrectionMethod;
  available: boolean;
  /** What to ask the user for. */
  prompt: string;
  /** Why this method applies, or why it does not. */
  rationale: string;
  /** Device-clock instant the user's answer is compared against. */
  deviceReference: string | null;
  accuracySeconds: number;
}

/**
 * Which methods can actually establish the clock error for this card.
 *
 * The device sets its RTC to the CONFIGURED deployment start when the magnet activates
 * it, so the clock error is fixed from that moment:
 *
 *     clock_error = configured_start - true_activation_time
 *
 * Knowing when the device was ACTIVATED therefore determines it exactly. Knowing when
 * it was COLLECTED determines it only if the device was still running at that point --
 * otherwise the difference is mostly however long it sat idle after stopping, which is
 * unknown and often weeks.
 *
 * The card says which case applies, because the firmware records why it stopped.
 */
export function correctionOptions(options: {
  /** DEPLOYMENT_START_TIME from the card's configuration. */
  configuredStartTime: string | null;
  /** SET_RTC_AT_MAGNET_DETECT. When false the RTC is not seeded at activation at all. */
  setsRtcAtActivation: boolean;
  /** LAST_DEACTIVATION_REASON from _a3em.dev, if present. */
  stopReason: string | null;
  /** LAST_TIMESTAMP from _a3em.dev, else the newest file on the card. */
  lastDeviceTime: string | null;
  /** Whether the deployment had a GPS receiver, which corrects the clock in flight. */
  gpsAvailable: boolean;
  /** Clock corrections the device recorded itself, from the log. */
  clockSyncs?: ClockSyncEvent[];
}): CorrectionOption[] {
  // Only a magnet switch-off pins a moment a person actually witnessed. Every other
  // reason is the device deciding for itself, at a time nobody was present for, so it
  // cannot anchor a clock correction.
  const stoppedByMagnet = options.stopReason === 'MAGNET-OFF';
  const stoppedItself =
    options.stopReason !== null && !stoppedByMagnet && options.stopReason !== 'UNKNOWN';

  return [
    {
      method: 'activation',
      available: options.setsRtcAtActivation && options.configuredStartTime !== null,
      prompt: 'When did you activate the device?',
      rationale: options.setsRtcAtActivation
        ? 'The device set its clock to the configured start time at that moment, so the error is the ' +
          'same for every recording that followed.'
        : 'This deployment did not set its clock at activation, so the moment of activation tells us nothing ' +
          'about the error.',
      deviceReference: options.configuredStartTime,
      // Bounded by how precisely someone notes the moment they waved a magnet.
      accuracySeconds: 60,
    },
    {
      method: 'deactivation',
      available: stoppedByMagnet && options.lastDeviceTime !== null,
      prompt: 'When did you deactivate the device?',
      rationale: stoppedByMagnet
        ? 'The card shows the device was deactivated by magnet, so it was still running when you ' +
          'reached it and its last recorded time lines up with that moment.'
        : stoppedItself
          ? `The device stopped on its own (${options.stopReason}), so it may have sat idle for a long ` +
            'time before you collected it. The gap between stopping and collection is unknown, so ' +
            'this cannot give the clock error.'
          : 'The card does not record why the device stopped, so we cannot tell whether it was still ' +
            'running when you collected it.',
      deviceReference: options.lastDeviceTime,
      // The device writes its info file on the reboot that follows deactivation.
      accuracySeconds: 60,
    },
    {
      method: 'gps',
      available: (options.clockSyncs?.length ?? 0) > 0,
      prompt: 'Use the correction the device recorded itself',
      rationale: (options.clockSyncs?.length ?? 0) > 0
        ? `The device corrected its own clock from a GPS fix ${options.clockSyncs!.length} time` +
          `${options.clockSyncs!.length === 1 ? '' : 's'}, so the error is known exactly and nothing ` +
          'has to be remembered. Recordings made before the first fix are shifted; everything after ' +
          'is already true UTC and is left alone.'
        : options.gpsAvailable
          ? 'This deployment had GPS, but the log records no clock correction — either no fix was ' +
            'obtained, or the clock was already correct.'
          : 'This deployment had no GPS receiver.',
      deviceReference: null,
      accuracySeconds: 1,
    },
    {
      method: 'manual',
      available: true,
      prompt: 'Enter the offset directly',
      rationale: 'Use this if you established the clock error some other way.',
      deviceReference: null,
      accuracySeconds: 0,
    },
  ];
}

/**
 * The clock error, from the moment the device was activated.
 *
 * `configuredStartTime` is what the device set its clock to; the difference from when
 * that actually happened is the error, and it holds for the whole deployment.
 */
export function correctionFromActivation(
  configuredStartTime: string,
  actualActivationTime: string,
  accuracySeconds = 60,
): ClockCorrection {
  const offsetSeconds = Math.round(
    (Date.parse(actualActivationTime) - Date.parse(configuredStartTime)) / 1000,
  );
  return {
    offsetSeconds,
    method: 'activation',
    accuracySeconds,
    segments: [{ fromDeviceTime: null, offsetSeconds }],
  };
}

/**
 * The clock error, from the moment the device was deactivated.
 *
 * ONLY valid when the device was still running when you reached it, which the card
 * confirms by recording MAGNET as its stop reason. If it stopped on its own, the
 * interval between stopping and collection is unknown and this returns nonsense.
 */
export function correctionFromDeactivation(
  lastDeviceTime: string,
  actualDeactivationTime: string,
  accuracySeconds = 60,
): ClockCorrection {
  const offsetSeconds = Math.round(
    (Date.parse(actualDeactivationTime) - Date.parse(lastDeviceTime)) / 1000,
  );
  return {
    offsetSeconds,
    method: 'deactivation',
    accuracySeconds,
    segments: [{ fromDeviceTime: null, offsetSeconds }],
  };
}

export function manualCorrection(offsetSeconds: number): ClockCorrection {
  const rounded = Math.round(offsetSeconds);
  return {
    offsetSeconds: rounded,
    method: 'manual',
    accuracySeconds: 0,
    segments: [{ fromDeviceTime: null, offsetSeconds: rounded }],
  };
}

/** A clock correction the device recorded itself, from `EVT|CLOCK_SYNC`. */
export interface ClockSyncEvent {
  /** Device-clock instant immediately before the correction. */
  beforeDeviceTime: string;
  /** True UTC instant it was corrected to. */
  afterTrueTime: string;
  source: string;
}

/**
 * Builds a correction from the clock syncs a GPS-equipped device recorded itself.
 *
 * This is the only exact method available. The device knows true UTC from the fix, so
 * the correction it applied IS the accumulated error — nothing has to be remembered or
 * estimated by anyone.
 *
 * It is necessarily piecewise. Everything recorded before the first fix carries the
 * activation error; everything after is already true UTC and must NOT be shifted. A
 * single offset applied across the whole deployment would corrupt the majority of it.
 */
export function correctionFromClockSyncs(syncs: ClockSyncEvent[]): ClockCorrection | null {
  if (syncs.length === 0) return null;

  const ordered = [...syncs].sort(
    (a, b) => Date.parse(a.beforeDeviceTime) - Date.parse(b.beforeDeviceTime),
  );
  const deltaSeconds = (sync: ClockSyncEvent) =>
    Math.round((Date.parse(sync.afterTrueTime) - Date.parse(sync.beforeDeviceTime)) / 1000);

  const initialOffset = deltaSeconds(ordered[0]);

  // From the first fix onward the clock is true, so no shift applies. Later fixes
  // correct only accumulated drift, which is what their deltas measure.
  const segments: CorrectionSegment[] = [
    { fromDeviceTime: null, offsetSeconds: initialOffset },
    { fromDeviceTime: ordered[0].afterTrueTime, offsetSeconds: 0 },
  ];

  const drift = ordered.slice(1).map((sync) => Math.abs(deltaSeconds(sync)));

  return {
    offsetSeconds: initialOffset,
    method: 'gps',
    // Exact at the moment of the fix; later drift bounds how far the corrected
    // portion can wander between fixes.
    accuracySeconds: drift.length ? Math.max(...drift) : 1,
    segments,
  };
}

/**
 * Real-world instant for a device-clock instant.
 *
 * Picks the segment covering that instant, so a GPS deployment shifts only the portion
 * recorded before its clock was corrected.
 */
export function applyCorrection(deviceTime: string, correction: ClockCorrection | null): string {
  if (!correction) return deviceTime;
  const at = Date.parse(deviceTime);
  let offsetSeconds = correction.segments[0]?.offsetSeconds ?? correction.offsetSeconds;
  for (const segment of correction.segments) {
    if (segment.fromDeviceTime === null || Date.parse(segment.fromDeviceTime) <= at) {
      offsetSeconds = segment.offsetSeconds;
    }
  }
  return new Date(at + offsetSeconds * 1000).toISOString();
}

/** Human phrasing for how far off the clock was, for the review workspace header. */
export function describeCorrection(correction: ClockCorrection): string {
  const seconds = Math.abs(correction.offsetSeconds);
  if (seconds < 60) return `${correction.offsetSeconds >= 0 ? 'behind' : 'ahead'} by ${seconds}s`;
  const direction = correction.offsetSeconds >= 0 ? 'behind' : 'ahead';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`].filter(Boolean);
  return `${direction} by ${parts.join(' ')}`;
}

// ---------------------------------------------------------------------------
// Renaming to human-readable, corrected names
// ---------------------------------------------------------------------------

export interface RenamePlanEntry {
  from: string;
  to: string;
  deviceTime: string;
  correctedTime: string;
}

export interface RenamePlan {
  entries: RenamePlanEntry[];
  /** Directories to create, deepest last, so they can be made in order. */
  directories: string[];
  /** Files left alone, with the reason, so nothing disappears silently. */
  skipped: Array<{ path: string; reason: string }>;
  /** Output paths that more than one input maps to. Non-empty means do not proceed. */
  collisions: string[];
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** `YYYY-MM-DD HH-MM-SS`, the form the desktop tool used and people recognize. */
export function renderTimestamp(iso: string): string {
  const d = new Date(iso);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`
  );
}

/**
 * Plans a rename of every timestamped file to a corrected, human-readable name.
 *
 * Produces a plan rather than performing anything: renaming thousands of irreplaceable
 * files is exactly the operation that should be previewed, counted, and checked for
 * collisions before a single file moves.
 *
 * Directories are renamed too, to the corrected date and hour bucket, so the folder
 * a recording sits in agrees with the recording's own name.
 */
export function planRename(layout: CardLayout, correction: ClockCorrection): RenamePlan {
  const entries: RenamePlanEntry[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const directories = new Set<string>();
  const seen = new Map<string, number>();

  for (const file of layout.files) {
    if (file.kind !== 'audio' && file.kind !== 'imu') continue;
    if (!file.deviceTime) {
      skipped.push({ path: file.path, reason: 'name has no timestamp' });
      continue;
    }

    const corrected = applyCorrection(file.deviceTime, correction);
    const stamp = renderTimestamp(corrected);
    const extension = file.name.slice(file.name.lastIndexOf('.'));

    // Rebuild the path with corrected date and hour-bucket directories, preserving
    // everything above the activation folder.
    const segments = file.path.split('/');
    const activationIndex = segments.findIndex((segment) => ACTIVATION_DIR.test(segment));
    if (activationIndex < 0) {
      skipped.push({ path: file.path, reason: 'not inside an activation folder' });
      continue;
    }

    const date = new Date(corrected);
    const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
    const hourBucket = pad(
      Math.floor(date.getUTCHours() / NUM_HOURS_PER_AUDIO_DIRECTORY) * NUM_HOURS_PER_AUDIO_DIRECTORY,
    );
    const prefix = segments.slice(0, activationIndex + 1).join('/');
    const to = `${prefix}/${day}/${hourBucket}/${stamp}${extension}`;

    directories.add(`${prefix}/${day}`);
    directories.add(`${prefix}/${day}/${hourBucket}`);
    seen.set(to, (seen.get(to) ?? 0) + 1);
    entries.push({ from: file.path, to, deviceTime: file.deviceTime, correctedTime: corrected });
  }

  return {
    entries,
    directories: [...directories].sort((a, b) => a.split('/').length - b.split('/').length),
    skipped,
    collisions: [...seen.entries()].filter(([, count]) => count > 1).map(([path]) => path),
  };
}
