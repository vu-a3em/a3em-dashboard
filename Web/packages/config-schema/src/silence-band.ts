import { maxFrequencyCeilingHz } from './firmware-constants.js';

/**
 * The frequency band the silence filter ACTUALLY judges, as opposed to the one entered.
 *
 * `minFrequencyHz` and `maxFrequencyHz` are not a recording band — they choose which FFT
 * bins `silence_filter_is_silence()` sums when deciding whether a buffer is worth writing
 * to the card. Bins are coarse (7.8 Hz or 11.7 Hz wide depending on sample rate), so the
 * band the device works with is a rounded version of the one typed in. The low edge lands
 * on the CENTRE of the first bin whose upper edge reaches the request, which puts it up to
 * half a bin either side of the number entered — 250 Hz at 48 kHz judges from 246.1 Hz,
 * while 100 Hz at the same rate judges from 105.5 Hz.
 *
 * That difference matters more than its size suggests, because a buffer judged silent is
 * never written at all — `active_main.c` drops it at three separate call sites rather than
 * trimming it — and nothing is logged when that happens. A deployment that discarded the
 * signal looks exactly like a quiet animal. Showing the real band is the cheapest way to
 * make that visible before the card is written rather than after it comes back.
 *
 * Mirrors `compute_min_and_max_bins()` and the FFT-length ladder in
 * `a3em-firmware/src/ai/silence.c`, including its float32 arithmetic.
 */

/** silence.c: MAX_INPUT_LEN. An FFT longer than this disables the filter outright. */
export const SILENCE_FFT_MAX_INPUT_LEN = 4096;

/**
 * silence.c `silence_filter_initialize()`:
 *
 *   fft_length = (rate <= 8000) ? 1024 : ((rate <= 24000) ? 2048 : 4096);
 *
 * Chosen to hold the bin width between 7.81 Hz and 11.72 Hz at every offered rate.
 */
export function silenceFftLength(sampleRateHz: number): number {
  if (sampleRateHz <= 8000) return 1024;
  if (sampleRateHz <= 24000) return 2048;
  return 4096;
}

export interface SilenceBand {
  fftLength: number;
  binWidthHz: number;
  /** First and last FFT bin summed, inclusive. */
  minBin: number;
  maxBin: number;
  /** Centre frequency of `minBin` — the real low edge of what is judged. */
  actualMinHz: number;
  /** Centre frequency of `maxBin` — the real high edge. */
  actualMaxHz: number;
  /**
   * False when the firmware refuses to arm the filter, in which case NOTHING is ever
   * treated as silence and every clip is kept. Fail-safe, but worth surfacing: the user
   * asked for silence detection and did not get it.
   */
  usable: boolean;
}

/**
 * What the device will really judge, given a requested band.
 *
 * `maxFrequencyHz` of zero means "up to the ceiling" — `runtime_config.c` rewrites it
 * before the filter ever sees it, so the same substitution happens here.
 */
export function silenceBand(
  sampleRateHz: number,
  minFrequencyHz: number,
  maxFrequencyHz: number,
): SilenceBand {
  const fftLength = silenceFftLength(sampleRateHz);
  // float32 throughout, matching the firmware. Every offered rate divides evenly here, so
  // this changes no result today — it is kept so a future rate that does not divide evenly
  // rounds the way the device rounds rather than the way JavaScript would.
  const binWidthHz = Math.fround(sampleRateHz / fftLength);
  const halfBinWidthHz = Math.fround(0.5 * binWidthHz);

  const ceiling = maxFrequencyCeilingHz(sampleRateHz);
  // runtime_config.c: `if (!max_frequency || max_frequency > nyquist_margin) max = nyquist_margin`
  const high = !maxFrequencyHz || maxFrequencyHz > ceiling ? ceiling : maxFrequencyHz;

  const unusable = (): SilenceBand => ({
    fftLength,
    binWidthHz,
    minBin: 0,
    maxBin: 0,
    actualMinHz: 0,
    actualMaxHz: 0,
    usable: false,
  });

  // silence.c rejects an inverted or empty range before computing any bins.
  if (minFrequencyHz >= high) return unusable();
  if (fftLength > SILENCE_FFT_MAX_INPUT_LEN) return unusable();

  const numBins = fftLength / 2 - 1;
  let minBin = 1;
  let maxBin = 1;
  for (let bin = 1; bin < numBins; ++bin) {
    const centre = Math.fround(binWidthHz * bin);
    if (Math.fround(centre + halfBinWidthHz) < minFrequencyHz) {
      minBin = maxBin = bin + 1;
    }
    if (Math.fround(centre - halfBinWidthHz) < high) {
      maxBin = bin;
    }
  }

  /*
    The firmware also rejects `min_bin > max_bin` here. That branch is unreachable given
    the `min >= max` check above — if a bin satisfies the min condition it necessarily
    satisfies the max condition too, so `max_bin` is never left below `min_bin` — but it
    is mirrored anyway so this function stays a faithful description of the device rather
    than a description of what we believe the device reduces to.
  */
  if (minBin > maxBin) return unusable();

  return {
    fftLength,
    binWidthHz,
    minBin,
    maxBin,
    actualMinHz: Math.fround(binWidthHz * minBin),
    actualMaxHz: Math.fround(binWidthHz * maxBin),
    usable: true,
  };
}
