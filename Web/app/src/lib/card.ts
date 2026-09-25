import {
  CONFIG_FILE_NAME,
  LEGACY_CONFIG_FILE_NAME,
  DEVICE_INFO_FILE_NAME,
  SELF_TEST_RESULTS_FILE_NAME,
  readCardLayout,
  type CardLayout,
} from '@a3em/config-schema';

/**
 * Reading and writing an A3EM SD card through the File System Access API.
 *
 * The directory handle is kept in IndexedDB so a card reconnects with one click across
 * sessions instead of re-prompting on every launch. Browsers still require a user
 * gesture to re-grant permission, so a stored handle gets us to "click to reconnect"
 * rather than "find the card again".
 *
 * Where the API is unavailable — Safari and Firefox — everything here degrades to
 * download and upload, which is fully functional and one manual step. That is a
 * capability difference the UI states up front rather than letting someone discover it
 * at the moment they need to write a card.
 */

export const CARD_ACCESS_SUPPORTED =
  typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/**
 * Brave is Chromium, but turns the File System Access API off by default. It is one flag away,
 * which is worth saying rather than lumping Brave in with Safari and Firefox.
 */
export const IS_BRAVE = typeof navigator !== 'undefined' && 'brave' in navigator;

const DB_NAME = 'a3em';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'card-directory';

// ---------------------------------------------------------------------------
// Handle persistence
// ---------------------------------------------------------------------------

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function rememberCardHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, HANDLE_KEY));
}

export async function forgetCardHandle(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(HANDLE_KEY));
}

export async function recallCardHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (!CARD_ACCESS_SUPPORTED) return null;
  try {
    return (await withStore<FileSystemDirectoryHandle | undefined>('readonly', (store) => store.get(HANDLE_KEY))) ?? null;
  } catch {
    return null;
  }
}

type PermissionMode = 'read' | 'readwrite';

/** Whether we already hold permission, without prompting. */
export async function hasPermission(handle: FileSystemDirectoryHandle, mode: PermissionMode): Promise<boolean> {
  const queryable = handle as FileSystemDirectoryHandle & {
    queryPermission?: (descriptor: { mode: PermissionMode }) => Promise<PermissionState>;
  };
  if (!queryable.queryPermission) return true;
  return (await queryable.queryPermission({ mode })) === 'granted';
}

/** Requests permission. Must be called from a user gesture or the browser refuses. */
export async function requestPermission(handle: FileSystemDirectoryHandle, mode: PermissionMode): Promise<boolean> {
  const requestable = handle as FileSystemDirectoryHandle & {
    requestPermission?: (descriptor: { mode: PermissionMode }) => Promise<PermissionState>;
  };
  if (!requestable.requestPermission) return true;
  return (await requestable.requestPermission({ mode })) === 'granted';
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

export class CardAccessError extends Error {
  constructor(message: string, readonly recoverable = true) {
    super(message);
    this.name = 'CardAccessError';
  }
}

export async function pickCard(): Promise<FileSystemDirectoryHandle> {
  if (!CARD_ACCESS_SUPPORTED) {
    throw new CardAccessError(
      'This browser cannot open a folder directly. Use Chrome, Edge, or Opera, or download the ' +
        'configuration file and copy it to the card yourself.',
      false,
    );
  }
  const picker = window as unknown as {
    showDirectoryPicker: (options?: { mode?: PermissionMode; id?: string }) => Promise<FileSystemDirectoryHandle>;
  };
  const handle = await picker.showDirectoryPicker({ mode: 'readwrite', id: 'a3em-card' });
  await rememberCardHandle(handle);
  return handle;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface CardEntry {
  path: string;
  sizeBytes: number;
  handle: FileSystemFileHandle;
}

export interface ScanProgress {
  /**
   * Which part of opening a card is running.
   *
   * A 512 GB card spends real time in all three, and the last one blocks the main thread,
   * so the UI has to say which is happening rather than leaving a frozen page.
   */
  phase: 'scanning' | 'reading' | 'parsing';
  filesSeen: number;
  currentDirectory: string;
  /** Logs read so far and in total, during `reading`. */
  logsRead?: number;
  logsTotal?: number;
  /** Bytes of log text read so far, which is what makes `parsing` slow. */
  logBytes?: number;
}

/**
 * Walks the card, collecting every file's path and size.
 *
 * Deliberately does not read any content: a full card can hold hundreds of thousands of
 * files, and the layout, counts, and time range all come from names and sizes alone.
 *
 * Directories that cannot be read are recorded rather than aborting the walk. A card
 * with a damaged region should still tell you everything about the parts that survived
 * — the reported failure mode is a transfer that stops at the first bad file and looks
 * like it finished.
 */
/**
 * The card's folder itself cannot be opened: the card was taken out, or erased and renamed — as
 * preparing it does — or access to it was withdrawn. Nothing on the card was read, so this is
 * not a finding about the card, as an unreadable file within it would be.
 */
export class CardGoneError extends Error {
  constructor(readonly folder: string) {
    super(`${folder} can no longer be opened`);
  }
}

export async function scanCard(
  root: FileSystemDirectoryHandle,
  options: { onProgress?: (progress: ScanProgress) => void; signal?: AbortSignal } = {},
): Promise<{ entries: CardEntry[]; unreadable: Array<{ path: string; reason: string }> }> {
  const entries: CardEntry[] = [];
  const unreadable: Array<{ path: string; reason: string }> = [];
  let filesSeen = 0;

  const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    if (options.signal?.aborted) throw new DOMException('Scan canceled', 'AbortError');
    options.onProgress?.({ phase: 'scanning', filesSeen, currentDirectory: prefix || '/' });

    let iterator: AsyncIterableIterator<[string, FileSystemHandle]>;
    try {
      iterator = (directory as unknown as {
        entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      }).entries();
    } catch (error) {
      if (!prefix) throw new CardGoneError(root.name);
      unreadable.push({ path: prefix, reason: describeError(error) });
      return;
    }

    const children: Array<[string, FileSystemHandle]> = [];
    try {
      for await (const child of iterator) children.push(child);
    } catch (error) {
      if (!prefix && !children.length) throw new CardGoneError(root.name);
      unreadable.push({ path: prefix || '/', reason: describeError(error) });
      return;
    }

    for (const [name, handle] of children) {
      if (name.startsWith('.')) continue; // .DS_Store, .Spotlight-V100, and friends
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        await walk(handle as FileSystemDirectoryHandle, path);
      } else {
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          entries.push({ path, sizeBytes: file.size, handle: handle as FileSystemFileHandle });
          filesSeen++;
        } catch (error) {
          // Metadata unreadable is itself a finding: this is what a failing card looks like.
          unreadable.push({ path, reason: describeError(error) });
        }
      }
    }
  };

  await walk(root, '');
  options.onProgress?.({ phase: 'scanning', filesSeen, currentDirectory: '' });
  return { entries, unreadable };
}

async function readTextAt(root: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    const handle = await root.getFileHandle(name);
    return await (await handle.getFile()).text();
  } catch {
    return null; // absent is normal: legacy cards carry none of the newer artifacts
  }
}

export interface CardContents {
  layout: CardLayout;
  /**
   * Every file with its handle, so the integrity check and the copy can open them
   * without walking the card again.
   */
  entries: CardEntry[];
  unreadable: Array<{ path: string; reason: string }>;
  configText: string | null;
  deviceInfoText: string | null;
  selfTestText: string | null;
  /** Every log on the card, root, and per-directory, ready to be stitched. */
  logs: Array<{ name: string; text: string }>;
}

/**
 * Reads everything the app needs to describe a card.
 *
 * Log files are read in full because they are small and carry the deployment's history;
 * audio and IMU are left on disk and opened only when something asks for one.
 */
export async function readCard(
  root: FileSystemDirectoryHandle,
  options: { onProgress?: (progress: ScanProgress) => void; signal?: AbortSignal } = {},
): Promise<CardContents> {
  const { entries, unreadable } = await scanCard(root, options);
  const layout = readCardLayout(entries.map(({ path, sizeBytes }) => ({ path, sizeBytes })));

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const logs: Array<{ name: string; text: string }> = [];
  const logFiles = layout.files.filter((file) => file.kind === 'log');
  let logBytes = 0;
  for (const file of logFiles) {
    const entry = byPath.get(file.path);
    if (!entry) continue;
    try {
      const text = await (await entry.handle.getFile()).text();
      logBytes += text.length;
      logs.push({ name: file.path, text });
    } catch (error) {
      unreadable.push({ path: file.path, reason: describeError(error) });
    }
    options.onProgress?.({
      phase: 'reading',
      filesSeen: entries.length,
      currentDirectory: file.path,
      logsRead: logs.length,
      logsTotal: logFiles.length,
      logBytes,
    });
  }

  return {
    layout,
    entries,
    unreadable,
    // A card prepared before the configuration file was renamed holds the legacy name, which the
    // recorder reads when the current one is absent. (Chrome on Windows cannot read that one.)
    configText: (await readTextAt(root, CONFIG_FILE_NAME)) ?? (await readTextAt(root, LEGACY_CONFIG_FILE_NAME)),
    deviceInfoText: await readTextAt(root, DEVICE_INFO_FILE_NAME),
    selfTestText: await readTextAt(root, SELF_TEST_RESULTS_FILE_NAME),
    logs,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Writes the configuration file to the card.
 *
 * Written whole, then closed: a partial config is worse than none, because the firmware
 * would run on whatever it managed to parse plus built-in defaults for the rest.
 */
export async function writeConfig(root: FileSystemDirectoryHandle, text: string): Promise<void> {
  if (!(await requestPermission(root, 'readwrite'))) {
    throw new CardAccessError('Permission to write to the card was declined.');
  }
  const handle = await root.getFileHandle(CONFIG_FILE_NAME, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
  } finally {
    await writable.close();
  }
  /*
    Read back, and compare.

    A card that was pulled, or a folder handle left over from a card no longer mounted, can
    fail in ways that still let the write call return. "Written to the card" should mean the
    file on the card now says exactly this.
  */
  const back = await (await handle.getFile()).text();
  if (back !== text) {
    throw new CardAccessError(
      'The configuration read back from the card does not match what was written. Reinsert the card and try again.',
    );
  }
  // One under the legacy name would sit beside it holding other settings. Best effort: the
  // recorder reads the current name first, and Chrome on Windows cannot remove a .cfg file.
  await root.removeEntry(LEGACY_CONFIG_FILE_NAME).catch(() => undefined);
}

/** Fallback for browsers without the File System Access API. */
export function downloadConfig(text: string, fileName = CONFIG_FILE_NAME): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function describeError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
