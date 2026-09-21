import type { CardGeometry, CompatibilityReport } from '@a3em/config-schema';
import type { FsckReport, ImageReport } from './platform/types.js';

/**
 * The wire format Chrome speaks to a native messaging host.
 *
 * Each message is a 32-bit length in **native byte order** followed by that many bytes of
 * UTF-8 JSON. Native byte order rather than a fixed endianness is what the specification
 * says, and every platform this runs on is little-endian, but `readUInt32LE` is not a
 * safe shortcut to write without saying why — so the reader uses the host's own order
 * explicitly and will keep working if that ever stops being true.
 *
 * **Host → extension is capped at 1 MB.** That cap is the reason this protocol carries
 * verdicts and progress rather than payloads: a card listing must be summarised, and
 * audio never crosses this channel at all — it goes through the File System Access API,
 * which has no such limit.
 */

export const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Little-endian on every platform this supports; resolved once rather than per message. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function encodeMessage(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  if (json.length > MAX_MESSAGE_BYTES) {
    throw new MessageTooLargeError(json.length);
  }
  const header = Buffer.allocUnsafe(4);
  if (LITTLE_ENDIAN) header.writeUInt32LE(json.length, 0);
  else header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

export class MessageTooLargeError extends Error {
  constructor(readonly byteLength: number) {
    super(
      `Response is ${byteLength} bytes, over the ${MAX_MESSAGE_BYTES}-byte native messaging limit. ` +
        'Summarise or page it.',
    );
    this.name = 'MessageTooLargeError';
  }
}

/**
 * Reassembles messages from a stdin that arrives in arbitrary chunks.
 *
 * A length prefix can be split across reads, and so can a body — treating each `data`
 * event as a message is the standard way this goes wrong, and it fails only under load,
 * which is to say in the field and not in testing.
 */
export class MessageReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    while (this.buffer.length >= 4) {
      const length = LITTLE_ENDIAN ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0);
      if (length > MAX_MESSAGE_BYTES * 64) {
        // Nothing legitimate is this large; a length this wrong means the stream is
        // desynchronised and continuing would allocate against garbage.
        throw new Error(`Refusing a ${length}-byte message: the stream is not framed correctly.`);
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(JSON.parse(body.toString('utf8')));
    }
    return messages;
  }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type Request =
  | { id: string; op: 'hello' }
  | { id: string; op: 'listDevices' }
  | { id: string; op: 'identify'; probe: string }
  | { id: string; op: 'inspect'; volume: string; recommendedAllocationUnitBytes?: number | null }
  | { id: string; op: 'mount'; volume: string }
  | { id: string; op: 'unmount'; volume: string }
  | { id: string; op: 'eject'; device: string }
  | { id: string; op: 'diagnose'; volume: string }
  | { id: string; op: 'challenge'; device: string; operation: 'format' | 'repair' }
  | { id: string; op: 'repair'; volume: string; device: string; grant: string }
  | { id: string; op: 'image'; device: string; destination: string }
  | {
      id: string;
      op: 'format';
      device: string;
      allocationUnitBytes: number;
      label: string;
      grant: string;
    };

export type RequestOp = Request['op'];

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface DeviceSummary {
  id: string;
  node: string;
  sizeBytes: number;
  bus: string;
  partitionScheme: string;
  volumes: Array<{
    id: string;
    label: string | null;
    filesystem: string | null;
    sizeBytes: number;
    mountPoint: string | null;
    allocationUnitBytes: number | null;
    mountable: boolean;
  }>;
  /** The firmware verdict, so the page never has to re-derive it. */
  compatibility: CompatibilityReport | null;
}

/**
 * An answer to one request.
 *
 * Split from `Response` because progress notifications are not answers: they are
 * unsolicited, carry no `ok`, and never end a request. Folding them into one union made
 * every caller narrow a variant that `handle` cannot return.
 */
export type Reply =
  | { id: string; ok: true; op: 'hello'; version: string; platform: string; implemented: string[] }
  | { id: string; ok: true; op: 'listDevices'; devices: DeviceSummary[] }
  | { id: string; ok: true; op: 'identify'; volume: string; device: string }
  | { id: string; ok: true; op: 'inspect'; geometry: CardGeometry; compatibility: CompatibilityReport }
  | { id: string; ok: true; op: 'mount' | 'unmount' | 'eject' }
  | { id: string; ok: true; op: 'diagnose' | 'repair'; report: FsckReport }
  | { id: string; ok: true; op: 'challenge'; token: string; description: string; expiresAt: number }
  | { id: string; ok: true; op: 'image'; report: ImageReport }
  | { id: string; ok: true; op: 'format'; geometry: CardGeometry }
  | { id: string; ok: false; error: string; code: string; detail?: string };

/**
 * How far along a long operation is.
 *
 * Every operation that can run for more than a couple of seconds emits these, including
 * the ones that cannot say how far along they are. That is the point: `fsck` on a damaged
 * card gives no measurable progress and can run for many minutes, and a UI with nothing
 * to show is indistinguishable from one that has hung. A heartbeat with a phrase in it is
 * the difference between "still checking the filesystem" and an apparently frozen page.
 *
 * It is also what the client times out against. An inactivity deadline — nothing heard
 * for N seconds — is correct where a total deadline is not: imaging a 128 GB card
 * legitimately takes half an hour, and no fixed total works for both that and a `mount`.
 */
export interface TaskProgress {
  op: RequestOp;
  /** One short phrase, shown to the operator. */
  note: string;
  /** Present only where the operation knows its own extent. */
  bytesCopied?: number;
  totalBytes?: number;
  badSectors?: number;
  /** Since the operation started, so the UI can say how long it has been going. */
  elapsedMs: number;
}

/** Unsolicited, and only for operations that take more than a moment. */
export interface ProgressMessage {
  id: string;
  progress: TaskProgress;
}

/** How often the host emits a heartbeat during a long operation. */
export const HEARTBEAT_INTERVAL_MS = 2000;

/** Anything the host writes to stdout. */
export type Response = Reply | ProgressMessage;
