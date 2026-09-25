import { serializeConfig, type DeploymentConfig } from '@a3em/config-schema';

/**
 * A batch of units, prepared from one configuration, and whether its cards still agree.
 *
 * Every unit of a batch is meant to record the same way. A card keeps the settings it was written
 * with, though, and Configure can still change them afterward, so a change made partway through a
 * batch would leave its first cards behaving differently from the rest. Each written unit
 * remembers the settings its card got; one whose card no longer has the settings on screen counts
 * as not written again. That is worked out from the settings, not stored, so changing them back
 * makes those cards count as written once more.
 */

export interface BatchUnit {
  label: string;
  status: 'pending' | 'writing' | 'written' | 'error';
  cardName: string | null;
  error: string | null;
  /** Something about the card worth knowing that did not stop the write. */
  note: string | null;
  /** What its card was written with (`batchSettings`), once it is written. */
  settings: string | null;
}

/** The settings every card of a batch gets: the configuration as a card holds it, but for each unit's label. */
export function batchSettings(config: DeploymentConfig): string {
  try {
    return serializeConfig({ ...config, deviceLabel: '' });
  } catch {
    // Settings that cannot be written, which no card was written with.
    return '';
  }
}

/** A batch's written units, by whether their cards have the settings as they are now. */
export function writtenUnits(units: BatchUnit[], config: DeploymentConfig): { current: BatchUnit[]; outdated: BatchUnit[] } {
  const settings = batchSettings(config);
  const written = units.filter((unit) => unit.status === 'written');
  return {
    current: written.filter((unit) => unit.settings === settings),
    outdated: written.filter((unit) => unit.settings !== settings),
  };
}

/** Units' labels, as a list in a sentence: the first few, for a batch of dozens. */
export function listLabels(labels: string[]): string {
  if (labels.length > 5) return `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} others`;
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
