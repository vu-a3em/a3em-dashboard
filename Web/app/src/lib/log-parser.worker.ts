/// <reference lib="webworker" />
import { parseLogs } from '@a3em/config-schema';

/**
 * Parses device logs off the main thread.
 *
 * A full deployment's log runs to several megabytes and takes seconds to work through.
 * On the main thread that is a frozen page — no repaint, no scrolling, no cancelling —
 * which is exactly what a field user reads as a crash. The parse is pure text-in,
 * data-out, so it moves here whole.
 */
export interface ParseRequest {
  id: number;
  files: Array<{ name: string; text: string }>;
  activation: number | null;
}

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, files, activation } = event.data;
  try {
    const parsed = parseLogs(files, activation === null ? {} : { activation });
    (self as unknown as Worker).postMessage({ id, parsed });
  } catch (error) {
    (self as unknown as Worker).postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
