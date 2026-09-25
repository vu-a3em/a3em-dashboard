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
 * Each check's title says what was found ("Card has files on it"), not what was hoped for, so a
 * title never contradicts the sentence after it.
 *
 * The capacity and write-speed tests overwrite the whole card, so they run only while a card is
 * being prepared, and a check only reports what they found then. A card never tested here gets
 * a note saying so rather than two checks it could never pass: a check is for something the
 * person can act on now.
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
  /** What went wrong reading the layout, in words, when `layoutSkipped` is a failure. */
  layoutError?: string;
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
  /**
   * The name the card is given when prepared for this unit, where the unit's label can be one.
   * Left out for a label too long to be a card's name: then no name is expected of it.
   */
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
  /**
   * What fixes it, where preparing can: `prepare`, only erasing and setting the card up again;
   * `settings`, writing its configuration, which erasing does too. Absent when it passed, was not
   * checked, or is something preparing cannot change — a lock switch, a counterfeit, a card too small.
   */
  fix?: 'prepare' | 'settings';
}

export interface ReadinessVerdict {
  /** `ready`: everything passed. `attention`: nothing failed, but something is unknown or advisory. */
  status: 'ready' | 'attention' | 'not-ready';
  checks: ReadinessCheck[];
  /** Things worth knowing that are not checks and do not affect the status. */
  notes: string[];
}

function size(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  // A few small files read as "0 MB", which looks like nothing at all.
  return bytes >= 1e3 ? `${Math.round(bytes / 1e3)} kB` : `${Math.max(0, bytes)} bytes`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

export function judgeReadiness(report: CardReadinessReport, expected: ReadinessExpectation = {}): ReadinessVerdict {
  const checks: ReadinessCheck[] = [];
  const notes: string[] = [];
  const add = (id: ReadinessCheckId, title: string, status: ReadinessStatus, detail: string) => {
    const fix = fixFor(id, status);
    checks.push(fix ? { id, title, status, detail, fix } : { id, title, status, detail });
  };

  if (report.device.writeProtected) {
    add(
      'write-protect',
      'Card is locked',
      'fail',
      'The switch on its side is at LOCK, so a recorder cannot write to it. Slide the switch away from LOCK and reinsert the card.',
    );
  } else {
    add('write-protect', 'Card is not locked', 'pass', 'The recorder can write to it.');
  }

  const layout = report.layout;
  if (layout) {
    const differing = (layout.regions ?? []).filter((region) => region.status === 'differs').map((region) => region.name);
    if (layout.reference) {
      add(
        'layout',
        'Layout matches the reference',
        'pass',
        `Every structure matches the layout the A3EM formatter writes${layout.clusterBytes ? `, at ${formatAllocationUnit(layout.clusterBytes)} clusters` : ''}.`,
      );
    } else {
      add(
        'layout',
        'Layout differs from the reference',
        'fail',
        layout.problem
          ? `${layout.problem} Prepare the card to give it the reference layout.`
          : `These parts differ: ${differing.join(', ')}. Prepare the card to give it the reference layout.`,
      );
    }
  } else {
    // A helper older than `layoutError` says why only among its problems.
    const reason =
      report.layoutError ??
      report.problems?.find((problem) => problem.startsWith(LAYOUT_UNREAD))?.slice(LAYOUT_UNREAD.length).trim();
    add(
      'layout',
      'Layout not checked',
      'unknown',
      report.layoutSkipped === 'cancelled'
        ? 'Administrator access was not given, so the card’s layout was not read.'
        : report.layoutSkipped === 'needs-admin' || !report.layoutSkipped
          ? 'Reading the card’s layout needs administrator access. Check the card again, and enter the password when asked.'
          : `The card’s layout could not be read: ${reason || 'no reason was given.'} Check the card again; if this keeps happening, please report it with this message.`,
    );
  }

  const capacity = report.prepared?.capacity;
  if (capacity) {
    add(
      'capacity',
      capacity.genuine ? 'Capacity is genuine' : 'Capacity is counterfeit',
      capacity.genuine ? 'pass' : 'fail',
      capacity.genuine
        ? `Tested when this computer prepared it: all ${size(capacity.claimedBytes)} kept what was written.`
        : `It claims ${size(capacity.claimedBytes)}, but only the first ${size(capacity.verifiedBytes)} kept what was written. Recordings past that point would be lost. Do not deploy it.`,
    );
  }

  const latency = report.prepared?.latency;
  if (latency) {
    add(
      'write-speed',
      latency.verdict === 'ok' ? 'Writes keep up' : latency.verdict === 'slow' ? 'Some writes are slow' : 'Writes stall',
      latency.verdict === 'ok' ? 'pass' : 'warn',
      latency.verdict === 'ok'
        ? `Steady at ${latency.mbPerSecond.toFixed(0)} MB/s; the slowest write took ${Math.round(latency.maxMs)} ms.`
        : latency.verdict === 'slow'
          ? `Some writes took ${Math.round(latency.p99Ms)} ms or more. The recorder may lose audio while the card catches up.`
          : `The card stalled for up to ${(latency.maxMs / 1000).toFixed(1)} s on some writes. The recorder may lose audio during stalls; a different card is safer.`,
    );
  }

  if (!report.prepared) {
    notes.push(
      'Capacity and write speed were not checked. Testing them overwrites the whole card, so they will not be verified until a card is prepared on this computer.',
    );
  } else if (!capacity || !latency) {
    const untested = [capacity ? null : 'capacity', latency ? null : 'write speed'].filter(Boolean);
    notes.push(`This card was prepared on this computer without testing its ${untested.join(' or ')}.`);
  }

  if (report.geometry) {
    const format = judgeCardFormat(report.geometry, expected.allocationUnitBytes ?? null);
    const worst = format.issues.find((issue) => issue.severity === 'critical') ?? format.issues[0];
    if (!worst) {
      add('format', 'Format suits the firmware', 'pass', 'exFAT on an MBR partition, as the firmware requires.');
    } else {
      add(
        'format',
        worst.severity === 'critical' ? 'Format will not work in the recorder' : 'Format works, with a caveat',
        worst.severity === 'critical' ? 'fail' : 'warn',
        [worst.message, worst.remedy].filter(Boolean).join(' '),
      );
    }
  } else {
    add('format', 'No readable volume', 'fail', 'The system cannot read a volume on the card. Prepare it before use.');
  }

  const contents = report.contents;
  if (!contents) {
    add('empty', 'Contents not checked', 'unknown', 'The card is not mounted, so its files could not be read.');
  } else if (contents.files + contents.directories === 0) {
    add('empty', 'Card is empty', 'pass', report.config?.present ? `Nothing on it besides ${CONFIG_FILE_NAME}.` : 'Nothing is on it.');
  } else {
    const what = contents.files > 0 ? `${plural(contents.files, 'file')} (${size(contents.bytes)})` : plural(contents.directories, 'folder');
    add(
      'empty',
      'Card has files on it',
      'warn',
      `It holds ${contents.truncated ? 'at least ' : ''}${what} from before${
        contents.examples?.length ? `, such as ${contents.examples.slice(0, 2).join(' and ')}` : ''
      }. The recorder adds its own beside them, so the card fills sooner. Copy them off and prepare the card if they are not needed.`,
    );
  }

  const config = report.config;
  if (!config) {
    add('config', 'Configuration not checked', 'unknown', 'The card is not mounted, so its configuration could not be read.');
  } else if (!config.present) {
    add(
      'config',
      'No configuration file',
      'fail',
      `There is no ${CONFIG_FILE_NAME}. Without one, the recorder shows its missing-configuration light and restarts every 15 seconds instead of recording.`,
    );
  } else if (config.tooLarge || config.text === undefined) {
    add('config', 'Configuration file is too large', 'fail', `${CONFIG_FILE_NAME} is ${size(config.bytes)}, far larger than any configuration.`);
  } else {
    const parsed = parseConfig(config.text);
    const parsedOk = parsed.warnings.length === 0;
    add(
      'config',
      parsedOk ? 'Configuration file reads cleanly' : 'Configuration file may be misread',
      parsedOk ? 'pass' : 'warn',
      parsedOk
        ? `${CONFIG_FILE_NAME} for ${parsed.config.deviceLabel || 'an unlabeled device'} reads without problems.`
        : `${CONFIG_FILE_NAME} reads here, but the recorder may not read it the same way: ${parsed.warnings[0]}`,
    );
  }
  if (expected.configText != null && config?.present && config.text !== undefined) {
    const same = normalize(config.text) === normalize(expected.configText);
    add(
      'config-match',
      same ? 'Configuration matches this device' : 'Configuration is not this device’s',
      same ? 'pass' : 'fail',
      same
        ? 'Identical to the configuration being prepared.'
        : 'The configuration on the card differs from the one being prepared for this device.',
    );
  }

  /*
    The card's name, which the recorder never reads: a card named otherwise is as ready as one
    named for its unit, so a different name is a note rather than a check that could make it
    less than ready. Writing only the settings leaves the name as it was, so a card prepared
    again as another unit keeps the name it had.
  */
  if (expected.volumeLabel && report.volume) {
    const label = report.volume.label ?? '';
    if (label === expected.volumeLabel) {
      add('label', 'Card name matches', 'pass', `The card is named ${label}.`);
    } else {
      notes.push(
        `The card is named ${label || 'nothing'} rather than ${expected.volumeLabel}. The recorder does not read the name; it only helps people tell cards apart.`,
      );
    }
  }

  if (expected.requiredBytes != null && report.freeBytes != null) {
    const needed = expected.requiredBytes;
    if (report.freeBytes >= needed) {
      add('space', 'Room for the deployment', 'pass', `The deployment needs about ${size(needed)}; ${size(report.freeBytes)} is free.`);
    } else if (needed > report.device.sizeBytes) {
      // No card of this size could hold it: the plan's limit, which the forecast already states.
      add(
        'space',
        'Card too small for the whole deployment',
        'warn',
        `The deployment needs about ${size(needed)}, more than this ${size(report.device.sizeBytes)} card holds, so it stops recording when the card fills. A larger card would last the whole deployment.`,
      );
    } else {
      add(
        'space',
        'Not enough free space',
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
  return { status, checks, notes };
}

/** What fixes each check when it fails or warns. The rest are beyond what preparing can change. */
const FIXES: Partial<Record<ReadinessCheckId, 'prepare' | 'settings'>> = {
  layout: 'prepare',
  format: 'prepare',
  empty: 'prepare',
  space: 'prepare',
  config: 'settings',
  'config-match': 'settings',
};

function fixFor(id: ReadinessCheckId, status: ReadinessStatus): 'prepare' | 'settings' | undefined {
  if (status === 'pass' || status === 'unknown') return undefined;
  // A card too small for the whole deployment is too small however it is prepared.
  if (id === 'space' && status === 'warn') return undefined;
  return FIXES[id];
}

/**
 * The least work that makes a checked card ready: what "Prepare this card" will do with it.
 *
 *  - `erase` — something only erasing and setting the card up again fixes: its layout, its
 *    format, what is on it, or room for the deployment.
 *  - `settings` — only the configuration is missing or not this unit's, so writing it is
 *    enough and nothing is erased.
 *  - `none` — nothing preparing could improve.
 *  - `blocked` — preparing cannot help: the card is locked, or its capacity is counterfeit.
 *
 * Each names, by the checks' titles, everything it fixes — not only what made it necessary:
 * erasing also writes the configuration — and what it cannot fix, so nothing is promised that
 * will not happen.
 */
export type PreparationPlan =
  | { kind: 'blocked'; reason: string }
  | { kind: 'erase'; fixes: string[]; cannotFix: string[] }
  | { kind: 'settings'; fixes: string[]; cannotFix: string[] }
  | { kind: 'none' };

export function planPreparation(verdict: ReadinessVerdict): PreparationPlan {
  const failed = (id: ReadinessCheckId) => verdict.checks.some((check) => check.id === id && check.status === 'fail');
  if (failed('write-protect')) {
    return { kind: 'blocked', reason: 'The card is locked. Slide the switch on its side away from LOCK, reinsert it, and check it again.' };
  }
  if (failed('capacity')) {
    return { kind: 'blocked', reason: 'Its capacity is counterfeit, which preparing cannot change. Do not deploy it.' };
  }
  const titles = (checks: ReadinessCheck[]) => checks.map((check) => check.title);
  const cannotFix = titles(verdict.checks.filter((check) => !check.fix && (check.status === 'fail' || check.status === 'warn')));
  if (verdict.checks.some((check) => check.fix === 'prepare')) {
    return { kind: 'erase', fixes: titles(verdict.checks.filter((check) => check.fix)), cannotFix };
  }
  const settings = verdict.checks.filter((check) => check.fix === 'settings');
  if (settings.length) {
    return { kind: 'settings', fixes: titles(settings), cannotFix };
  }
  return { kind: 'none' };
}

/** How the helper begins the problem it records when a layout cannot be read. */
const LAYOUT_UNREAD = "The card's layout could not be read:";

const normalize = (text: string) => text.replace(/\r\n/g, '\n').trimEnd();
