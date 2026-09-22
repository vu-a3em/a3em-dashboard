import { IMU_BYTES_PER_SAMPLE } from './firmware-constants.js';

/**
 * Reader for `.imu` files, which exist in two header layouts.
 *
 * Both start with a `uint32` sample rate. The timestamp that follows was written as
 * `sizeof(time_t)` bytes, and on the production toolchain `time_t` is 8 bytes — so
 * firmware up to 2026.08.0 produced a **12-byte** header with an always-zero high word.
 * From 2026.08.1 the timestamp is written as an explicit `uint32`, giving a **fixed
 * 8-byte** header.
 *
 * The two are distinguishable from file size alone and never ambiguous: the payload is
 * a whole number of 12-byte samples, and the two candidate header sizes differ by 4,
 * which is not a multiple of 12. So at most one of `(size - 8) % 12` and
 * `(size - 12) % 12` can be zero.
 *
 * This matters: `Python/dashboard/processing.py` assumes an 8-byte header
 * unconditionally, so on every file written to date it reads each triple straddling
 * two samples. The axes come out permuted and mixed, while the magnitudes stay
 * plausible — which is why it was never noticed.
 */

export const IMU_HEADER_BYTES_MODERN = 8; // uint32 rate + uint32 timestamp
export const IMU_HEADER_BYTES_LEGACY = 12; // uint32 rate + 64-bit time_t

export interface ImuSample {
  /** Seconds since the file's start timestamp. */
  offsetSeconds: number;
  /** Acceleration in milli-g. */
  x: number;
  y: number;
  z: number;
}

export interface ImuFile {
  sampleRateHz: number;
  /**
   * ISO instant of the first sample, which is not always the instant the file is named
   * after.
   *
   * A clip is named for where its AUDIO begins. In continuous, interval and scheduled
   * recording the sensor is started alongside the microphone, so the two agree. In
   * amplitude mode they cannot: the clip is opened by the buffer that triggered it, and
   * that buffer's audio was already captured by the time anything could start the sensor.
   * There the header runs one DMA buffer later than the name, and the difference between
   * them is exactly how far into the clip the IMU trace begins.
   */
  startTime: string;
  sampleCount: number;
  headerBytes: number;
  /** True when the file used the older 12-byte header. */
  legacyHeader: boolean;
  samples: ImuSample[];
}

export class ImuFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImuFormatError';
  }
}

/** Header size implied by the file length, or null if neither layout fits. */
export function detectImuHeaderBytes(byteLength: number): number | null {
  const modernFits =
    byteLength >= IMU_HEADER_BYTES_MODERN && (byteLength - IMU_HEADER_BYTES_MODERN) % IMU_BYTES_PER_SAMPLE === 0;
  const legacyFits =
    byteLength >= IMU_HEADER_BYTES_LEGACY && (byteLength - IMU_HEADER_BYTES_LEGACY) % IMU_BYTES_PER_SAMPLE === 0;

  // Cannot both hold: the sizes differ by 4, which is not a multiple of 12.
  if (modernFits) return IMU_HEADER_BYTES_MODERN;
  if (legacyFits) return IMU_HEADER_BYTES_LEGACY;
  return null;
}

/**
 * Parses a `.imu` file. Pass `maxSamples` to decimate for plotting — a full file at
 * 50 Hz over a 60 s clip is 3000 samples, and a deployment can hold thousands of files.
 */
export function parseImuFile(buffer: ArrayBuffer, options: { maxSamples?: number } = {}): ImuFile {
  const headerBytes = detectImuHeaderBytes(buffer.byteLength);
  if (headerBytes === null) {
    throw new ImuFormatError(
      `File length ${buffer.byteLength} does not fit either IMU layout ` +
        `(${IMU_HEADER_BYTES_MODERN}- or ${IMU_HEADER_BYTES_LEGACY}-byte header plus whole ` +
        `${IMU_BYTES_PER_SAMPLE}-byte samples). The file is probably truncated.`,
    );
  }

  const view = new DataView(buffer);
  const sampleRateHz = view.getUint32(0, true);
  if (sampleRateHz === 0) throw new ImuFormatError('IMU sample rate is zero.');

  // Both layouts put the low word of the timestamp at offset 4. In the legacy layout
  // the high word at offset 8 is always zero, so a plain uint32 read is correct for both.
  const startSeconds = view.getUint32(4, true);

  const sampleCount = (buffer.byteLength - headerBytes) / IMU_BYTES_PER_SAMPLE;
  const stride = options.maxSamples && sampleCount > options.maxSamples
    ? Math.ceil(sampleCount / options.maxSamples)
    : 1;

  const samples: ImuSample[] = [];
  for (let index = 0; index < sampleCount; index += stride) {
    const offset = headerBytes + index * IMU_BYTES_PER_SAMPLE;
    samples.push({
      offsetSeconds: index / sampleRateHz,
      x: view.getFloat32(offset, true),
      y: view.getFloat32(offset + 4, true),
      z: view.getFloat32(offset + 8, true),
    });
  }

  return {
    sampleRateHz,
    startTime: new Date(startSeconds * 1000).toISOString(),
    sampleCount,
    headerBytes,
    legacyHeader: headerBytes === IMU_HEADER_BYTES_LEGACY,
    samples,
  };
}

/** Magnitude in milli-g. A stationary device reads about 1000 (one g). */
export function accelerationMagnitude(sample: ImuSample): number {
  return Math.sqrt(sample.x * sample.x + sample.y * sample.y + sample.z * sample.z);
}
