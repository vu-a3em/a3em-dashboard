import { parseLogs, type ParsedLog } from '@a3em/config-schema';
import type { ParseRequest } from './log-parser.worker';

/**
 * `parseLogs`, run off the main thread.
 *
 * One worker is shared across the app and kept alive: spinning one up per call costs more
 * than the parse for the small per-activation slices, and the module has no state to
 * carry between calls. Requests are tagged so several can be in flight without their
 * replies being confused for one another.
 *
 * Falls back to parsing in place where workers are unavailable. That path blocks, but a
 * blocked page beats a page that cannot read the card at all.
 */
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (log: ParsedLog) => void; reject: (error: Error) => void }>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./log-parser.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  worker.onmessage = (event: MessageEvent<{ id: number; parsed?: ParsedLog; error?: string }>) => {
    const { id, parsed, error } = event.data;
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if (error !== undefined) waiting.reject(new Error(error));
    else waiting.resolve(parsed!);
  };
  // A worker that dies takes every in-flight request with it. Failing them explicitly
  // means the caller shows an error rather than waiting on a promise that never settles.
  worker.onerror = () => {
    for (const waiting of pending.values()) waiting.reject(new Error('The log reader stopped unexpectedly'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function parseLogsAsync(
  files: Array<{ name: string; text: string }>,
  options: { activation?: number | null } = {},
): Promise<ParsedLog> {
  const active = ensureWorker();
  if (!active) return Promise.resolve(parseLogs(files, options));

  const id = nextId++;
  const request: ParseRequest = { id, files, activation: options.activation ?? null };
  return new Promise<ParsedLog>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    active.postMessage(request);
  });
}
