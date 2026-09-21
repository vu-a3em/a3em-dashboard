import { computeSpectrogram, type SpectrogramOptions } from '@a3em/config-schema';
import type { SpectrogramRequest } from './spectrogram.worker';

type Spectrogram = ReturnType<typeof computeSpectrogram>;

/**
 * `computeSpectrogram`, run off the main thread.
 *
 * One worker for the app, as with the log parser: the samples are cloned into it on each
 * request, which costs a couple of milliseconds against hundreds spent computing.
 *
 * Falls back to computing in place where workers are unavailable — blocking, but a
 * blocked page beats a clip that cannot be inspected at all.
 */
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  { resolve: (value: Spectrogram) => void; reject: (error: Error) => void }
>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./spectrogram.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  worker.onmessage = (event: MessageEvent<{ id: number; spectrogram?: Spectrogram; error?: string }>) => {
    const waiting = pending.get(event.data.id);
    if (!waiting) return;
    pending.delete(event.data.id);
    if (event.data.error !== undefined) waiting.reject(new Error(event.data.error));
    else waiting.resolve(event.data.spectrogram!);
  };
  // A dead worker would otherwise leave every caller waiting on a promise that never settles.
  worker.onerror = () => {
    for (const waiting of pending.values()) waiting.reject(new Error('The spectrogram worker stopped'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function computeSpectrogramAsync(
  samples: Int16Array,
  options: SpectrogramOptions,
): Promise<Spectrogram> {
  const active = ensureWorker();
  if (!active) return Promise.resolve(computeSpectrogram(samples, options));

  const id = nextId++;
  const request: SpectrogramRequest = { id, samples, options };
  return new Promise<Spectrogram>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    active.postMessage(request);
  });
}
