import { formatAllocationUnit } from './allocation-unit.js';
import { judgeCardFormat, type CardGeometry, type PartitionScheme } from './card-format.js';
import { CONFIG_FILE_NAME } from './firmware-constants.js';
import { parseConfig } from './parse.js';

/**
 * Whether a card can go into a recorder, from everything the card helper can see.
 *
 * The helper reports facts — its layout compared byte for byte with the reference, what the
 * capacity probe found when this computer prepared it, what is on it, its configuration file —
 * and this turns them into one list of checks, each passed, failed, or honestly unknown. It
 * lives here, beside `judgeCardFormat`, so the rules are tested once and read the same in the
 * dashboard as in any other tool built on this package.
 *
 * Unknown is not failure. The capacity probe is destructive, so it only runs while a card is
 * being prepared; a card prepared on another computer cannot be vouched for here, and says so
 * rather than passing by default.
 */

/** What the card helper's readiness operation reports. */
export interface CardReadinessReport {
  device: {
    id: string;
    node: string;
    sizeBytes: number;
    bus: string;
    partitionScheme: PartitionScheme;
    writeProtected: boolean;
  };
  identity?: {
    source: 'card' | 'reader';
    manufacturer?: string;
    product?: string;
    serial?: string;
    manufactured?: string;
    reader?: string;
  };
  volume: {
    id: string;
    label: string | null;
    filesystem: string | null;
    allocationUnitBytes: number | null;
    mountPoint: string | null;
  } | null;
  geometry: CardGeometry | null;
  contents: { files: number; directories: number; bytes: number; examples?: string[]; truncated?: boolean } | null;
  config: { present: boolean; text?: string; bytes: number; tooLarge?: boolean } | null;
  freeBytes: number | null;
  layout: {
    reference: boolean;
    clusterBytes?: number;
    label?: string;
    problem?: string;
    regions?: Array<{ name: string; status: 'match' | 'in-use' | 'differs'; note?: string }>;
  } | null;
  /** Why `layout` is null: `needs-admin`, `cancelled`, or the failure's code. */
  layoutSkipped?: string;
  /** What this computer recorded when it prepared this very format of the card. */
  prepared: {
    preparedAt: string;
    clusterBytes: number;
    label: string;
    capacity?: { genuine: boolean; verdict: string; claimedBytes: number; verifiedBytes: number };
    latency?: { verdict: 'ok' | 'slow' | 'stalls'; medianMs: number; p99Ms: number; maxMs: number; mbPerSecond: number };
  } | null;
  problems?: string[] | null;
}

/** What the card is meant to carry, where that is known. */
export interface ReadinessExpectation {
  /** The exact `_a3em.cfg` this card should hold. */
  configText?: string | null;
  /** The volume label the card should carry. */
  volumeLabel?: string | null;
  /** The deployment's recommended allocation unit. */
  allocationUnitBytes?: number | null;
  /** What the deployment will write to the card, overhead included. */
  requiredBytes?: number | null;
}

export type ReadinessStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export type ReadinessCheckId =
  | 'write-protect'
  | 'layout'
  | 'capacity'
  | 'write-speed'
  | 'format'
  | 'empty'
  | 'config'
  | 'config-match'
  | 'label'
  | 'space';

export interface ReadinessCheck {
  id: ReadinessCheckId;
  title: string;
  status: ReadinessStatus;
  /** One or two sentences, addressed to the person holding the card. */
  detail: string;
}

export interface ReadinessVerdict {
  /** `ready`: everything passed. `attention`: nothing failed, but something is unknown or advisory. */
  status: 'ready' | 'attention' | 'not-ready';
  checks: ReadinessCheck[];
}

function size(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1e6))} MB`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

export function judgeReadiness(report: CardReadinessReport, expected: ReadinessExpectation = {}): ReadinessVerdict {
  const checks: ReadinessCheck[] = [];
  const add = (id: ReadinessCheckId, title: string, status: ReadinessStatus, detail: string) =>
    checks.push({ id, title, status, detail });

  add(
    'write-protect',
    'Not write-protected',
    report.device.writeProtected ? 'fail' : 'pass',
    report.device.writeProtected
      ? 'The card is locked. Slide the switch on its side away from LOCK and reinsert it: a recorder cannot write to a locked card.'
      : 'The recorder can write to it.',
  );

  const layout = report.layout;
  if (layout) {
    const differing = (layout.regions ?? []).filter((region) => region.status === 'differs').map((region) => region.name);
    add(
      'layout',
      'Layout matches the reference',
      layout.reference ? 'pass' : 'fail',
      layout.reference
        ? `Every structure matches the layout the formatter writes${layout.clusterBytes ? `, at ${formatAllocationUnit(layout.clusterBytes)} clusters` : ''}.`
        : layout.problem
          ? `${layout.problem} Prepare the card to give it the reference layout.`
          : `Differs from the reference in: ${differing.join(', ')}. Prepare the card to give it the reference layout.`,
    );
  } else {
    add(
      'layout',
      'Layout matches the reference',
      'unknown',
      report.layoutSkipped === 'cancelled'
        ? 'Not checked: administrator access was not given.'
        : report.layoutSkipped === 'needs-admin' || !report.layoutSkipped
          ? 'Not checked. Reading the card’s layout needs administrator access; check again with the layout included.'
          : 'Not checked: the card’s layout could not be read.',
    );
  }

  const capacity = report.prepared?.capacity;
  if (capacity) {
    add(
      'capacity',
      'Capacity is real',
      capacity.genuine ? 'pass' : 'fail',
      capacity.genuine
        ? `Tested when this computer prepared it: all ${size(capacity.claimedBytes)} kept what was written.`
        : `Counterfeit: it claims ${size(capacity.claimedBytes)} but only the first ${size(capacity.verifiedBytes)} kept what was written. Recordings past that point would be lost. Do not deploy it.`,
    );
  } else {
    add(
      'capacity',
      'Capacity is real',
      'unknown',
      report.prepared
        ? 'This card was prepared here without the capacity test.'
        : 'Not tested on this computer. Preparing the card here tests it; the test erases the card.',
    );
  }

  const latency = report.prepared?.latency;
  if (latency) {
    add(
      'write-speed',
      'Writes keep up',
      latency.verdict === 'ok' ? 'pass' : 'warn',
      latency.verdict === 'ok'
        ? `Steady at ${latency.mbPerSecond.toFixed(0)} MB/s; the slowest write took ${Math.round(latency.maxMs)} ms.`
        : latency.verdict === 'slow'
          ? `Some writes took ${Math.round(latency.p99Ms)} ms or more. The recorder may lose audio while the card catches up.`
          : `The card stalled for up to ${(latency.maxMs / 1000).toFixed(1)} s on some writes. The recorder may lose audio during stalls; a different card is safer.`,
    );
  } else {
    add('write-speed', 'Writes keep up', 'unknown', 'Not measured on this computer. Preparing the card here measures it.');
  }

  if (report.geometry) {
    const format = judgeCardFormat(report.geometry, expected.allocationUnitBytes ?? null);
    const worst = format.issues.find((issue) => issue.severity === 'critical') ?? format.issues[0];
    add(
      'format',
      'Format suits the firmware',
      !worst ? 'pass' : worst.severity === 'critical' ? 'fail' : 'warn',
      worst ? [worst.message, worst.remedy].filter(Boolean).join(' ') : 'exFAT on an MBR partition, as the firmware requires.',
    );
  } else {
    add('format', 'Format suits the firmware', 'fail', 'The card has no volume the system can read. Prepare it before use.');
  }

  const contents = report.contents;
  if (contents) {
    const items = contents.files + contents.directories;
    add(
      'empty',
      'Card is empty',
      items === 0 ? 'pass' : 'warn',
      items === 0
        ? `Nothing on it besides ${CONFIG_FILE_NAME}.`
        : `It holds ${contents.truncated ? 'at least ' : ''}${plural(contents.files, 'file')} (${size(contents.bytes)}) from before${
            contents.examples?.length ? `, such as ${contents.examples.slice(0, 2).join(' and ')}` : ''
          }. The recorder adds to them and fills sooner; copy them off and prepare the card if they are not needed.`,
    );
  } else {
    add('empty', 'Card is empty', 'unknown', 'Not checked: the card is not mounted.');
  }

  const config = report.config;
  let parsedOk = false;
  if (!config) {
    add('config', 'Configuration is present', 'unknown', 'Not checked: the card is not mounted.');
  } else if (!config.present) {
    add(
      'config',
      'Configuration is present',
      'fail',
      `There is no ${CONFIG_FILE_NAME}. Without one, the recorder shows its missing-configuration light and restarts every 15 seconds instead of recording.`,
    );
  } else if (config.tooLarge || config.text === undefined) {
    add('config', 'Configuration is present', 'fail', `${CONFIG_FILE_NAME} is ${size(config.bytes)}, far larger than any configuration.`);
  } else {
    const parsed = parseConfig(config.text);
    parsedOk = parsed.warnings.length === 0;
    add(
      'config',
      'Configuration is present',
      parsedOk ? 'pass' : 'warn',
      parsedOk
        ? `${CONFIG_FILE_NAME} for ${parsed.config.deviceLabel || 'an unlabelled device'} reads cleanly.`
        : `${CONFIG_FILE_NAME} reads, but the recorder may not read it the same way: ${parsed.warnings[0]}`,
    );
  }
  if (expected.configText != null && config?.present && config.text !== undefined) {
    const same = normalise(config.text) === normalise(expected.configText);
    add(
      'config-match',
      'Configuration is this deployment’s',
      same ? 'pass' : 'fail',
      same ? 'Identical to the configuration being prepared.' : 'The configuration on the card is not the one being prepared. Write it again.',
    );
  }

  if (expected.volumeLabel && report.volume) {
    const label = report.volume.label ?? '';
    add(
      'label',
      'Card is labelled',
      label === expected.volumeLabel ? 'pass' : 'warn',
      label === expected.volumeLabel
        ? `The volume is named ${label}.`
        : `The volume is named ${label || 'nothing'}, not ${expected.volumeLabel}. The recorder does not mind; it only makes the card harder to tell apart.`,
    );
  }

  if (expected.requiredBytes != null && report.freeBytes != null) {
    const needed = expected.requiredBytes;
    if (report.freeBytes >= needed) {
      add('space', 'Room for the deployment', 'pass', `The deployment needs about ${size(needed)}; ${size(report.freeBytes)} is free.`);
    } else if (needed > report.device.sizeBytes) {
      // No card of this size could hold it: the plan's limit, which the forecast already states.
      add(
        'space',
        'Room for the deployment',
        'warn',
        `The deployment needs about ${size(needed)}, more than this ${size(report.device.sizeBytes)} card holds, so it stops recording when the card fills. A larger card would last the whole deployment.`,
      );
    } else {
      add(
        'space',
        'Room for the deployment',
        'fail',
        `The deployment needs about ${size(needed)} but only ${size(report.freeBytes)} is free, so recording stops early. Copy off what is on the card and prepare it.`,
      );
    }
  }

  const status = checks.some((check) => check.status === 'fail')
    ? 'not-ready'
    : checks.some((check) => check.status !== 'pass')
      ? 'attention'
      : 'ready';
  return { status, checks };
}

const normalise = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();
