import { useCallback, useEffect, useState } from 'react';
import {
  CONFIG_SCHEMA_VERSION,
  createProtocol,
  STARTER_PROTOCOLS,
  updateProtocol,
  type DeploymentConfig,
  type Protocol,
} from '@a3em/config-schema';

const STORAGE_KEY = 'a3em.protocols';

/**
 * The protocol library.
 *
 * Local storage only, which is the whole of it for now: configuration has to work at a
 * field station with no connectivity, so this is local-first by design rather than as a
 * fallback. The shape stored here is the shape that will sync once accounts exist, so
 * nothing saved now has to be thrown away later.
 *
 * The starter set is never persisted — it ships with the build, so writing copies of it
 * would freeze today's version into every user's store and leave later corrections
 * unable to reach them.
 */
export function useProtocols() {
  const [saved, setSaved] = useState<Protocol[]>(() => restore());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, protocols: saved }));
    } catch {
      // A full or disabled store must not break editing. Protocols simply stop
      // surviving a reload, which is recoverable; losing the edit in progress is not.
    }
  }, [saved]);

  const save = useCallback((config: DeploymentConfig, meta: { name: string; description: string }) => {
    const protocol = createProtocol(config, {
      id: newId(),
      name: meta.name.trim(),
      description: meta.description.trim(),
      now: new Date().toISOString(),
    });
    setSaved((previous) => [...previous, protocol]);
    return protocol;
  }, []);

  /**
   * Saves edits back to a protocol, bumping its version.
   *
   * A built-in cannot be changed in place — it belongs to the build, not the user — so
   * editing one produces a copy under its own name instead of silently doing nothing.
   */
  const update = useCallback((protocol: Protocol, config: DeploymentConfig) => {
    if (protocol.builtIn) {
      const copy = createProtocol(config, {
        id: newId(),
        name: `${protocol.name} (edited)`,
        description: protocol.description,
        now: new Date().toISOString(),
      });
      setSaved((previous) => [...previous, copy]);
      return copy;
    }
    const next = updateProtocol(protocol, config, new Date().toISOString());
    setSaved((previous) => previous.map((item) => (item.id === next.id ? next : item)));
    return next;
  }, []);

  const remove = useCallback((id: string) => {
    setSaved((previous) => previous.filter((protocol) => protocol.id !== id));
  }, []);

  const rename = useCallback((id: string, name: string, description: string) => {
    setSaved((previous) =>
      previous.map((protocol) =>
        protocol.id === id
          ? { ...protocol, name: name.trim(), description: description.trim(), updatedAt: new Date().toISOString() }
          : protocol,
      ),
    );
  }, []);

  return { protocols: [...STARTER_PROTOCOLS, ...saved], saved, save, update, remove, rename };
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
