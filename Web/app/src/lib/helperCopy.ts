import type { WavHeaderRepair } from '@a3em/config-schema';
import type { CardEntry } from './card';
import { copyViaHelper, type HelperCopyFile } from './helper';
import type { CopyProgress, CopyResult } from './transfer';

/*
  Kept out of `transfer.ts` on purpose.

  A guard in `tools/check-helper-isolation.mjs` forbids the card path from importing
  anything from the helper, so that reading and writing a card cannot come to depend on an
  extension most people never install. This file is the helper's half of copying, and a view
  that already knows whether the helper answered chooses between the two.
*/

/**
 * Copying through the card helper instead of the browser.
 *
 * Same job, same result, different hands. Chrome's File System Access API writes each file
 * to a `.crswap` temporary beside the target and renames it on close, so on Windows a card
 * of tens of thousands of recordings pays several filesystem operations plus a flush, tens
 * of thousands of times, all crossing the browser's IPC and permission boundary. The helper
 * is an ordinary sequential read and write.
 *
 * What stays here is every decision: which files are recordings, what each is called after a
 * clock correction, and what to add to one the device never closed. Those rules live in the
 * schema package with their tests, and the helper is handed the answers rather than asked to
 * work them out a second time.
 */
export async function copyCardViaHelper(
  entries: CardEntry[],
  volume: string,
  destination: string,
  options: {
    onProgress?: (progress: CopyProgress) => void;
    signal?: AbortSignal;
    renameTo?: ReadonlyMap<string, string>;
    additions?: ReadonlyMap<string, { bytes: Uint8Array; replaces: boolean; summary: string }>;
    /**
     * Headers to mend in the copies, by source path.
     *
     * The browser path does this in a second pass over the destination; here it rides along
     * with the copy, because the page has no handle to a folder the helper chose.
     */
    repairs?: ReadonlyMap<string, WavHeaderRepair>;
    report?: string;
  } = {},
): Promise<CopyResult> {
  const bytesTotal = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const summaries = new Map<string, string>();
  const files: HelperCopyFile[] = entries.map((entry) => {
    const addition = options.additions?.get(entry.path);
    if (addition) summaries.set(entry.path, addition.summary);
    const repair = options.repairs?.get(entry.path);
    return {
      from: entry.path,
      to: options.renameTo?.get(entry.path) ?? entry.path,
      bytes: entry.sizeBytes,
      ...(addition ? { append: base64(addition.bytes), replace: addition.replaces } : {}),
      ...(repair ? { patch: headerPatch(repair) } : {}),
    };
  });

  const report = await copyViaHelper(volume, destination, files, {
    report: options.report,
    signal: options.signal,
    onProgress: (progress) => {
      // The helper counts bytes, which is what it can measure while it works; the file
      // count is inferred from them so the bar and the caption agree.
      const bytesDone = progress.bytesCopied ?? 0;
      const share = bytesTotal ? bytesDone / bytesTotal : 0;
      options.onProgress?.({
        filesDone: Math.min(entries.length, Math.round(share * entries.length)),
        filesTotal: entries.length,
        bytesDone,
        bytesTotal,
        currentPath: progress.note ?? '',
      });
    },
  });

  options.onProgress?.({
    filesDone: entries.length,
    filesTotal: entries.length,
    bytesDone: report.bytesCopied,
    bytesTotal,
    currentPath: '',
  });
  return {
    copied: report.copied,
    bytesCopied: report.bytesCopied,
    alreadyPresent: report.alreadyPresent,
    canceled: report.canceled,
    skipped: report.skipped ?? [],
    recovered: (report.recovered ?? []).map((path) => ({ path, summary: summaries.get(path) ?? 'recovered' })),
  };
}

/** The two little-endian uint32 writes that finalize a WAV, as the firmware does them. */
function headerPatch(repair: WavHeaderRepair): Array<{ offset: number; bytes: string }> {
  const field = (value: number) => {
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setUint32(0, value, true);
    return base64(new Uint8Array(buffer));
  };
  return [
    { offset: 4, bytes: field(repair.riffSize) },
    { offset: 40, bytes: field(repair.dataSize) },
  ];
}

/** Go decodes a `[]byte` field from base64, so that is what an addition travels as. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: spreading a megabyte of bytes into String.fromCharCode overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
