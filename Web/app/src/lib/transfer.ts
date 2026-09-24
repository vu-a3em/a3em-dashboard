import {
  judgeImuFile,
  judgeWavFile,
  WAV_HEADER_BYTES,
  type CardFile,
  type RecordingVerdict,
  type WavHeaderRepair,
} from '@a3em/config-schema';
import type { CardEntry } from './card';

/**
 * Checking a card's contents and copying them off it.
 *
 * The reported failure is specific and worth restating: a bulk copy hits a corrupt file,
 * stops, and looks like it finished — so the researcher believes the transfer completed
 * when it did not. Everything here is built around not doing that. A file that cannot be
 * read is recorded and the copy carries on, and the run ends with an explicit account of
 * what was skipped.
 */

export interface FileCheck {
  path: string;
  kind: CardFile['kind'];
  sizeBytes: number;
  verdict: RecordingVerdict;
  detail: string | null;
  /** Set for files whose audio survived and only needs its header rewritten. */
  repair?: WavHeaderRepair;
}

export interface IntegrityReport {
  checked: number;
  /** Files whose recordings are lost. */
  problems: FileCheck[];
  /**
   * Files that are intact but were never closed — separated from `problems` because the
   * two demand opposite reactions. One is a loss to report; the other is a repair to run.
   */
  recoverable: FileCheck[];
  byVerdict: Record<RecordingVerdict, number>;
}

/**
 * Structural check over every recording, from headers and sizes alone.
 *
 * Deliberately does not read whole files: a full card holds hundreds of thousands, and
 * the structural faults — a zero-length clip, a truncated WAV, a clip the device never
 * closed — are all visible from the first 44 bytes. Media that fails only on a full read
 * is caught during the copy instead, which has to read everything anyway.
 *
 * Every verdict comes from `judgeWavFile`/`judgeImuFile`, which are tested against
 * fixtures built byte-for-byte from the firmware's header writer.
 */
export async function checkIntegrity(
  files: CardFile[],
  entries: CardEntry[],
  options: {
    /**
     * Whether this card came from firmware that wrote the WAV data chunk correctly.
     *
     * Required rather than defaulted on purpose. Guessing this wrong in the strict
     * direction condemns every recording on a legacy card, and a default is exactly
     * how that happened once already — so the caller has to say which card it holds.
     */
    correctWavChunkSize: boolean;
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
  },
): Promise<IntegrityReport> {
  const handles = new Map(entries.map((entry) => [entry.path, entry.handle]));
  // The self-test capture joins the check even though it is not a deployment recording:
  // it is still a WAV on the card, and a card being verified should have every WAV on it
  // verified. It is only the deployment COUNTS it must stay out of.
  const recordings = files.filter(
    (file) => file.kind === 'audio' || file.kind === 'imu' || file.kind === 'self-test-clip',
  );
  const problems: FileCheck[] = [];
  const recoverable: FileCheck[] = [];
  const byVerdict: Record<RecordingVerdict, number> = {
    ok: 0,
    empty: 0,
    unfinalized: 0,
    truncated: 0,
    malformed: 0,
    blank: 0,
    unreadable: 0,
  };

  for (const [index, file] of recordings.entries()) {
    if (options.signal?.aborted) throw new DOMException('Check canceled', 'AbortError');
    if (index % 50 === 0) options.onProgress?.(index, recordings.length);

    const check = await checkFile(file, handles.get(file.path), options.correctWavChunkSize);
    byVerdict[check.verdict]++;
    if (check.verdict === 'unfinalized') recoverable.push(check);
    else if (check.verdict !== 'ok') problems.push(check);
  }

  options.onProgress?.(recordings.length, recordings.length);
  return { checked: recordings.length, problems, recoverable, byVerdict };
}

async function checkFile(
  file: CardFile,
  handle: FileSystemFileHandle | undefined,
  correctWavChunkSize: boolean,
): Promise<FileCheck> {
  const base = { path: file.path, kind: file.kind, sizeBytes: file.sizeBytes };

  if (file.kind === 'imu') return { ...base, ...judgeImuFile(file.sizeBytes) };

  if (!handle) {
    return { ...base, verdict: 'unreadable', detail: 'No longer present on the card.' };
  }
  if (!file.path.toLowerCase().endsWith('.wav')) {
    // Opus and anything else the device may write later. Size alone is all we can say.
    return file.sizeBytes === 0
      ? { ...base, verdict: 'empty', detail: 'Zero bytes — nothing was written into it.' }
      : { ...base, verdict: 'ok', detail: null };
  }

  try {
    const header = file.sizeBytes === 0
      ? null
      : new Uint8Array(await (await handle.getFile()).slice(0, WAV_HEADER_BYTES).arrayBuffer());
    return { ...base, ...judgeWavFile(file.sizeBytes, header, { correctWavChunkSize }) };
  } catch (error) {
    return { ...base, verdict: 'unreadable', detail: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export interface CopyProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  currentPath: string;
}

export interface CopyResult {
  copied: number;
  bytesCopied: number;
  /** Files that could not be copied, with why. The point of the whole exercise. */
  skipped: Array<{ path: string; reason: string }>;
  /** Files already present at the destination with the same size. */
  alreadyPresent: number;
  canceled: boolean;
}

/**
 * Copies a card to a chosen folder, continuing past failures.
 *
 * Resumable in the plain sense: a file already at the destination with the same size is
 * left alone, so re-running after a failure or an interruption picks up where it stopped
 * rather than starting over.
 */
export async function copyCard(
  entries: CardEntry[],
  destination: FileSystemDirectoryHandle,
  options: {
    onProgress?: (progress: CopyProgress) => void;
    signal?: AbortSignal;
    /**
     * Destination path for a source path, where the two differ.
     *
     * Applying a clock correction to the COPY rather than to the card is the safer half of
     * the same job: the original names stay exactly as the device wrote them, so there is
     * nothing to undo and nothing to lose if the correction later turns out to be wrong.
     * Copy again with a different correction and you get a different copy.
     */
    renameTo?: ReadonlyMap<string, string>;
  } = {},
): Promise<CopyResult> {
  const bytesTotal = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const result: CopyResult = { copied: 0, bytesCopied: 0, skipped: [], alreadyPresent: 0, canceled: false };
  const directoryCache = new Map<string, FileSystemDirectoryHandle>();

  for (const [index, entry] of entries.entries()) {
    if (options.signal?.aborted) {
      result.canceled = true;
      break;
    }
    options.onProgress?.({
      filesDone: index,
      filesTotal: entries.length,
      bytesDone: result.bytesCopied,
      bytesTotal,
      currentPath: entry.path,
    });

    try {
      const segments = (options.renameTo?.get(entry.path) ?? entry.path).split('/');
      const name = segments.pop()!;
      const parent = await ensureDirectory(destination, segments, directoryCache);

      // Skip anything already copied at the same size, so a re-run resumes.
      try {
        const existing = await (await parent.getFileHandle(name)).getFile();
        if (existing.size === entry.sizeBytes) {
          result.alreadyPresent++;
          result.bytesCopied += entry.sizeBytes;
          continue;
        }
      } catch {
        // Not there yet, which is the normal case.
      }

      const source = await entry.handle.getFile();
      const target = await parent.getFileHandle(name, { create: true });
      const writable = await target.createWritable();
      // No try/finally closing the writable: pipeTo closes it on both paths, and closing
      // an already-closed writable throws over the original error and hides what actually
      // went wrong. The outer catch records the failure and moves to the next file.
      await source.stream().pipeTo(writable);
      result.copied++;
      result.bytesCopied += entry.sizeBytes;
    } catch (error) {
      // The whole point: record it and keep going.
      result.skipped.push({ path: entry.path, reason: describeError(error) });
    }
  }

  options.onProgress?.({
    filesDone: entries.length,
    filesTotal: entries.length,
    bytesDone: result.bytesCopied,
    bytesTotal,
    currentPath: '',
  });
  return result;
}

async function ensureDirectory(
  root: FileSystemDirectoryHandle,
  segments: string[],
  cache: Map<string, FileSystemDirectoryHandle>,
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  let path = '';
  for (const segment of segments) {
    path = path ? `${path}/${segment}` : segment;
    const cached = cache.get(path);
    if (cached) {
      current = cached;
      continue;
    }
    current = await current.getDirectoryHandle(segment, { create: true });
    cache.set(path, current);
  }
  return current;
}

/** A manifest of what was skipped, to save alongside the copy. */
export function buildSkipManifest(result: CopyResult, cardName: string): string {
  const lines = [
    `A3EM copy report — ${cardName}`,
    `Files copied: ${result.copied}`,
    `Already present: ${result.alreadyPresent}`,
    `Skipped: ${result.skipped.length}`,
    result.canceled ? 'Run was canceled before finishing.' : '',
    '',
  ];
  for (const skip of result.skipped) lines.push(`${skip.path}\t${skip.reason}`);
  return lines.filter((line) => line !== undefined).join('\n') + '\n';
}

function describeError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Repairing clips the device never closed
// ---------------------------------------------------------------------------

export interface RepairResult {
  repaired: number;
  failed: Array<{ path: string; reason: string }>;
}

/**
 * Finishes the job `storage_close_wav_audio()` never got to.
 *
 * An interrupted clip keeps the placeholder lengths the firmware wrote when it opened
 * the file, so players see sixteen bytes where megabytes of audio actually sit. Writing
 * the two real lengths makes the recording playable again; nothing else about the file
 * changes, and the audio is never touched.
 *
 * Operates on the COPY, not on the card. Repairing in place would mean writing to the
 * one surviving instance of data that has already survived one interruption, and if the
 * repair were interrupted in turn there would be nothing to fall back on. Copy first,
 * then mend the copy.
 */
export async function repairWavHeaders(
  destination: FileSystemDirectoryHandle,
  targets: Array<{ path: string; repair: WavHeaderRepair }>,
  options: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<RepairResult> {
  const result: RepairResult = { repaired: 0, failed: [] };

  for (const [index, target] of targets.entries()) {
    if (options.signal?.aborted) break;
    options.onProgress?.(index, targets.length);

    try {
      const segments = target.path.split('/');
      const name = segments.pop()!;
      let directory = destination;
      for (const segment of segments) directory = await directory.getDirectoryHandle(segment);

      const handle = await directory.getFileHandle(name);
      // The copy must be the file we judged. A size mismatch means we are looking at
      // something else, and patching a length into the wrong file would corrupt it.
      const actual = (await handle.getFile()).size;
      if (actual !== target.repair.dataSize + WAV_HEADER_BYTES) {
        result.failed.push({
          path: target.path,
          reason: `Copy is ${actual.toLocaleString()} bytes, not the ${(
            target.repair.dataSize + WAV_HEADER_BYTES
          ).toLocaleString()} that was checked — left untouched.`,
        });
        continue;
      }

      const writable = await handle.createWritable({ keepExistingData: true });
      const field = new ArrayBuffer(4);
      const view = new DataView(field);
      view.setUint32(0, target.repair.riffSize, true);
      await writable.write({ type: 'write', position: 4, data: field });
      view.setUint32(0, target.repair.dataSize, true);
      await writable.write({ type: 'write', position: 40, data: field });
      await writable.close();
      result.repaired++;
    } catch (error) {
      result.failed.push({ path: target.path, reason: describeError(error) });
    }
  }

  options.onProgress?.(targets.length, targets.length);
  return result;
}
