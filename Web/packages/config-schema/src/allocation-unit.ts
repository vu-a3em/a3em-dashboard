import {
  AUDIO_BUFFER_MAX_SIZE_BYTES,
  AUDIO_BYTES_PER_SAMPLE,
  IMU_BYTES_PER_SAMPLE,
  IMU_HEADER_BYTES,
  SD_CARD_ALLOCATION_UNIT_BYTES,
  WAV_STAGING_BUFFER_SIZE_BYTES,
} from './firmware-constants.js';
import { WAV_HEADER_BYTES } from './integrity.js';
import { effectiveSampleRateHz } from './serialize.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';

/**
 * Choosing the SD card's allocation unit (cluster size).
 *
 * This is a genuine trade-off with no universally right answer, which is why it is worth
 * computing per deployment rather than shipping one number.
 *
 * Two things depend on it:
 *
 *  - **Write transactions.** FatFs clips every direct write at a cluster boundary
 *    (`ff.c`, `f_write`: `if (csect + cc > fs->csize) cc = fs->csize - csect;`), so one
 *    large `f_write` becomes one `disk_write` per cluster. A 4 kB unit turns a single
 *    60 s clip into roughly 470 separate transactions.
 *
 *  - **Slack.** Every file rounds up to a whole number of clusters, so each one carries
 *    up to a cluster of unused space in its tail. With one audio file and one IMU file
 *    per clip and thousands of clips per deployment, that adds up to real lost capacity.
 *
 * Bigger units mean fewer transactions and more slack; the two pull in opposite
 * directions and each doubling of the unit halves the transactions while roughly
 * doubling the slack. The recommendation below takes the largest unit whose slack stays
 * inside a capacity budget.
 *
 * A caveat on how much the transaction count is now worth: the firmware holds the card
 * awake across a whole flush rather than powering it up per transaction, so transactions
 * no longer each carry a card wake-up. What remains is SD command overhead, card busy
 * time, and the write amplification a card suffers when writes are smaller than its
 * internal page. Real, and it matters for card longevity, but a second-order effect
 * rather than the dominant one. Slack, by contrast, is capacity you simply do not get.
 */

/**
 * Units offered. All are powers of two, which exFAT requires, and all are achievable
 * with `newfs_exfat -b` or the device's own formatter.
 *
 * The list stops at 512 kB because the firmware's staging buffer is that size: beyond it
 * a clip is a single flush and larger clusters buy no further reduction in transactions
 * while continuing to cost slack.
 */
export const ALLOCATION_UNIT_CHOICES_BYTES = [
  4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288,
] as const;

/**
 * How much of the card we are willing to lose to slack, as a fraction of everything
 * written.
 *
 * 2.5% is a little over a day on a 128 GB card recording continuously at 16 kHz — a
 * cost worth paying for an eightfold cut in transactions, where 5% would not be. This
 * is a judgement call, exposed as a constant so it can be argued with.
 */
export const SLACK_BUDGET_FRACTION = 0.025;

/** Bytes one clip puts on the card, split by file, since the two round up separately. */
export interface ClipFootprint {
  audioBytes: number;
  /** Zero when the phase records no motion data. */
  imuBytes: number;
  /** How much audio the firmware buffers before each write, which floors the transaction count. */
  audioFlushBytes: number;
}

export interface AllocationUnitOption {
  bytes: number;
  /** Unused tail space across one clip's files. */
  slackBytesPerClip: number;
  /** Slack as a fraction of everything the clip occupies, tail space included. */
  slackFraction: number;
  /** `disk_write` calls per clip — audio and IMU together. */
  writeTransactionsPerClip: number;
  /** Capacity lost to slack on the card being planned for. */
  lostCapacityBytes: number;
  withinSlackBudget: boolean;
  /** True for the unit this deployment should use. */
  recommended: boolean;
}

/** How the card's actual unit compares to what this deployment wants. */
export type AllocationUnitVerdict =
  /** Within one step of the recommendation — nothing to do. */
  | 'good'
  /** Smaller than recommended: more transactions than necessary, but no capacity lost. */
  | 'fragmented'
  /** Larger than recommended: capacity is being lost to slack. */
  | 'wasteful'
  /** No card connected, or a card whose firmware does not report its geometry. */
  | 'unknown';

export interface AllocationUnitAdvice {
  recommendedBytes: number;
  /** What the connected card is formatted with, when known. */
  actualBytes: number | null;
  verdict: AllocationUnitVerdict;
  options: AllocationUnitOption[];
  /** The recommended option, for convenience. */
  recommended: AllocationUnitOption;
  /** The connected card's option, when its unit is one we model. */
  actual: AllocationUnitOption | null;
  /** One sentence explaining the verdict, for display. */
  summary: string;
}

/** Unused bytes in the final cluster of a file of `bytes`. */
export function slackBytes(bytes: number, unitBytes: number): number {
  if (bytes <= 0 || unitBytes <= 0) return 0;
  return (unitBytes - (bytes % unitBytes)) % unitBytes;
}

/**
 * On-card size of the two files a single clip produces.
 *
 * Opus is sized from its bitrate rather than the sample rate, and its container overhead
 * is small enough next to a cluster that we do not model it.
 */
export function clipFootprint(phase: PhaseConfig): ClipFootprint {
  const clipSeconds = Math.max(0, phase.audioClipLengthSeconds);

  const audioBytes = phase.useOpusEncoding
    ? Math.round((phase.opusBitrate / 8) * clipSeconds)
    : WAV_HEADER_BYTES + effectiveSampleRateHz(phase) * AUDIO_BYTES_PER_SAMPLE * clipSeconds;

  const imuRate = phase.imuRecordingMode === 'NONE' ? 0 : phase.imuSampleRateHz;
  const imuBytes = imuRate > 0 ? IMU_HEADER_BYTES + imuRate * IMU_BYTES_PER_SAMPLE * clipSeconds : 0;

  return {
    audioBytes,
    imuBytes,
    // Opus streams through the smaller shared buffer; WAV uses the full staging buffer.
    audioFlushBytes: phase.useOpusEncoding ? AUDIO_BUFFER_MAX_SIZE_BYTES : WAV_STAGING_BUFFER_SIZE_BYTES,
  };
}

/**
 * `disk_write` calls one clip costs at a given unit.
 *
 * A file spanning N clusters takes N transactions, but never fewer than the number of
 * separate flushes the firmware performs — once the cluster is larger than the staging
 * buffer, the flush count is the floor and growing the cluster changes nothing.
 */
function transactionsPerClip(footprint: ClipFootprint, unitBytes: number): number {
  const audioFlushes = Math.max(1, Math.ceil(footprint.audioBytes / footprint.audioFlushBytes));
  const audio =
    footprint.audioBytes > 0 ? Math.max(audioFlushes, Math.ceil(footprint.audioBytes / unitBytes)) : 0;
  const imu = footprint.imuBytes > 0 ? Math.max(1, Math.ceil(footprint.imuBytes / unitBytes)) : 0;
  return audio + imu;
}

/**
 * Weighted footprint across a deployment's phases.
 *
 * A card has one cluster size but a deployment can have six phases writing different file
 * sizes, so the phases are combined in proportion to how many clips each contributes.
 * Weights need not sum to anything in particular; only their ratios matter.
 */
export interface WeightedFootprint {
  footprint: ClipFootprint;
  /** Relative number of clips this phase contributes. */
  weight: number;
}

/**
 * Evaluates every candidate unit and picks one.
 *
 * The rule: among units whose slack stays inside the budget, take the one with the fewest
 * transactions, breaking ties toward the smaller unit. Choosing the smaller of a tie
 * matters — past the point where the staging buffer floors the transaction count, larger
 * units are pure loss, and this is what stops the recommendation running away to 512 kB.
 *
 * If even the smallest unit blows the budget — very short clips, where a cluster is large
 * next to the files — the smallest is still the right answer, so it is returned with
 * `withinSlackBudget` false rather than nothing being recommended.
 */
export function allocationUnitOptions(
  phases: WeightedFootprint[],
  cardCapacityBytes: number,
): AllocationUnitOption[] {
  const weighted = phases.filter((p) => p.weight > 0 && (p.footprint.audioBytes > 0 || p.footprint.imuBytes > 0));
  const totalWeight = weighted.reduce((sum, p) => sum + p.weight, 0);

  const options = ALLOCATION_UNIT_CHOICES_BYTES.map((bytes) => {
    let slack = 0;
    let occupied = 0;
    let transactions = 0;
    for (const { footprint, weight } of weighted) {
      const share = weight / totalWeight;
      const fileSlack =
        slackBytes(footprint.audioBytes, bytes) + slackBytes(footprint.imuBytes, bytes);
      slack += share * fileSlack;
      occupied += share * (footprint.audioBytes + footprint.imuBytes + fileSlack);
      transactions += share * transactionsPerClip(footprint, bytes);
    }
    const slackFraction = occupied > 0 ? slack / occupied : 0;
    return {
      bytes,
      slackBytesPerClip: slack,
      slackFraction,
      writeTransactionsPerClip: transactions,
      lostCapacityBytes: cardCapacityBytes * slackFraction,
      withinSlackBudget: slackFraction <= SLACK_BUDGET_FRACTION,
      recommended: false,
    };
  });

  if (totalWeight <= 0) return options;

  const affordable = options.filter((o) => o.withinSlackBudget);
  const candidates = affordable.length > 0 ? affordable : [options[0]!];
  const best = candidates.reduce((a, b) => {
    if (b.writeTransactionsPerClip < a.writeTransactionsPerClip) return b;
    if (b.writeTransactionsPerClip > a.writeTransactionsPerClip) return a;
    return b.bytes < a.bytes ? b : a;
  });
  best.recommended = true;
  return options;
}

/**
 * The full recommendation for a deployment, given how many clips each phase contributes.
 *
 * Clip counts come from the power forecast, which already models duty cycles; passing
 * them in keeps this module free of scheduling arithmetic and independently testable.
 */
export function recommendAllocationUnit(input: {
  config: DeploymentConfig;
  /** Clips each phase contributes, in the same order as `config.phases`. Defaults to equal weight. */
  clipsPerPhase?: number[];
  cardCapacityBytes: number;
  /** From `_a3em.dev`. Null when no card is connected or the firmware predates the field. */
  actualUnitBytes?: number | null;
}): AllocationUnitAdvice {
  const { config, clipsPerPhase, cardCapacityBytes, actualUnitBytes = null } = input;

  const weighted: WeightedFootprint[] = config.phases.map((phase, i) => ({
    footprint: clipFootprint(phase),
    weight: clipsPerPhase?.[i] ?? 1,
  }));

  const options = allocationUnitOptions(weighted, cardCapacityBytes);
  const recommended = options.find((o) => o.recommended) ?? options[0]!;
  const actual = actualUnitBytes !== null ? (options.find((o) => o.bytes === actualUnitBytes) ?? null) : null;

  return {
    recommendedBytes: recommended.bytes,
    actualBytes: actualUnitBytes,
    verdict: verdictFor(recommended.bytes, actualUnitBytes),
    options,
    recommended,
    actual,
    summary: summaryFor(recommended, actual, actualUnitBytes),
  };
}

/**
 * A card within one doubling of the recommendation is left alone.
 *
 * Reformatting means erasing the card, so the advice has to be worth that. One step
 * either way is a difference of about a percent of capacity or a factor of two in
 * transactions, and neither justifies it.
 */
function verdictFor(recommendedBytes: number, actualBytes: number | null): AllocationUnitVerdict {
  if (actualBytes === null || actualBytes <= 0) return 'unknown';
  if (actualBytes >= recommendedBytes / 2 && actualBytes <= recommendedBytes * 2) return 'good';
  return actualBytes < recommendedBytes ? 'fragmented' : 'wasteful';
}

function summaryFor(
  recommended: AllocationUnitOption,
  actual: AllocationUnitOption | null,
  actualBytes: number | null,
): string {
  const rec = formatAllocationUnit(recommended.bytes);
  if (actualBytes === null || actualBytes <= 0) {
    return `Format as exFAT with a ${rec} block size using the following command:`;
  }
  const act = formatAllocationUnit(actualBytes);
  const verdict = verdictFor(recommended.bytes, actualBytes);
  if (verdict === 'good') {
    return `The card's ${act} allocation unit suits this deployment.`;
  }
  if (verdict === 'fragmented') {
    const ratio = actual ? actual.writeTransactionsPerClip / recommended.writeTransactionsPerClip : 0;
    const factor = ratio >= 2 ? `${Math.round(ratio)}× more` : 'more';
    return `The card's ${act} allocation unit costs ${factor} card writes per clip than ${rec} would. Reformatting is optional — it costs no capacity, only card wear.`;
  }
  const lost = actual ? formatBytes(actual.lostCapacityBytes - recommended.lostCapacityBytes) : 'capacity';
  return `The card's ${act} allocation unit wastes about ${lost} more than ${rec} would on files this size. Reformat at ${rec} to get it back.`;
}

/** What the files on a retrieved card actually cost, tail space included. */
export interface CardSlackReport {
  fileCount: number;
  /** Bytes of real data. */
  dataBytes: number;
  /** Bytes lost to partly-used tail clusters. */
  slackBytes: number;
  /** Clusters consumed, in bytes — data plus slack. */
  occupiedBytes: number;
  slackFraction: number;
}

/**
 * Measures the slack a retrieved card is actually carrying.
 *
 * The planning path predicts this from a configuration; this one counts it from the
 * files that came back, which is the honest number and the one worth showing after a
 * deployment. Both need the card's real allocation unit, which is why the firmware
 * records it — it cannot be recovered from the file sizes alone.
 */
export function cardSlack(fileSizes: readonly number[], unitBytes: number): CardSlackReport {
  let dataBytes = 0;
  let slack = 0;
  for (const size of fileSizes) {
    dataBytes += size;
    slack += slackBytes(size, unitBytes);
  }
  const occupiedBytes = dataBytes + slack;
  return {
    fileCount: fileSizes.length,
    dataBytes,
    slackBytes: slack,
    occupiedBytes,
    slackFraction: occupiedBytes > 0 ? slack / occupiedBytes : 0,
  };
}

/** "32 kB", "512 kB", "1 MB" — the form a format dialog uses. */
export function formatAllocationUnit(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

/**
 * The `newfs_exfat` invocation that produces the recommended unit.
 *
 * Shown rather than run where no card helper is installed, so it is the user's to type.
 * Where one is installed, `devicePath` is the real node rather than the placeholder, and
 * the same command is what the helper runs.
 *
 * **`-R` is not optional.** Without it `newfs_exfat` preserves an existing exFAT volume's
 * geometry, and on a card whose cluster size already differs from `-b` it prints
 * "Cluster size differs from command line argument; skipping reformat" — and **exits 0**.
 * The command without `-R` is a silent no-op on exactly the cards this recommendation
 * exists to fix.
 */
export function formatCommandFor(unitBytes: number, devicePath = '/dev/diskNsM'): string {
  return `newfs_exfat -R -b ${unitBytes} ${devicePath}`;
}

/** Whether a deployment written now would be formatted this way by the device itself. */
export const DEVICE_DEFAULT_ALLOCATION_UNIT_BYTES = SD_CARD_ALLOCATION_UNIT_BYTES;
