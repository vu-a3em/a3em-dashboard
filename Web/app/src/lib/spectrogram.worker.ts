/// <reference lib="webworker" />
import { computeSpectrogram, type SpectrogramOptions } from '@a3em/config-schema';

/**
 * Spectrograms, off the main thread.
 *
 * A 60-second clip at the narrowest band takes an 8192-point window over a thousand
 * columns — around 430ms of solid arithmetic, and longer at higher sample rates. Run on
 * the main thread that is a locked page: no repaint, no scrolling, and no chance to draw
 * so much as a "working" message, because the work sat inside a render.
 */
export interface SpectrogramRequest {
  id: number;
  samples: Int16Array;
  options: SpectrogramOptions;
}

self.onmessage = (event: MessageEvent<SpectrogramRequest>) => {
  const { id, samples, options } = event.data;
  try {
    (self as unknown as Worker).postMessage({ id, spectrogram: computeSpectrogram(samples, options) });
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
