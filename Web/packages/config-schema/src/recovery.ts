import { IMU_BYTES_PER_SAMPLE, IMU_SAMPLE_RATES_HZ } from './firmware-constants.js';
import { IMU_HEADER_BYTES_MODERN } from './imu-file.js';

/**
 * How much of what a card holds past a file's recorded end belongs to the file.
 *
 * The recorder's FatFs records a file's length only when it syncs or closes it, so power lost
 * in between leaves data the recorder wrote beyond that length: the last lines of a log, synced
 * after each event; all of an IMU file cut short, synced only when closed. The card helper hands
 * over what lies there, and this decides how much of it to add to the file's copy.
 *
 * It has to decide, because the same space can hold what was on the card before it was last
 * formatted — formatting does not clear it — and that looks like data too: on one real card,
 * the space after an IMU file read as 525 g on every axis. So what is kept is only what could
 * have come from the recorder, and nothing past the first sign it did not:
 *
 *  - The recorder's writes reach the card a sector at a time. What it wrote therefore ends at a
 *    sector boundary, and leftovers begin at one, so data is judged, and cut, a sector at a time.
 *  - A log is text, and its events are dated in order. A sector that is not text, or a line
 *    dated before the log's last event, is where the log's own data has ended.
 *  - An IMU file starts with its header — a rate the recorder uses, and a first-sample time just
 *    after the time the file is named for — and holds accelerations a sensor can report: finite,
 *    within its range, and not the near-zero reading of nothing at all. It is no longer than its
 *    clip.
 */

/** Where the recorder's writes reach the card: whole sectors. */
export const CARD_SECTOR_BYTES = 512;

/** Beyond the accelerometer's ±16 g range, with room for its overshoot. */
const IMU_LIMIT_MG = 20_000;
/** Less than a tenth of gravity, on all three axes together, is no reading: free fall aside, nothing on Earth is that still. */
const IMU_MIN_MAGNITUDE_MG = 100;
/** How long after the time an IMU file is named for its first sample can be. */
const IMU_START_WINDOW_SECONDS = 60;

export interface AcceptedLogTail {
  bytes: Uint8Array;
  lines: number;
}

export interface AcceptedImuRecovery {
  /** The whole file: its header and its samples. */
  bytes: Uint8Array;
  samples: number;
  sampleRateHz: number;
  seconds: number;
}

/** Bytes a log line holds: printable ASCII, tab and line breaks, and UTF-8's multi-byte range. */
function isLogText(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte >= 0x20 && byte <= 0x7e) continue;
    if (byte >= 0x80 && byte <= 0xf4) continue;
    return false;
  }
  return true;
}

const EVENT_TIME = /\bt=(\d{9,10})\b/;

function latestEventTime(text: string): number {
  let latest = 0;
  for (const match of text.matchAll(/\bt=(\d{9,10})\b/g)) latest = Math.max(latest, Number(match[1]));
  return latest;
}

/**
 * The part of a log's unrecorded tail that is the log's: whole sectors of text from its recorded
 * end, up to the first line dated before the log's latest event. Null when there is none.
 */
export function acceptLogTail(tail: { recordedBytes: number; before: Uint8Array; data: Uint8Array }): AcceptedLogTail | null {
  const { recordedBytes, data } = tail;
  // A sector's worth at a time, aligned to the file, while each is text.
  let end = 0;
  while (end < data.length) {
    const next = Math.min(data.length, end + CARD_SECTOR_BYTES - ((recordedBytes + end) % CARD_SECTOR_BYTES));
    if (!isLogText(data.subarray(end, next))) break;
    end = next;
  }
  if (!end) return null;

  // Then back to the start of the sector holding the first line that goes back in time.
  const sectorStart = (index: number) => Math.max(0, index - ((recordedBytes + index) % CARD_SECTOR_BYTES));
  const decoder = new TextDecoder();
  let latest = latestEventTime(decoder.decode(tail.before));
  let lineStart = 0;
  for (let index = 0; index <= end; index++) {
    if (index < end && data[index] !== 0x0a) continue;
    const match = EVENT_TIME.exec(decoder.decode(data.subarray(lineStart, index)));
    if (match) {
      const time = Number(match[1]);
      if (time < latest) {
        end = sectorStart(lineStart);
        break;
      }
      latest = time;
    }
    lineStart = index + 1;
  }
  if (!end) return null;
  const bytes = data.slice(0, end);
  return { bytes, lines: bytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0) };
}

function plausibleSample(view: DataView, offset: number): boolean {
  const axes = [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
  if (!axes.every((value) => Number.isFinite(value) && Math.abs(value) <= IMU_LIMIT_MG)) return false;
  return Math.hypot(...axes) >= IMU_MIN_MAGNITUDE_MG;
}

/**
 * An IMU file cut short, from the unowned space its header was found in: the header and the
 * samples that follow, up to the sector holding the first that no sensor would report, and no
 * more than its clip's length. Null when the header is not the file's, or nothing follows it.
 */
export function acceptImuRecovery(recovery: {
  /** The time the file is named for, in seconds. */
  nameTime: number;
  data: Uint8Array;
  /** The longest clip the card's configuration records, where it says. */
  clipSeconds: number | null;
}): AcceptedImuRecovery | null {
  const { data } = recovery;
  const header = IMU_HEADER_BYTES_MODERN;
  if (data.length < header + IMU_BYTES_PER_SAMPLE) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rate = view.getUint32(0, true);
  const start = view.getUint32(4, true);
  if (!(IMU_SAMPLE_RATES_HZ as readonly number[]).includes(rate)) return null;
  if (start < recovery.nameTime || start - recovery.nameTime > IMU_START_WINDOW_SECONDS) return null;

  const available = Math.floor((data.length - header) / IMU_BYTES_PER_SAMPLE);
  let samples = 0;
  while (samples < available && plausibleSample(view, header + samples * IMU_BYTES_PER_SAMPLE)) samples++;
  if (samples < available) {
    // Writing stopped at a sector boundary no later than the first sample that is not one.
    const boundary = Math.floor((header + samples * IMU_BYTES_PER_SAMPLE) / CARD_SECTOR_BYTES) * CARD_SECTOR_BYTES;
    samples = Math.max(0, Math.floor((boundary - header) / IMU_BYTES_PER_SAMPLE));
  }
  if (recovery.clipSeconds) samples = Math.min(samples, Math.ceil(recovery.clipSeconds * rate));
  if (!samples) return null;
  return {
    bytes: data.slice(0, header + samples * IMU_BYTES_PER_SAMPLE),
    samples,
    sampleRateHz: rate,
    seconds: samples / rate,
  };
}
