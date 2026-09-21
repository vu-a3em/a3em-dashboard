import type { CardGeometry, CompatibilityReport } from '@a3em/config-schema';

/**
 * Talking to the card helper extension.
 *
 * The dashboard works without any of this — the helper is an optional capability, not a
 * dependency, and every function here degrades to "not installed" rather than throwing.
 * That is the whole contract: `useHelper` reports which tier the app is in, and the UI
 * says so up front, the way `CardStatus` already states browser capability rather than
 * letting someone discover it at the moment they need to write a card.
 *
 * The path is page → extension service worker → native host. The page reaches the
 * extension by ID through `externally_connectable`, which Chrome gates against the
 * manifest's origin allowlist before a message is delivered.
 */

/**
 * The published extension ID.
 *
 * Derived from the public key in `deployment.json`, which the extension manifest also
 * carries — so the ID is identical on every machine. An unpacked extension without that
 * key gets an ID derived from its filesystem path, which would differ per developer and
 * make the native host's `allowed_origins` wrong everywhere.
 *
 * Overridable at build time for testing against a differently keyed local build.
 */
export const HELPER_EXTENSION_ID =
  (import.meta.env?.VITE_A3EM_HELPER_EXTENSION_ID as string | undefined) ??
  'felbcgjkphldokgcjildnmnclokfngnh';

/**
 * How long to wait with **no word at all** before giving up.
 *
 * Deliberately an inactivity deadline rather than a total one. Imaging a 128 GB card
 * legitimately runs for half an hour and `fsck` on a damaged card for many minutes, so any
 * fixed total either kills real work or waits absurdly long on a dead helper. The host
 * emits a heartbeat every two seconds during anything slow, so silence — not duration — is
 * what actually indicates a problem.
 */
const SILENCE_TIMEOUT_MS = 20_000;

/** A first `hello` gets a short deadline: an absent extension should not stall the page. */
const HANDSHAKE_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Types mirrored from the host
// ---------------------------------------------------------------------------

export interface HelperVolume {
  id: string;
  label: string | null;
  filesystem: string | null;
  sizeBytes: number;
  mountPoint: string | null;
  allocationUnitBytes: number | null;
  mountable: boolean;
}

export interface HelperDevice {
  id: string;
  node: string;
  sizeBytes: number;
  bus: string;
  partitionScheme: string;
  volumes: HelperVolume[];
  compatibility: CompatibilityReport | null;
}

export interface HelperChallenge {
  token: string;
  /** The host's own description of what it will do. Show this, not our own. */
  description: string;
  expiresAt: number;
}

/**
 * Progress for anything that runs longer than a moment.
 *
 * `bytesCopied` and friends are optional because most long operations cannot say how far
 * along they are — `fsck` reports nothing until it finishes. Those still emit a heartbeat
 * carrying `note` and `elapsedMs`, which is what lets the UI say "still checking, 2m 10s"
 * rather than showing a frozen spinner.
 */
export interface TaskProgress {
  op: string;
  note: string;
  bytesCopied?: number;
  totalBytes?: number;
  badSectors?: number;
  elapsedMs: number;
}

export type HelperFailure = { ok: false; error: string; code: string; detail?: string };

export class HelperError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'HelperError';
  }

  /** True when the helper simply is not installed, which is an ordinary state. */
  get isMissing(): boolean {
    return this.code === 'helper-not-installed' || this.code === 'no-extension';
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface ChromePort {
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (listener: (message: unknown) => void) => void };
  onDisconnect: { addListener: (listener: () => void) => void };
}

interface ChromeRuntime {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response: unknown) => void,
  ) => void;
  connect?: (extensionId: string) => ChromePort;
  lastError?: { message?: string };
}

function runtime(): ChromeRuntime | null {
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return chrome?.runtime?.sendMessage ? chrome.runtime : null;
}

/**
 * Whether this browser *could* run the extension, regardless of whether it does.
 *
 * This deliberately does not test for `chrome.runtime`. Since Chrome 106 that object is
 * **undefined on a page unless some installed extension lists it in
 * `externally_connectable`** — so its absence means "the extension is not installed", not
 * "this browser cannot install it". Conflating the two is backwards in the way that
 * matters: it tells a Chrome user their browser is unsupported at exactly the moment we
 * should be offering them the installer.
 *
 * `navigator.userAgentData` exists only in Chromium browsers, which makes it the honest
 * signal for "Chrome, Edge, or Opera". The File System Access API is checked alongside it
 * because a Chromium build without it cannot do the rest of the card work either.
 */
export function isChromium(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } })
    .userAgentData?.brands;
  if (brands?.length) {
    return brands.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge|Opera/i.test(brand));
  }
  // Older Chromium and any build without userAgentData: fall back to the capability that
  // actually matters, which no non-Chromium browser currently ships.
  return 'showDirectoryPicker' in window;
}

/** True where the extension is installed and listening for this origin. */
export function extensionPresent(): boolean {
  return runtime() !== null;
}

/** A reply before it has been checked: JSON from another process, so nothing is certain. */
interface RawReply {
  ok?: boolean;
  error?: string;
  code?: string;
  detail?: string;
}

let requestCounter = 0;

interface CallOptions {
  /** Milliseconds of silence tolerated before giving up. */
  silenceMs?: number;
  /**
   * Called for each heartbeat this request produces.
   *
   * Supplying it switches the transport to a port, because that is the only way an
   * extension can push anything to a web page.
   */
  onProgress?: (progress: TaskProgress) => void;
}

function unavailable(): HelperError {
  return isChromium()
    ? new HelperError('The A3EM card helper extension is not installed.', 'helper-not-installed')
    : new HelperError(
        'This browser cannot use the card helper. Chrome, Edge, or Opera is required.',
        'no-extension',
      );
}

/** Turns a checked reply into a value, or throws what went wrong. */
function unwrap<T>(response: unknown): T {
  // Typed loosely on purpose rather than as `HelperFailure`, which pins `ok` to `false`
  // and makes a test against `true` a comparison TypeScript rejects. What arrives here is
  // untyped JSON from another process and is either shape until it has been checked.
  const result = response as RawReply;
  if (!result || result.ok !== true) {
    throw new HelperError(
      result?.error ?? 'The card helper failed.',
      result?.code ?? 'unexpected',
      result?.detail,
    );
  }
  return result as T;
}

async function call<T>(request: Record<string, unknown>, options: CallOptions = {}): Promise<T> {
  const api = runtime();
  if (!api) throw unavailable();

  const id = `req-${++requestCounter}`;
  const payload = { ...request, id };

  return options.onProgress
    ? callOverPort<T>(api, payload, options)
    : callOnce<T>(api, payload, options);
}

/** One message, one reply. For anything that answers immediately. */
async function callOnce<T>(
  api: ChromeRuntime,
  payload: Record<string, unknown>,
  options: CallOptions,
): Promise<T> {
  const response = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new HelperError('The card helper did not respond.', 'helper-not-installed')),
      options.silenceMs ?? SILENCE_TIMEOUT_MS,
    );
    try {
      api.sendMessage(HELPER_EXTENSION_ID, payload, (value) => {
        clearTimeout(timer);
        // An absent extension surfaces as lastError plus an undefined response, which is
        // the normal case for most users rather than a fault.
        if (api.lastError || value === undefined) {
          reject(
            new HelperError(
              'The A3EM card helper extension is not installed.',
              'helper-not-installed',
            ),
          );
          return;
        }
        resolve(value);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(new HelperError(String(error), 'helper-not-installed'));
    }
  });
  return unwrap<T>(response);
}

/**
 * A port, for operations that report progress while they run.
 *
 * The page must open the port: an extension cannot push a message to a web page, which
 * has `sendMessage` and `connect` but no `onMessage`. Everything arriving with a
 * `progress` field is a heartbeat; the first message without one is the answer.
 */
async function callOverPort<T>(
  api: ChromeRuntime,
  payload: Record<string, unknown>,
  options: CallOptions,
): Promise<T> {
  if (!api.connect) throw unavailable();

  const silenceMs = options.silenceMs ?? SILENCE_TIMEOUT_MS;

  const response = await new Promise<unknown>((resolve, reject) => {
    let port: ChromePort;
    try {
      port = api.connect!(HELPER_EXTENSION_ID);
    } catch (error) {
      reject(new HelperError(String(error), 'helper-not-installed'));
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const close = () => {
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // Already gone.
      }
    };

    /**
     * Restarted by every heartbeat, so what is measured is silence rather than duration.
     *
     * A half-hour image that keeps reporting is healthy; twenty seconds of nothing at all
     * is not. No fixed total could tell those apart.
     */
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        close();
        reject(new HelperError('The card helper stopped responding.', 'helper-not-installed'));
      }, silenceMs);
    };

    port.onMessage.addListener((message) => {
      const update = message as { progress?: TaskProgress };
      if (update?.progress) {
        arm();
        options.onProgress?.(update.progress);
        return;
      }
      if (settled) return;
      settled = true;
      close();
      resolve(message);
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new HelperError(
          'The A3EM card helper extension is not installed.',
          'helper-not-installed',
        ),
      );
    });

    arm();
    port.postMessage(payload);
  });

  return unwrap<T>(response);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface HelperIdentity {
  version: string;
  platform: string;
  /** Operations this build actually implements here. Empty on a stubbed platform. */
  implemented: string[];
}

export async function helperHello(): Promise<HelperIdentity> {
  // Short deadline: an absent extension must not hold the page's capability check open.
  return call<HelperIdentity>({ op: 'hello' }, { silenceMs: HANDSHAKE_TIMEOUT_MS });
}

export async function listDevices(): Promise<HelperDevice[]> {
  const result = await call<{ devices: HelperDevice[] }>({ op: 'listDevices' });
  return result.devices;
}

export async function inspectVolume(
  volume: string,
  recommendedAllocationUnitBytes?: number | null,
): Promise<{ geometry: CardGeometry; compatibility: CompatibilityReport }> {
  return call({ op: 'inspect', volume, recommendedAllocationUnitBytes });
}

export async function mountVolume(volume: string): Promise<void> {
  await call({ op: 'mount', volume });
}

export async function unmountVolume(volume: string): Promise<void> {
  await call({ op: 'unmount', volume });
}

export async function ejectDevice(device: string): Promise<void> {
  await call({ op: 'eject', device });
}

export async function requestChallenge(
  device: string,
  operation: 'format' | 'repair',
): Promise<HelperChallenge> {
  return call<HelperChallenge>({ op: 'challenge', device, operation });
}

export async function formatDevice(
  options: { device: string; allocationUnitBytes: number; label: string; grant: string },
  onProgress?: (progress: TaskProgress) => void,
): Promise<CardGeometry> {
  const result = await call<{ geometry: CardGeometry }>({ op: 'format', ...options }, { onProgress });
  return result.geometry;
}

export interface FsckReport {
  clean: boolean;
  modified: boolean;
  output: string;
  exitCode: number | null;
}

export async function diagnoseVolume(
  volume: string,
  onProgress?: (progress: TaskProgress) => void,
): Promise<FsckReport> {
  const result = await call<{ report: FsckReport }>({ op: 'diagnose', volume }, { onProgress });
  return result.report;
}

export async function repairVolume(
  options: { device: string; volume: string; grant: string },
  onProgress?: (progress: TaskProgress) => void,
): Promise<FsckReport> {
  const result = await call<{ report: FsckReport }>({ op: 'repair', ...options }, { onProgress });
  return result.report;
}

export interface ImageReport {
  destinationPath: string;
  bytesCopied: number;
  badSectors: number;
  complete: boolean;
}

/**
 * Sector-level image of a card, with progress.
 *
 * Progress arrives as separate messages from the extension rather than through the reply,
 * so a listener is attached for the duration and removed afterwards.
 */
export async function imageDevice(
  device: string,
  destination: string,
  onProgress?: (progress: TaskProgress) => void,
): Promise<ImageReport> {
  const result = await call<{ report: ImageReport }>(
    { op: 'image', device, destination },
    { onProgress },
  );
  return result.report;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * Works out which physical device a directory handle refers to.
 *
 * The File System Access API deliberately exposes no path, so the two sides are
 * correlated by writing a marker through the handle and asking the helper which device
 * carries it. Matching on volume name and size instead is not viable: `BatchPrepare`
 * exists to prepare six units from identical cards in one sitting, so identically named
 * cards of identical capacity are the normal case, and a heuristic would pick one at
 * random.
 *
 * The marker is dot-prefixed, which `scanCard` skips, so one left behind by an
 * interrupted call cannot appear in a card listing.
 */
export async function identifyCard(
  handle: FileSystemDirectoryHandle,
): Promise<{ device: string; volume: string }> {
  const probe = `.a3em-probe-${crypto.randomUUID()}`;
  const file = await handle.getFileHandle(probe, { create: true });
  try {
    await (await file.createWritable()).close();
    return await call<{ device: string; volume: string }>({ op: 'identify', probe });
  } finally {
    // Best effort: a stranded marker is harmless, and failing to clean one up must not
    // mask whatever the caller was actually trying to do.
    await handle.removeEntry(probe).catch(() => undefined);
  }
}
