import { CONFIG_SCHEMA_VERSION } from './firmware-constants.js';
import type { Protocol } from './protocol.js';

/**
 * Protocols as they are kept in a user's account, and how a browser's own library joins it.
 *
 * Kept free of any storage SDK so the rules that decide what is uploaded, what is shown, and
 * what is refused can be tested here, once, the same way the rest of the schema is.
 */

/**
 * One protocol as stored in the account database.
 *
 * The protocol itself travels as JSON text rather than as the database's own nested fields.
 * Settings hold `undefined` and nested lists the database would reject or reshape, and a
 * string round-trips exactly — so what comes back is what the browser's own library would have
 * kept, and the
 * database's rules can bound its size with one check. The four fields beside it exist so
 * those rules, and anyone looking in the console, can see what a record is without parsing it.
 */
export interface ProtocolRecord {
  schemaVersion: number;
  name: string;
  version: number;
  updatedAt: string;
  json: string;
}

/** Limits the database rules enforce too. Checked here first, so a refusal has a message. */
export const PROTOCOL_RECORD_LIMITS = {
  nameLength: 200,
  jsonBytes: 256 * 1024,
  idLength: 100,
} as const;

export function protocolToRecord(protocol: Protocol): ProtocolRecord {
  const json = JSON.stringify({ ...protocol, builtIn: false });
  if (new TextEncoder().encode(json).length > PROTOCOL_RECORD_LIMITS.jsonBytes) {
    throw new Error(`"${protocol.name}" is too large to keep in an account.`);
  }
  if (protocol.id.length > PROTOCOL_RECORD_LIMITS.idLength) {
    throw new Error(`"${protocol.name}" has an identifier too long to keep in an account.`);
  }
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    name: protocol.name.slice(0, PROTOCOL_RECORD_LIMITS.nameLength),
    version: protocol.version,
    updatedAt: protocol.updatedAt,
    json,
  };
}

export type RecordReading =
  | { kind: 'protocol'; protocol: Protocol }
  /**
   * Saved by a dashboard built for another configuration schema. Not shown, for the same
   * reason the browser's own library drops them: settings written against another schema
   * may not mean what this build thinks, and applying them would silently reinterpret
   * someone's recording configuration. Not deleted either — the build that wrote them can
   * still read them.
   */
  | { kind: 'other-schema'; name: string }
  | { kind: 'unreadable' };

export function protocolFromRecord(id: string, record: Partial<ProtocolRecord> | undefined): RecordReading {
  if (!record || typeof record.json !== 'string') return { kind: 'unreadable' };
  if (record.schemaVersion !== CONFIG_SCHEMA_VERSION) return { kind: 'other-schema', name: String(record.name ?? id) };
  try {
    const protocol = JSON.parse(record.json) as Protocol;
    if (!protocol || typeof protocol !== 'object' || !protocol.settings || protocol.id !== id) return { kind: 'unreadable' };
    return { kind: 'protocol', protocol: { ...protocol, builtIn: false } };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** True when `a` is a later save of the same protocol than `b`. */
export function isNewer(a: Protocol, b: Protocol): boolean {
  if (a.version !== b.version) return a.version > b.version;
  return a.updatedAt > b.updatedAt;
}

export interface LibraryJoin {
  /** Protocols from this browser the account lacks, or holds an older save of. */
  upload: Protocol[];
  /** Protocols from this browser the account already holds, as saved or newer. */
  alreadyThere: Protocol[];
}

/**
 * What joining this browser's library to an account means.
 *
 * Nothing is lost either way: a protocol the account lacks is added, a newer save from this
 * browser replaces the account's older one, and where the account has the newer save it is
 * kept. Once everything in `upload` is confirmed saved, the browser's own copy can be cleared,
 * so each protocol then lives in exactly one place.
 */
export function joinLibraries(local: readonly Protocol[], remote: readonly Protocol[]): LibraryJoin {
  const byId = new Map(remote.map((protocol) => [protocol.id, protocol]));
  const upload: Protocol[] = [];
  const alreadyThere: Protocol[] = [];
  for (const protocol of local) {
    if (protocol.builtIn) continue;
    const existing = byId.get(protocol.id);
    if (!existing || isNewer(protocol, existing)) upload.push(protocol);
    else alreadyThere.push(protocol);
  }
  return { upload, alreadyThere };
}
