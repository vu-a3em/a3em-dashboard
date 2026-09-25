import {
  forecast,
  judgeReadiness,
  planPreparation,
  recommendAllocationUnit,
  serializeConfig,
  validateFormatRequest,
  type CardReadinessReport,
  type DeploymentConfig,
  type FirmwareProfile,
  type PreparationPlan,
  type ReadinessVerdict,
} from '@a3em/config-schema';
import {
  checkReadinessOfCards,
  prepareCards,
  renameVolume,
  requestChallenge,
  writeCardConfig,
  type HelperDevice,
  type PreparedCard,
  type PrepareTarget,
  type TaskProgress,
} from './helper';
import type { Helper } from './useHelper';

/**
 * Preparing a card as a unit: the steps "Prepare this card" takes, wherever it is pressed — on
 * Prepare devices, for the cards of a batch, and on Configure, for the card that is open there.
 * One set of steps, so a card is never set up two different ways depending on the tab.
 *
 * The card is read first (`checkReadinessOfCards`), and `planPreparation` decides the least that
 * makes it ready: writing the unit's settings, or erasing it and setting it up again — capacity
 * test, write timing, the reference layout at this deployment's cluster size, verified, then the
 * settings. Erasing is confirmed in the helper's own words first, and the card must still
 * describe itself the same way when the erasing begins.
 */

/** What this deployment asks of a card of this size. */
export interface CardPlan {
  allocationUnitBytes: number;
  requiredBytes: number | null;
}

export function planFor(config: DeploymentConfig, firmware: FirmwareProfile, sizeBytes: number): CardPlan {
  const plan = forecast({ config, firmware, sdCardCapacityGb: sizeBytes / 1e9 });
  const allocation = recommendAllocationUnit({ config, clipsPerPhase: plan.clipWeights, cardCapacityBytes: sizeBytes });
  const required = plan.cardBytesPerDay * plan.deploymentDays;
  return { allocationUnitBytes: allocation.recommendedBytes, requiredBytes: Number.isFinite(required) ? required : null };
}

/** The unit's label as the card's name, where exFAT allows it: at most 11 characters, and not all of them. */
export function cardNameFor(label: string): string | null {
  const trimmed = label.trim();
  return trimmed && validateFormatRequest({ device: 'x', allocationUnitBytes: 32768, label: trimmed }).length === 0
    ? trimmed
    : null;
}

/** The name a card is given when it is prepared: the device's label, or else the formatter's default. */
export function volumeLabelFor(label: string): string {
  return cardNameFor(label) ?? 'A3EM';
}

/**
 * The name to give a card without erasing it: the device's label, where the card has another
 * and the helper can rename it. None for a label that cannot be a card's name.
 */
export function renameFor(report: CardReadinessReport | null | undefined, label: string, canRename: boolean): string | null {
  const name = cardNameFor(label);
  if (!canRename || !name || !report?.volume) return null;
  return report.volume.label === name ? null : name;
}

/** A card's reading judged for a unit, and the least that would make it ready for it. */
export function judgeCard(
  config: DeploymentConfig,
  plan: CardPlan | undefined,
  report: CardReadinessReport,
  label: string | null,
): { verdict: ReadinessVerdict; plan: PreparationPlan } {
  const verdict = judgeReadiness(report, {
    configText: label ? serializeConfig({ ...config, deviceLabel: label }) : null,
    // A label too long to be a name leaves any name as good as the default.
    volumeLabel: label ? cardNameFor(label) : null,
    allocationUnitBytes: plan?.allocationUnitBytes ?? null,
    requiredBytes: plan?.requiredBytes ?? null,
  });
  return { verdict, plan: planPreparation(verdict) };
}

/** Reads cards, changing nothing, with the helper's progress in the header and in `track`. */
export function readCards(helper: Helper, ids: string[], track: (progress: TaskProgress) => void): Promise<CardReadinessReport[]> {
  return helper.runTask('readiness', ids.length > 1 ? `Checking ${ids.length} cards` : 'Checking the card', (onProgress) =>
    checkReadinessOfCards(ids, true, (progress) => {
      onProgress(progress);
      track(progress);
    }),
  );
}

/** What writing a device's settings did: the card as it now reads, and whether it was renamed. */
export interface SettingsWritten {
  report: CardReadinessReport | null;
  renamed: boolean;
  /** Why the card could not be renamed, when its settings were written but its name was not. */
  renameError: string | null;
}

/**
 * The device's settings, straight onto the card, erasing nothing, and the card given the
 * device's name where it has another (`rename`); then the card read back, so what is shown is
 * what it now holds. A layout checked earlier is carried over rather than read again, which
 * would ask for the password once more. A card whose settings are already right is only
 * renamed (`write` false).
 *
 * The name is the lesser part: a card that could not be renamed still has its settings, and
 * says why it kept its name.
 */
export async function writeUnitSettings(
  device: HelperDevice,
  config: DeploymentConfig,
  label: string,
  earlier: CardReadinessReport | null,
  track: (progress: TaskProgress) => void,
  rename: string | null = null,
  write = true,
): Promise<SettingsWritten> {
  const volume = device.volumes[0];
  if (!volume) throw new Error('The card has no volume to write the settings to.');
  if (write) await writeCardConfig(volume.id, serializeConfig({ ...config, deviceLabel: label }));
  let renamed = false;
  let renameError: string | null = null;
  if (rename) {
    try {
      renamed = await renameVolume(volume.id, rename);
    } catch (failure) {
      if (!write) throw failure;
      renameError = failure instanceof Error ? failure.message : String(failure);
    }
  }
  const [read] = await checkReadinessOfCards([device.id], false, track);
  const report = read && !read.layout && earlier?.layout ? { ...read, layout: earlier.layout, layoutSkipped: undefined } : (read ?? null);
  return { report, renamed, renameError };
}

/** What writing a device's settings did, in a line: "settings written, card named OWL_02". */
export function settingsSummary(written: SettingsWritten, name: string | null, write: boolean): string {
  const parts = [write ? 'settings written' : null, written.renamed ? `card named ${name}` : null].filter(Boolean);
  const kept = written.renameError ? `; it kept its name, since it could not be renamed: ${written.renameError}` : '';
  return `${parts.join(', ')}; nothing needed erasing${kept}`;
}

/** A card confirmed for erasing, as the helper described it then. */
export interface EraseEntry {
  device: string;
  label: string;
  description: string;
}

/** A card that describes itself differently from when it was confirmed: nothing was erased. */
export class CardChangedError extends Error {
  constructor(readonly description: string) {
    super(`A card changed since you confirmed it, so nothing was erased. It now reads: ${description}`);
  }
}

/**
 * Erasing, after confirmation: fresh grants, checked against what was confirmed, then one
 * operation for all, and each card that came through read back.
 *
 * A grant lasts a minute, and confirming six cards can take longer, so new ones are asked for
 * now. Each must describe exactly what the person confirmed; a card swapped in the meantime
 * describes itself differently and stops the whole batch before anything is erased.
 */
export async function eraseAndPrepare(
  helper: Helper,
  entries: EraseEntry[],
  config: DeploymentConfig,
  plans: Record<string, CardPlan | undefined>,
  track: (progress: TaskProgress) => void,
): Promise<{ results: PreparedCard[]; reports: CardReadinessReport[] }> {
  const targets: PrepareTarget[] = [];
  for (const entry of entries) {
    const challenge = await requestChallenge(entry.device, 'prepare');
    if (challenge.description !== entry.description) throw new CardChangedError(challenge.description);
    targets.push({
      device: entry.device,
      grant: challenge.token,
      allocationUnitBytes: plans[entry.device]!.allocationUnitBytes,
      label: volumeLabelFor(entry.label),
      config: serializeConfig({ ...config, deviceLabel: entry.label }),
    });
  }
  const results = await helper.runTask('prepare', entries.length > 1 ? `Preparing ${entries.length} cards` : 'Preparing the card', (onProgress) =>
    prepareCards(targets, {}, (progress) => {
      onProgress(progress);
      track(progress);
    }),
  );
  await helper.rescan();
  const good = results.filter((result) => !result.error).map((result) => result.device);
  let reports: CardReadinessReport[] = [];
  if (good.length) {
    try {
      reports = await checkReadinessOfCards(good, false, track);
    } catch {
      reports = [];
    }
  }
  // The layout was verified moments ago by the preparation itself; reading it again would only
  // cost another password prompt.
  reports = reports.map((report) => {
    const layout = results.find((result) => result.device === report.device.id)?.layout;
    return !report.layout && layout ? { ...report, layout, layoutSkipped: undefined } : report;
  });
  return { results, reports };
}

/** A prepared card, in a line. */
export function summarize(result: PreparedCard): string {
  const parts = [];
  if (result.capacity) parts.push(result.capacity.genuine ? 'capacity genuine' : 'capacity FAKE');
  if (result.latency) parts.push(`writes ${result.latency.verdict === 'ok' ? 'steady' : result.latency.verdict}`);
  if (result.layout?.reference) parts.push('layout verified');
  if (result.configWritten) parts.push('configuration written');
  return parts.join(', ');
}
