import { IMU_BYTES_PER_SAMPLE } from './firmware-constants.js';
import { detectImuHeaderBytes } from './imu-file.js';

/**
 * Judging whether a recording on a card is sound, from its size and first 44 bytes.
 *
 * Pure on purpose. The app half of this owns file handles and progress reporting, which
 * cannot be tested without a browser; the decisions live here where they can be. Every
 * rule below is derived from `storage_write_wav_header()` and `storage_close_wav_audio()`
 * in the firmware, not from the WAV specification in general — this reads A3EM cards,
 * and being strict about the exact bytes the device writes is what makes it useful.
 */

export type RecordingVerdict =
  | 'ok'
  | 'empty'
  | 'unfinalized'
  | 'truncated'
  | 'malformed'
  | 'blank'
  | 'unreadable';

export interface RecordingJudgment {
  verdict: RecordingVerdict;
  /** One sentence, in the terms an ecologist would use. Null when the file is sound. */
  detail: string | null;
  /**
   * Whether the audio itself survived and only the bookkeeping is wrong. The difference
   * between "this clip is gone" and "this clip needs its header rewritten", which is the
   * difference worth surfacing above everything else in this module.
   */
  recoverable: boolean;
  /** Present when the file can be put right in place. See `WAV_HEADER_REPAIR`. */
  repair?: WavHeaderRepair;
}

/** The two little-endian uint32 writes that finalize a WAV, as the firmware does them. */
export interface WavHeaderRepair {
  kind: 'wav-header';
  /** True payload length, for offset 40. */
  dataSize: number;
  /** `36 + dataSize`, for offset 4. */
  riffSize: number;
}

export const RECORDING_VERDICT_LABELS: Record<RecordingVerdict, string> = {
  ok: 'Sound',
  empty: 'Empty',
  unfinalized: 'Never finalized',
  truncated: 'Cut short',
  malformed: 'Header damaged',
  blank: 'Blank',
  unreadable: 'Unreadable',
};

/** Verdicts where the recording is lost, as opposed to merely mislabeled. */
export const LOST_VERDICTS: ReadonlySet<RecordingVerdict> = new Set<RecordingVerdict>([
  'empty',
  'truncated',
  'malformed',
  'blank',
  'unreadable',
]);

export const WAV_HEADER_BYTES = 44;

/**
 * The data-chunk size the firmware writes when it opens a file, before any audio exists.
 *
 * It is 16 rather than 0 by accident — `storage_write_wav_header()` reuses the variable
 * holding bits-per-sample for the placeholder. Harmless once the file is closed, and
 * useful to us: it is a distinctive fingerprint of a clip that never closed. Zero is
 * accepted alongside it so that tightening the firmware later does not break detection.
 */
const UNFINALIZED_DATA_SIZES: ReadonlySet<number> = new Set([16, 0]);
const UNFINALIZED_RIFF_SIZE = 36;

/** Above this a declared length is not a truncation but a corrupted field. */
const IMPLAUSIBLE_DATA_SIZE = 2 * 1024 * 1024 * 1024;

export interface WavCheckOptions {
  /**
   * Whether this card came from firmware that writes the data chunk correctly.
   *
   * Firmware before 2026.08.1 overstated it by exactly four bytes on every file, so on
   * those cards a four-byte discrepancy is expected and anything else is a real fault.
   */
  correctWavChunkSize: boolean;
}

/**
 * Judges a WAV from its size and its first 44 bytes.
 *
 * `header` may be short or null when the file could not be read that far, which is
 * itself diagnostic rather than an error to throw on.
 */
export function judgeWavFile(
  sizeBytes: number,
  header: Uint8Array | null,
  options: WavCheckOptions,
): RecordingJudgment {
  if (sizeBytes === 0) {
    return {
      verdict: 'empty',
      detail: 'Zero bytes — the device created the file but never wrote any audio into it.',
      recoverable: false,
    };
  }
  if (!header || header.byteLength < WAV_HEADER_BYTES) {
    return {
      verdict: 'truncated',
      detail: `Only ${sizeBytes.toLocaleString()} bytes — shorter than a WAV header, so there is no audio to recover.`,
      recoverable: false,
    };
  }

  // A run of zeros where the header should be is the signature of a flash block that
  // failed to read back, not of a file the firmware wrote badly. Worth naming separately:
  // it points at the card rather than at the device.
  if (header.every((byte) => byte === 0)) {
    return {
      verdict: 'blank',
      detail:
        'Reads back as all zeros. This is usually a failed area of the card rather than ' +
        'anything the device did, and the audio cannot be recovered.',
      recoverable: false,
    };
  }

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    return {
      verdict: 'malformed',
      detail: 'Does not begin with a RIFF/WAVE header — this is not an intact recording.',
      recoverable: false,
    };
  }
  if (tag(12) !== 'fmt ' || tag(36) !== 'data') {
    return {
      verdict: 'malformed',
      detail: 'The format or data chunk markers are damaged, so the audio cannot be located within the file.',
      recoverable: false,
    };
  }

  const riffSize = view.getUint32(4, true);
  const declared = view.getUint32(40, true);
  const actual = sizeBytes - WAV_HEADER_BYTES;

  // The whole reason this verdict exists. The firmware fills in both size fields only in
  // storage_close_wav_audio(), so a clip interrupted by power loss, a crash, or a card
  // pulled mid-write keeps the placeholders while its audio sits intact behind them.
  // Every player will treat such a file as sixteen bytes long; nothing is actually lost.
  if (UNFINALIZED_DATA_SIZES.has(declared) && riffSize === UNFINALIZED_RIFF_SIZE && actual > declared) {
    return {
      verdict: 'unfinalized',
      detail:
        `Holds ${formatBytes(actual)} of audio but was never closed properly — the device ` +
        'most likely lost power mid-clip. The recording itself is intact and can be repaired.',
      recoverable: true,
      repair: { kind: 'wav-header', dataSize: actual, riffSize: UNFINALIZED_RIFF_SIZE + actual },
    };
  }

  if (declared >= IMPLAUSIBLE_DATA_SIZE) {
    return {
      verdict: 'malformed',
      detail: `Claims ${formatBytes(declared)} of audio, which is not a length this device can produce.`,
      recoverable: false,
    };
  }

  const tolerance = options.correctWavChunkSize ? 0 : 4;
  if (declared > actual + tolerance) {
    const missing = declared - actual;
    return {
      verdict: 'truncated',
      detail:
        `Declares ${formatBytes(declared)} of audio but holds ${formatBytes(actual)} — ` +
        `${formatBytes(missing)} is missing from the end.`,
      recoverable: false,
    };
  }

  return { verdict: 'ok', detail: null, recoverable: false };
}

/**
 * Judges an IMU file, which has no header magic to check — only arithmetic.
 *
 * The payload must divide evenly into 12-byte samples after one of the two header
 * layouts. Anything else means the file stops mid-sample, which only happens when a
 * write was interrupted.
 */
export function judgeImuFile(sizeBytes: number): RecordingJudgment {
  if (sizeBytes === 0) {
    return {
      verdict: 'empty',
      detail: 'Zero bytes — no motion data was written.',
      recoverable: false,
    };
  }
  if (detectImuHeaderBytes(sizeBytes) === null) {
    return {
      verdict: 'truncated',
      detail:
        `${sizeBytes.toLocaleString()} bytes does not divide into whole ` +
        `${IMU_BYTES_PER_SAMPLE}-byte readings, so the file stops part-way through one.`,
      recoverable: false,
    };
  }
  return { verdict: 'ok', detail: null, recoverable: false };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
