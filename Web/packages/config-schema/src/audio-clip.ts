/**
 * Reading a recorded clip: its format, how loud it is, and what it looks like.
 *
 * Exists to answer the first question anyone asks of a returned card — "is there
 * actually anything on here?" The ecologist responses put opening a few files and
 * listening at the top of the retrieval routine, and name verifying the microphone path
 * after assembly as an absolute need. Both are level questions before they are listening
 * questions, so the numbers here matter as much as the playback they accompany.
 *
 * Pure and synchronous. File reading and playback belong to the app.
 */

export interface WavFormat {
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
  /** Byte offset of the first audio sample. */
  dataOffset: number;
  /** What the header claims, which is not always the truth. */
  declaredDataBytes: number;
  /** What is actually present, which is what can be read. */
  actualDataBytes: number;
  durationSeconds: number;
}

/**
 * Parses the RIFF chunk list rather than assuming the fixed 44-byte layout.
 *
 * The firmware writes a canonical header today, but a reader that walks chunks costs
 * little and does not break the moment anything is added ahead of the data.
 */
export function readWavFormat(bytes: Uint8Array): WavFormat | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let channels = 0;
  let sampleRateHz = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let declaredDataBytes = 0;

  let cursor = 12;
  while (cursor + 8 <= bytes.byteLength) {
    const id = tag(cursor);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;

    if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
      channels = view.getUint16(body + 2, true);
      sampleRateHz = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      declaredDataBytes = size;
      break;
    }
    // Chunks are word-aligned; an odd size is followed by a pad byte.
    cursor = body + size + (size % 2);
  }

  if (!dataOffset || !channels || !sampleRateHz || !bitsPerSample) return null;

  const actualDataBytes = Math.max(0, bytes.byteLength - dataOffset);
  const bytesPerFrame = (bitsPerSample / 8) * channels;
  return {
    channels,
    sampleRateHz,
    bitsPerSample,
    dataOffset,
    declaredDataBytes,
    actualDataBytes,
    durationSeconds: bytesPerFrame > 0 ? actualDataBytes / bytesPerFrame / sampleRateHz : 0,
  };
}

/** The 16-bit samples actually present, ignoring whatever length the header claims. */
export function readSamples(bytes: Uint8Array, format: WavFormat): Int16Array {
  if (format.bitsPerSample !== 16) return new Int16Array(0);
  const count = Math.floor(format.actualDataBytes / 2);
  const samples = new Int16Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(format.dataOffset + i * 2, true);
  return samples;
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export interface ClipLevels {
  sampleCount: number;
  /** Largest absolute sample, in int16 units. */
  peak: number;
  peakDbfs: number;
  rms: number;
  rmsDbfs: number;
  /** Mean sample value. A large one means the signal is not centered. */
  dcOffset: number;
  clippedSamples: number;
  /** Fraction of samples at exactly zero. */
  zeroFraction: number;
  /**
   * Smallest interval between distinct sample values.
   *
   * A3EM audio comes from a 12-bit converter written into 16-bit samples, so real
   * recordings step in multiples of 16. Measuring it rather than assuming it turns this
   * into a check: a step that is suddenly much coarser means the signal reaching the
   * converter has lost range somewhere along the microphone path.
   */
  quantizationStep: number;
  /** Bits genuinely in use, derived from the step. 16 when every level is present. */
  effectiveBits: number;
  /** True when every sample is identical — a dead microphone, not a quiet one. */
  flatline: boolean;
}

const INT16_FULL_SCALE = 32768;

export function measureLevels(samples: Int16Array): ClipLevels {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      peak: 0,
      peakDbfs: -Infinity,
      rms: 0,
      rmsDbfs: -Infinity,
      dcOffset: 0,
      clippedSamples: 0,
      zeroFraction: 0,
      quantizationStep: 0,
      effectiveBits: 0,
      flatline: true,
    };
  }

  let peak = 0;
  let sum = 0;
  let sumSquares = 0;
  let clipped = 0;
  let zeros = 0;
  let step = 0;
  const first = samples[0];
  let flat = true;

  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sum += value;
    sumSquares += value * value;
    if (value === 0) zeros++;
    else if (step !== 1) step = gcd(step, magnitude);
    if (value >= 32767 || value <= -32768) clipped++;
    if (value !== first) flat = false;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  return {
    sampleCount: samples.length,
    peak,
    peakDbfs: toDbfs(peak),
    rms,
    rmsDbfs: toDbfs(rms),
    dcOffset: sum / samples.length,
    clippedSamples: clipped,
    zeroFraction: zeros / samples.length,
    quantizationStep: step,
    effectiveBits: step > 0 ? 16 - Math.log2(step) : 0,
    flatline: flat,
  };
}

const toDbfs = (value: number) => (value > 0 ? 20 * Math.log10(value / INT16_FULL_SCALE) : -Infinity);

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

export type ClipHealth = 'ok' | 'quiet' | 'clipping' | 'dead';

export interface ClipVerdict {
  health: ClipHealth;
  headline: string;
  detail: string;
}

/**
 * What the levels mean, for someone checking a microphone rather than reading numbers.
 *
 * The thresholds are deliberately loose. Real A3EM recordings of a quiet site sit around
 * -42 dBFS peak, which is perfectly healthy for low-frequency monitoring and would be
 * alarming on a bird survey — so "quiet" here reports what was measured and leaves the
 * judgment to someone who knows the site.
 */
export function judgeClip(levels: ClipLevels): ClipVerdict {
  if (levels.sampleCount === 0) {
    return { health: 'dead', headline: 'No audio', detail: 'This clip contains no samples at all.' };
  }
  if (levels.flatline) {
    return {
      health: 'dead',
      headline: 'No signal',
      detail:
        'Every sample is identical, so nothing reached the recorder. This is what a disconnected or ' +
        'broken microphone looks like — not a quiet site.',
    };
  }
  if (levels.clippedSamples > levels.sampleCount * 0.001) {
    return {
      health: 'clipping',
      headline: 'Clipping',
      detail:
        `${levels.clippedSamples.toLocaleString()} samples hit the limit of what can be recorded. ` +
        'Lower the microphone gain — the loudest sounds are being flattened.',
    };
  }
  if (levels.peakDbfs < -60) {
    return {
      health: 'quiet',
      headline: 'Very quiet',
      detail:
        `Peaks reach only ${levels.peakDbfs.toFixed(0)} dBFS. That can be a genuinely silent site, or a ` +
        'microphone that is failing. Compare against other clips before concluding either.',
    };
  }
  return {
    health: 'ok',
    headline: 'Signal present',
    detail: `Peaks reach ${levels.peakDbfs.toFixed(0)} dBFS with no clipping.`,
  };
}

// ---------------------------------------------------------------------------
// Drawing and playing
// ---------------------------------------------------------------------------

export interface EnvelopePoint {
  min: number;
  max: number;
}

/**
 * Reduces a clip to one min/max pair per horizontal pixel.
 *
 * Drawing a minute of 8 kHz audio means 480,000 samples across a few hundred pixels;
 * keeping both extremes per bucket preserves transients that plotting every nth sample
 * would drop entirely.
 */
export function waveformEnvelope(samples: Int16Array, buckets: number): EnvelopePoint[] {
  if (samples.length === 0 || buckets <= 0) return [];
  const width = samples.length / buckets;
  const points: EnvelopePoint[] = [];

  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor(bucket * width);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((bucket + 1) * width)));
    let min = samples[start];
    let max = samples[start];
    for (let i = start + 1; i < end; i++) {
      if (samples[i] < min) min = samples[i];
      if (samples[i] > max) max = samples[i];
    }
    points.push({ min, max });
  }
  return points;
}

/**
 * A copy of the clip whose header describes what the file actually holds.
 *
 * Two kinds of file need this. Legacy firmware overstated the data chunk by four bytes
 * on every recording, and a clip interrupted before it was closed still carries the
 * placeholder length written when it was opened — which players read as sixteen bytes,
 * making a perfectly good recording appear empty.
 *
 * Corrects a copy in memory and never the file, so playing a clip cannot alter the card.
 */
export function buildPlayableWav(bytes: Uint8Array): Uint8Array | null {
  const format = readWavFormat(bytes);
  if (!format || format.actualDataBytes === 0) return null;
  if (format.declaredDataBytes === format.actualDataBytes) return bytes;

  const copy = bytes.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  view.setUint32(4, copy.byteLength - 8, true);
  view.setUint32(format.dataOffset - 4, format.actualDataBytes, true);
  return copy;
}
