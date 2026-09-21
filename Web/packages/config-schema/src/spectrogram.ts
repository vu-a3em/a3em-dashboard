/**
 * Turning a clip into a picture of its frequencies over time.
 *
 * For this hardware the spectrogram is not a nicety. A3EM's deployments record at 8 kHz
 * for low-frequency work, and an elephant rumble at 20 Hz is indistinguishable from the
 * noise floor on a waveform — the amplitude is small and the shape tells you nothing.
 * On a spectrogram it is unmistakable. This is the view that answers whether a
 * deployment captured what it was sent out for.
 *
 * Pure and synchronous. Drawing belongs to the app.
 */

export interface SpectrogramOptions {
  sampleRateHz: number;
  /** Power of two. Larger resolves frequency more finely and time more coarsely. */
  fftSize: number;
  /** How many columns to produce, normally the width available to draw into. */
  columns: number;
  /** Everything below this reads as empty. */
  floorDb?: number;
}

export interface Spectrogram {
  columns: number;
  /** Bins per column, `fftSize / 2`, spanning DC up to Nyquist. */
  bins: number;
  /** Decibels relative to a full-scale sine, laid out as `column * bins + bin`. */
  data: Float32Array;
  frequencyStepHz: number;
  secondsPerColumn: number;
  /** Loudest value present, for scaling the display to the clip rather than to nothing. */
  peakDb: number;
  floorDb: number;
}

/**
 * Windows examined per column when a clip is longer than the display is wide.
 *
 * A minute of 8 kHz audio into 1000 columns leaves 480 samples per column, less than one
 * window; five minutes at 48 kHz leaves 14,000, far more than one. Rather than skipping
 * the audio in between — which would drop brief calls entirely — several windows are
 * taken across the column and the loudest kept, so a short event still registers. Capped
 * so cost stays bounded no matter how long the recording is.
 */
const MAX_WINDOWS_PER_COLUMN = 4;

export function computeSpectrogram(samples: Int16Array, options: SpectrogramOptions): Spectrogram {
  const { sampleRateHz, fftSize, columns } = options;
  const floorDb = options.floorDb ?? -110;
  const bins = fftSize / 2;
  const data = new Float32Array(Math.max(0, columns) * bins).fill(floorDb);

  const empty: Spectrogram = {
    columns: Math.max(0, columns),
    bins,
    data,
    frequencyStepHz: sampleRateHz / fftSize,
    secondsPerColumn: 0,
    peakDb: floorDb,
    floorDb,
  };
  if (samples.length === 0 || columns <= 0 || !isPowerOfTwo(fftSize)) return empty;

  const window = hann(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  // A Hann-windowed full-scale sine puts amplitude * N / 4 in its peak bin; dividing by
  // that makes 0 dB mean "as loud as this format can represent".
  const reference = 32768 * (fftSize / 4);

  const columnSpan = samples.length / columns;
  let peakDb = -Infinity;

  for (let column = 0; column < columns; column++) {
    const spanStart = column * columnSpan;
    const windowsHere = Math.max(1, Math.min(MAX_WINDOWS_PER_COLUMN, Math.floor(columnSpan / fftSize)));

    for (let w = 0; w < windowsHere; w++) {
      const offset = Math.min(
        Math.max(0, samples.length - fftSize),
        Math.floor(spanStart + (w * columnSpan) / windowsHere),
      );

      for (let i = 0; i < fftSize; i++) {
        const index = offset + i;
        re[i] = index < samples.length ? samples[index] * window[i] : 0;
        im[i] = 0;
      }
      fft(re, im);

      for (let bin = 0; bin < bins; bin++) {
        const magnitude = Math.hypot(re[bin], im[bin]);
        const db = magnitude > 0 ? Math.max(floorDb, 20 * Math.log10(magnitude / reference)) : floorDb;
        const at = column * bins + bin;
        // Loudest of the windows covering this column, so brief events survive.
        if (db > data[at]) data[at] = db;
        if (db > peakDb) peakDb = db;
      }
    }
  }

  return {
    columns,
    bins,
    data,
    frequencyStepHz: sampleRateHz / fftSize,
    secondsPerColumn: columnSpan / sampleRateHz,
    peakDb: Number.isFinite(peakDb) ? peakDb : floorDb,
    floorDb,
  };
}

/** The frequency a bin index represents, in Hz. */
export const binFrequencyHz = (bin: number, spectrogram: Spectrogram) => bin * spectrogram.frequencyStepHz;

/** The bin nearest a frequency, clamped into range. */
export const frequencyBin = (hz: number, spectrogram: Spectrogram) =>
  Math.max(0, Math.min(spectrogram.bins - 1, Math.round(hz / spectrogram.frequencyStepHz)));

/** Rows of detail worth aiming for in the band being displayed. */
const TARGET_ROWS = 300;

/**
 * An FFT size that fills the displayed band with detail.
 *
 * Frequency resolution is `sampleRate / fftSize`, and cropping the picture to a narrow
 * band does not improve it — zooming from 4 kHz to 250 Hz on an 8 kHz recording with a
 * 1024-point window leaves 33 rows stretched over the whole height, which looks like
 * detail and is not. Sizing the window to the band being shown is what actually resolves
 * a rumble's structure.
 *
 * Bounded at both ends: too small cannot separate low-frequency calls at all, too large
 * costs more time than the picture is worth.
 */
export function suggestedFftSize(sampleRateHz: number, maxHz?: number): number {
  const band = maxHz && maxHz > 0 ? maxHz : sampleRateHz / 2;
  const ideal = (sampleRateHz * TARGET_ROWS) / band;
  const size = 2 ** Math.ceil(Math.log2(ideal));
  return Math.max(1024, Math.min(8192, size));
}

/**
 * The frequency below which most of a clip's energy sits.
 *
 * Used to choose what to show first. A3EM records at low rates for low-frequency work,
 * so an honest full-range view of an elephant deployment is a black rectangle with
 * everything crushed into the bottom fifth — accurate, and useless as a first look.
 * Measuring where the energy actually is lets a bird recording open at full bandwidth
 * and a rumble recording open zoomed in, without either being a special case.
 */
export function energyCeilingHz(spectrogram: Spectrogram, fraction = 0.95): number {
  if (spectrogram.columns === 0) return 0;

  // Summed in the linear domain; averaging decibels would let the vast quiet region
  // outvote the narrow band that actually carries the signal.
  const perBin = new Float64Array(spectrogram.bins);
  let total = 0;
  for (let column = 0; column < spectrogram.columns; column++) {
    for (let bin = 0; bin < spectrogram.bins; bin++) {
      const power = 10 ** (spectrogram.data[column * spectrogram.bins + bin] / 10);
      perBin[bin] += power;
      total += power;
    }
  }
  if (total <= 0) return spectrogram.bins * spectrogram.frequencyStepHz;

  let running = 0;
  for (let bin = 0; bin < spectrogram.bins; bin++) {
    running += perBin[bin];
    if (running >= total * fraction) return (bin + 1) * spectrogram.frequencyStepHz;
  }
  return spectrogram.bins * spectrogram.frequencyStepHz;
}

// ---------------------------------------------------------------------------

const isPowerOfTwo = (value: number) => value > 0 && (value & (value - 1)) === 0;

function hann(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return window;
}

/** In-place iterative radix-2 Cooley-Tukey. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    const half = length >> 1;

    for (let start = 0; start < n; start += length) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }
  }
}
