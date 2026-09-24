import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONFIG_SCHEMA_VERSION,
  createProtocol,
  isNewer,
  joinLibraries,
  STARTER_PROTOCOLS,
  updateProtocol,
  type DeploymentConfig,
  type Protocol,
} from '@a3em/config-schema';
import type { Account } from './useAccount';
import type { RemoteLibrary } from './firebase';

const STORAGE_KEY = 'a3em.protocols';

/**
 * The protocol library: in this browser, or in the signed-in person's account.
 *
 * Signed out, protocols live in this browser's local storage, as they always have:
 * configuration has to work at a field station with no connectivity, so this is local-first
 * by design rather than as a fallback.
 *
 * Signed in, they live in the account, and follow the person to any computer. The first time
 * the account's list arrives from the server, whatever this browser holds is added to it —
 * newer saves winning, nothing overwritten by an older one — and, once the server has
 * confirmed every one, removed from the browser. So each protocol lives in exactly one place,
 * and signing out of a shared computer takes the library with it. The account's copy stays
 * readable offline, and edits made offline are sent when the connection returns.
 *
 * The starter set is never persisted in either place — it ships with the build, so writing
 * copies of it would freeze today's version into every library and leave later corrections
 * unable to reach them.
 */

export interface LibrarySync {
  /** Where saved protocols are kept right now. */
  storage: 'browser' | 'account';
  email: string | null;
  /** False while the account's list has not yet come from the server. */
  loaded: boolean;
  /** Edits not yet confirmed by the server: offline, or just made. */
  pending: boolean;
  /** How many protocols from this browser were added to the account in this session. */
  joined: number;
  /** Protocols in the account saved by a dashboard built for another schema, not shown. */
  hidden: string[];
  error: string | null;
  /** Opens sign-in, where this deployment offers accounts and nobody is signed in. */
  offerSignIn: (() => void) | null;
}

export function useProtocols(account?: Account) {
  const [local, setLocal] = useState<Protocol[]>(() => restore());
  const [remote, setRemote] = useState<RemoteLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(0);

  const uid = account?.status === 'signed-in' ? (account.user?.uid ?? null) : null;
  const connection = uid ? (account?.connection ?? null) : null;
  const describe = account?.describeError ?? null;
  const explain = useCallback(
    (prefix: string, failure: unknown) => {
      const message = describe ? describe(failure) : String(failure);
      if (message) setError(`${prefix}: ${message}`);
    },
    [describe],
  );

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, protocols: local }));
    } catch {
      // A full or disabled store must not break editing. Protocols simply stop
      // surviving a reload, which is recoverable; losing the edit in progress is not.
    }
  }, [local]);

  useEffect(() => {
    setRemote(null);
    setError(null);
    if (!uid || !connection) return undefined;
    return connection.watchProtocols(uid, setRemote, (failure) => explain('Your account’s protocols could not be loaded', failure));
  }, [uid, connection, explain]);

  /*
    Join this browser's library to the account, once the account's own list has come from the
    server rather than from this browser's copy of it — so a protocol is never judged missing
    from the account only because this browser had not heard about it yet.
  */
  const joining = useRef(false);
  // Tried once per sign-in: a protocol the account refuses must not be retried on every update,
  // since each failed write is itself an update.
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    attempted.current = new Set();
    setJoined(0);
  }, [uid]);
  useEffect(() => {
    if (!uid || !connection || !remote?.fromServer || joining.current) return;
    const untried = local.filter((protocol) => !attempted.current.has(protocol.id));
    const { upload, alreadyThere } = joinLibraries(untried, remote.protocols);
    if (upload.length === 0 && alreadyThere.length === 0) return;
    for (const protocol of untried) attempted.current.add(protocol.id);
    joining.current = true;
    const moves = upload.map((protocol) => Promise.resolve().then(() => connection.saveProtocol(uid, protocol)));
    void Promise.allSettled(moves).then((results) => {
      const done = new Set(alreadyThere.map((protocol) => protocol.id));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') done.add(upload[index]!.id);
      });
      setLocal((previous) => previous.filter((protocol) => !done.has(protocol.id)));
      setJoined((count) => count + done.size);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        explain(`${results.filter((result) => result.status === 'rejected').length} protocols from this browser could not be added to your account, and are still here`, failed.reason);
      }
      joining.current = false;
    });
  }, [uid, connection, remote, local, explain]);

  /*
    What is shown. Signed in, the account's list, plus anything from this browser still on its
    way there — each protocol once, at its newest save.
  */
  const saved = useMemo(() => {
    if (!uid) return local;
    const byId = new Map<string, Protocol>();
    for (const protocol of [...(remote?.protocols ?? []), ...local]) {
      const existing = byId.get(protocol.id);
      if (!existing || isNewer(protocol, existing)) byId.set(protocol.id, protocol);
    }
    return [...byId.values()];
  }, [uid, remote, local]);

  const savedRef = useRef(saved);
  savedRef.current = saved;

  /** Keeps one protocol wherever the library lives now. */
  const store = useCallback(
    (protocol: Protocol) => {
      if (uid && connection) {
        connection.saveProtocol(uid, protocol).catch((failure) => explain(`“${protocol.name}” was not saved to your account`, failure));
      } else {
        setLocal((previous) =>
          previous.some((item) => item.id === protocol.id)
            ? previous.map((item) => (item.id === protocol.id ? protocol : item))
            : [...previous, protocol],
        );
      }
    },
    [uid, connection, explain],
  );

  const save = useCallback(
    (config: DeploymentConfig, meta: { name: string; description: string }) => {
      const protocol = createProtocol(config, {
        id: newId(),
        name: meta.name.trim(),
        description: meta.description.trim(),
        now: new Date().toISOString(),
      });
      store(protocol);
      return protocol;
    },
    [store],
  );

  /**
   * Saves edits back to a protocol, bumping its version.
   *
   * A built-in cannot be changed in place — it belongs to the build, not the user — so
   * editing one produces a copy under its own name instead of silently doing nothing.
   */
  const update = useCallback(
    (protocol: Protocol, config: DeploymentConfig) => {
      if (protocol.builtIn) {
        const copy = createProtocol(config, {
          id: newId(),
          name: `${protocol.name} (edited)`,
          description: protocol.description,
          now: new Date().toISOString(),
        });
        store(copy);
        return copy;
      }
      const next = updateProtocol(protocol, config, new Date().toISOString());
      store(next);
      return next;
    },
    [store],
  );

  const remove = useCallback(
    (id: string) => {
      setLocal((previous) => previous.filter((protocol) => protocol.id !== id));
      if (uid && connection) {
        const name = savedRef.current.find((protocol) => protocol.id === id)?.name ?? 'The protocol';
        connection.deleteProtocol(uid, id).catch((failure) => explain(`“${name}” was not deleted from your account`, failure));
      }
    },
    [uid, connection, explain],
  );

  const rename = useCallback(
    (id: string, name: string, description: string) => {
      const protocol = savedRef.current.find((item) => item.id === id);
      if (!protocol) return;
      store({ ...protocol, name: name.trim(), description: description.trim(), updatedAt: new Date().toISOString() });
    },
    [store],
  );

  const sync: LibrarySync = {
    storage: uid ? 'account' : 'browser',
    email: uid ? (account?.user?.email ?? null) : null,
    loaded: !uid || Boolean(remote?.fromServer),
    pending: Boolean(uid && remote?.pendingWrites),
    joined,
    hidden: remote?.otherSchema ?? [],
    error,
    offerSignIn: account?.status === 'signed-out' ? account.openDialog : null,
  };

  return { protocols: [...STARTER_PROTOCOLS, ...saved], saved, save, update, remove, rename, sync };
}

function restore(): Protocol[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as { schemaVersion?: number; protocols?: Protocol[] };
    // Settings written against an older schema may not mean what this build thinks they
    // do. Keeping them would silently reinterpret someone's recording configuration.
    if (parsed?.schemaVersion !== CONFIG_SCHEMA_VERSION) return [];
    return (parsed.protocols ?? []).filter((protocol) => protocol?.id && protocol?.settings);
  } catch {
    return [];
  }
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
