import { useEffect, useState } from 'react';
import {
  CONFIG_SCHEMA_VERSION,
  defaultConfig,
  type DeploymentConfig,
  type Protocol,
  type ProtocolProvenance,
} from '@a3em/config-schema';

const STORAGE_KEY = 'a3em.deployment-draft';

/**
 * The deployment being edited.
 *
 * Held here rather than inside the editor so that switching views does not unmount it
 * and discard the work, and written to local storage on every change so a reload or a
 * closed tab does not either. Field stations have unreliable everything; losing a
 * configuration to a stray click is not acceptable.
 */
export function useDeploymentDraft() {
  const restored = useState(() => restore())[0];
  const [config, setConfig] = useState<DeploymentConfig>(
    () => restored?.config ?? defaultConfig(guessTimezone()),
  );
  /**
   * Which protocol this deployment came from, if any.
   *
   * Kept beside the config rather than inside it: the config is what gets written to a
   * card, and the firmware has no key for this. It is provenance for the person, not
   * settings for the device.
   */
  const [basedOn, setBasedOn] = useState<ProtocolProvenance | null>(() => restored?.basedOn ?? null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: CONFIG_SCHEMA_VERSION, config, basedOn }));
    } catch {
      // A full or disabled store must not break editing; the draft simply stops
      // surviving reloads.
    }
  }, [config, basedOn]);

  /** Records a protocol as this deployment's basis, at the version applied. */
  const noteBasis = (protocol: Protocol) =>
    setBasedOn({
      protocolId: protocol.id,
      name: protocol.name,
      version: protocol.version,
      appliedAt: new Date().toISOString(),
    });

  const reset = () => {
    setConfig(defaultConfig(guessTimezone()));
    setBasedOn(null);
  };
  return { config, setConfig, basedOn, noteBasis, clearBasis: () => setBasedOn(null), reset };
}

interface StoredDraft {
  config: DeploymentConfig;
  basedOn: ProtocolProvenance | null;
}

function restore(): StoredDraft | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<StoredDraft> & Partial<DeploymentConfig>;

    // Drafts were once stored as a bare config. Reading those back keeps a reload from
    // discarding work that predates protocols.
    const config = (parsed.config ?? parsed) as DeploymentConfig;

    // A draft written by an older schema may not mean what this build thinks it does,
    // so start clean rather than silently reinterpreting it.
    if (config?.schemaVersion !== CONFIG_SCHEMA_VERSION) return null;
    if (!Array.isArray(config.phases) || config.phases.length === 0) return null;
    return { config, basedOn: parsed.basedOn ?? null };
  } catch {
    return null;
  }
}

export function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
