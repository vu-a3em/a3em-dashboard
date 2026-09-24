import {
  AUDIO_BYTES_PER_SAMPLE,
  IMU_BYTES_PER_SAMPLE,
  NUM_HOURS_PER_AUDIO_DIRECTORY,
  TIME_SCALE_SECONDS,
} from '../firmware-constants.js';
import { effectiveSampleRateHz } from '../serialize.js';
import { DEFAULT_FIRMWARE_PROFILE, type FirmwareProfile } from '../firmware-profile.js';
import { clipFootprint, recommendAllocationUnit } from '../allocation-unit.js';
import {
  BUCKET_DIRECTORY_NAME_LENGTH,
  BUCKET_LOG_NAME_LENGTH,
  BYTES_PER_MARKETED_GB,
  RECORDING_NAME_LENGTH,
  clustersFor,
  directoryEntryBytes,
  marketedCardLayout,
} from '../card-capacity.js';
import {
  deviceUtcOffsetSeconds,
  periodDuration,
  periodSegments,
  recordedSecondsInPeriods,
  scheduleOnDay,
} from '../schedule.js';
import { formatZonedDate } from '../timezone.js';
import type { DeploymentConfig, PhaseConfig, TriggerWindow, ValidationIssue } from '../types.js';
import {
  BUFFERS,
  Confidence,
  DEFAULTS,
  DEFAULT_MICROPHONE,
  DEFAULT_SD_SPEED_CLASS,
  IDLE_STATE,
  IMU_CURRENT_MA,
  LED,
  MAGNET,
  MCU,
  MEASUREMENTS_REVISION,
  MICROPHONE_CURRENT_MA,
  Measurement,
  OPUS_ENCODE_MS_BY_BITRATE,
  SD_BUS_CEILING_MB_PER_S,
  SD_CARD,
  SD_SPEED_CLASS_MB_PER_S,
  VHF,
  WAV_PROCESSING_MS_PER_INTERVAL,
  weakestConfidence,
} from './measurements.js';

/**
 * Storage and battery forecasting.
 *
 * The arithmetic in `recordingCurrentMa()` is a direct port of the Calculations
 * sheet, and `forecast.test.ts` pins it against the spreadsheet's own outputs so a
 * refactor cannot quietly change the answer.
 *
 * The spreadsheet models CONTINUOUS recording only. Everything here that involves
 * a duty cycle — scheduled windows, intervals, trigger caps, LEDs, VHF — is an
 * extension, and every extended path reports reduced confidence.
 *
 * Storage is modeled the way the card will actually be laid out rather than as a pool of
 * bytes: the formatter's exFAT geometry decides what is free, and every file the device
 * writes rounds up to whole clusters, directories and logs included. The spreadsheet's
 * byte-pool model is kept as `storageModel: 'raw'` so the parity tests can still ask it
 * the spreadsheet's own question.
 */

export interface ForecastInputs {
  config: DeploymentConfig;
  /** Marketed size, in the decimal gigabytes printed on the card. */
  sdCardCapacityGb?: number;
  batteryCapacityMah?: number;
  sdSpeedClass?: string;
  microphone?: string;
  /**
   * Which firmware the card is destined for. Matters because a zero clip cap means
   * "never record" on legacy units and "unlimited" from 2026.08 onward — opposite
   * ends of the storage range. Defaults to the legacy profile.
   */
  firmware?: FirmwareProfile;
  /**
   * The cluster size the card is, or will be, formatted with. Defaults to the size this
   * deployment is recommended, which is what the formatter will be told to use.
   */
  allocationUnitBytes?: number;
  /**
   * `exfat` (the default) lays the card out as the formatter does and charges every file
   * its whole clusters. `raw` is the planner spreadsheet's model — capacity as GB × 1024³
   * and nothing but the recorded bytes — kept so the port can be checked against the sheet.
   */
  storageModel?: 'exfat' | 'raw';
}

export interface PhaseForecast {
  phaseName: string;
  dutyCycle: number;
  /** Recorded data per day, before the card's own overhead. */
  bytesPerDay: number;
  /** What a day costs on the card: whole clusters per file, plus directories and logs. */
  cardBytesPerDay: number;
  averageCurrentMa: number;
  clipsPerDay: number;
  audioSecondsPerDay: number;
}

/** What stops the recording before the configured end, if anything does. */
export type EarlyStop = 'card' | 'battery' | null;

export interface Forecast {
  /** Written to the card over the whole deployment, capped at what the card holds. */
  totalBytes: number;
  /**
   * The AVERAGE day, weighted by each phase's share of the deployment — not any
   * particular day. A deployment whose phases record at different rates has no
   * typical day, so the per-phase figures in `perPhase` are what to show when there
   * is more than one.
   */
  bytesPerDay: number;
  /** The average day's cost on the card, overhead included. */
  cardBytesPerDay: number;
  clipsPerDay: number;
  averageCurrentMa: number;

  deploymentDays: number;
  /** Days until the card is full at this rate. Infinity when it never fills. */
  storageDays: number;
  /** Days until the battery is exhausted. */
  batteryDays: number;

  /** ISO instant the card fills, or null if it lasts the whole deployment. */
  cardFullAt: string | null;
  /** ISO instant the battery dies, or null if it lasts the whole deployment. */
  batteryDeadAt: string | null;
  /** Whichever of the two ends recording first, when one of them does. */
  stopsEarlyBecause: EarlyStop;
  /** Days of recording the deployment actually gets. */
  recordingDays: number;

  totalClips: number;
  totalAudioHours: number;

  /** Bytes available to recordings on a freshly formatted card. */
  cardUsableBytes: number;
  /** The cluster size the card figures assume, or null under the raw model. */
  allocationUnitBytes: number | null;
  /**
   * Clips each phase contributes over its span, in `config.phases` order. What the cluster
   * size was recommended from, so a caller asking `recommendAllocationUnit` about a connected
   * card gets the same recommendation this forecast used.
   */
  clipWeights: number[];
  cardUsedFraction: number;
  confidence: Confidence;
  /** Human-readable notes on what limits the forecast's accuracy. */
  caveats: string[];
  perPhase: PhaseForecast[];
  measurementsRevision: string;
}

const SECONDS_PER_DAY = 86400;
const RAW_BYTES_PER_GB = 1024 ** 3;
const BUCKET_SECONDS = NUM_HOURS_PER_AUDIO_DIRECTORY * 3600;
const BUCKETS_PER_DAY = SECONDS_PER_DAY / BUCKET_SECONDS;
/** Enough days to see a whole year's worth of sunrise without walking a decade of them. */
const MAX_SCHEDULE_SAMPLES = 366;

export function forecast(inputs: ForecastInputs): Forecast {
  const {
    config,
    sdCardCapacityGb = DEFAULTS.sdCardCapacityGb,
    batteryCapacityMah = DEFAULTS.batteryCapacityMah,
    sdSpeedClass = DEFAULT_SD_SPEED_CLASS,
    microphone = DEFAULT_MICROPHONE,
    firmware = DEFAULT_FIRMWARE_PROFILE,
    storageModel = 'exfat',
  } = inputs;

  const start = Date.parse(config.startTime);
  const end = Date.parse(config.endTime);
  const deploymentDays = Math.max(0, (end - start) / 1000 / SECONDS_PER_DAY);

  const caveats: string[] = [];
  const contributing: Measurement[] = [
    MCU.idleCurrentMa,
    MCU.activeCurrentMa,
    SD_CARD.writeCurrentMa,
  ];

  /* Everything about each phase that does not depend on the card. */
  const phases = config.phases.map((phase, phaseIndex) => {
    const segment = phaseSegment(phase, config, phaseIndex, start, deploymentDays);
    const share =
      deploymentDays > 0
        ? Math.max(0, segment.endDay - segment.startDay) / deploymentDays
        : 1 / config.phases.length;
    const activity = phaseActivity(phase, config, segment, start, caveats, firmware);
    const duty = activity.duty;
    const rate = effectiveSampleRateHz(phase);

    const audioBytesPerSecond = phase.useOpusEncoding
      ? phase.opusBitrate / 8
      : rate * AUDIO_BYTES_PER_SAMPLE;
    const imuRate = imuEffectiveSampleRate(phase);
    const imuBytesPerSecond = imuRate * IMU_BYTES_PER_SAMPLE;

    // IMU in AUDIO mode only streams while a clip is open, so it shares the audio
    // duty cycle. In ACTIVITY mode it streams on motion, which we cannot predict.
    const imuDuty = imuDutyCycle(phase, duty);
    if (phase.imuRecordingMode === 'ACTIVITY') {
      caveats.push(
        `Phase "${phase.name}" records motion on movement, which cannot be predicted. ` +
          `Storage assumes the device is disturbed ${Math.round(MOTION_DUTY_ASSUMPTION * 100)}% of the time.`,
      );
    }

    const audioBytesPerDay = duty * audioBytesPerSecond * SECONDS_PER_DAY;
    const imuBytesPerDay = imuDuty * imuBytesPerSecond * SECONDS_PER_DAY;

    const recordingMa = recordingCurrentMa(phase, {
      sdSpeedClass,
      microphone,
      imuSampleRateHz: imuRate,
    });
    const idleMa = idleCurrentMa(phase, microphone);
    let averageMa = duty * recordingMa + (1 - duty) * idleMa;

    if (config.ledsEnabled && config.ledsActiveSeconds > 0) {
      const ledDays = config.ledsActiveSeconds / SECONDS_PER_DAY;
      const ledShare = deploymentDays > 0 ? Math.min(1, ledDays / deploymentDays) : 0;
      averageMa += ledShare * LED.averageCurrentMa.value;
      contributing.push(LED.averageCurrentMa);
    }

    const clipsPerDay =
      phase.audioClipLengthSeconds > 0
        ? (duty * SECONDS_PER_DAY) / phase.audioClipLengthSeconds
        : 0;

    if (duty < 1) contributing.push(IDLE_STATE.mcuCurrentMa);
    if (phase.audioRecordingMode === 'AMPLITUDE') contributing.push(IDLE_STATE.comparatorCurrentMa);

    return {
      phase,
      segment,
      share,
      duty,
      bucketsPerDay: activity.bucketsPerDay,
      audioBytesPerDay,
      imuBytesPerDay,
      averageMa,
      clipsPerDay,
    };
  });

  const clipWeights = phases.map(
    (entry) => entry.clipsPerDay * Math.max(0, Math.min(deploymentDays, entry.segment.endDay) - Math.max(0, entry.segment.startDay)),
  );

  /* The card: its usable capacity, and what each phase's day costs on it. */
  let allocationUnitBytes: number | null = null;
  let cardUsableBytes: number;
  if (storageModel === 'raw') {
    cardUsableBytes = sdCardCapacityGb * RAW_BYTES_PER_GB;
  } else {
    allocationUnitBytes =
      inputs.allocationUnitBytes ??
      recommendAllocationUnit({
        config,
        clipsPerPhase: clipWeights,
        cardCapacityBytes: sdCardCapacityGb * BYTES_PER_MARKETED_GB,
      }).recommendedBytes;
    cardUsableBytes = marketedCardLayout(sdCardCapacityGb, allocationUnitBytes).freeBytes;
  }

  const perPhase: PhaseForecast[] = phases.map((entry) => {
    const bytesPerDay = entry.audioBytesPerDay + entry.imuBytesPerDay;
    return {
      phaseName: entry.phase.name,
      dutyCycle: entry.duty,
      bytesPerDay,
      cardBytesPerDay:
        allocationUnitBytes === null
          ? bytesPerDay
          : cardBytesPerDayFor(entry.phase, entry.clipsPerDay, entry.imuBytesPerDay, entry.bucketsPerDay, allocationUnitBytes),
      averageCurrentMa: entry.averageMa,
      clipsPerDay: entry.clipsPerDay,
      audioSecondsPerDay: entry.duty * SECONDS_PER_DAY,
    };
  });

  const weighted = (pick: (phase: PhaseForecast) => number) =>
    perPhase.reduce((sum, phase, index) => sum + pick(phase) * phases[index].share, 0);

  // The VHF beacon runs continuously from activation to the end of the deployment.
  const vhfStartDay =
    config.vhfMode === 'NEVER'
      ? null
      : Math.max(0, ((config.vhfMode === 'END' ? end : Date.parse(config.vhfStartTime)) - start) / 1000 / SECONDS_PER_DAY);
  let averageCurrentMa = weighted((phase) => phase.averageCurrentMa);
  // The beacon has its own battery today, which the measurement records as zero draw.
  if (vhfStartDay !== null && VHF.activeCurrentMa.value > 0) {
    const vhfDays = Math.max(0, deploymentDays - vhfStartDay);
    if (vhfDays > 0 && deploymentDays > 0) {
      averageCurrentMa += (vhfDays / deploymentDays) * VHF.activeCurrentMa.value;
      contributing.push(VHF.activeCurrentMa);
      caveats.push('VHF beacon current is a placeholder and has not been measured.');
    }
  }

  const timeline = perPhase
    .map((phase, index) => ({ ...phase, ...phases[index].segment }))
    .sort((a, b) => a.startDay - b.startDay);

  /*
    The battery, drained phase by phase in the order they run.

    At the deployment's average a heavy phase early would appear to leave the battery for
    longer than it does, exactly as it did for the card. Past the end of the deployment
    there is no schedule to follow, so the figure is extrapolated at the average rate.
  */
  const batteryDeadDay = drainBattery(timeline, batteryCapacityMah, deploymentDays, vhfStartDay);
  const batteryDays =
    batteryDeadDay ?? (averageCurrentMa > 0 ? batteryCapacityMah / averageCurrentMa / 24 : Infinity);

  /*
    Run the phases in order and fill the card as they go, stopping wherever recording does.

    Recording ends when the card fills or the battery gives out, whichever comes first, so
    the clip and audio-hour totals stop there too — otherwise they would describe more
    recording than the meters above them say the deployment can make.
  */
  const recordableDays = Math.min(deploymentDays, batteryDeadDay ?? Infinity);
  let totalBytes = 0;
  let totalClips = 0;
  let totalAudioSeconds = 0;
  let cardFullDay: number | null = null;

  for (const segment of timeline) {
    if (cardFullDay !== null) break;
    const from = Math.max(0, segment.startDay);
    const days = Math.min(recordableDays, segment.endDay) - from;
    if (days <= 0) continue;

    let recorded = days;
    if (segment.cardBytesPerDay > 0) {
      const remaining = cardUsableBytes - totalBytes;
      if (remaining <= days * segment.cardBytesPerDay) {
        recorded = Math.max(0, remaining / segment.cardBytesPerDay);
        cardFullDay = from + recorded;
      }
    }

    totalBytes += recorded * segment.cardBytesPerDay;
    totalClips += recorded * segment.clipsPerDay;
    totalAudioSeconds += recorded * segment.audioSecondsPerDay;
  }

  // Exact when the card fills; otherwise the average rate extrapolated past the end.
  const cardBytesPerDay = weighted((phase) => phase.cardBytesPerDay);
  const storageDays = cardFullDay ?? (cardBytesPerDay > 0 ? cardUsableBytes / cardBytesPerDay : Infinity);

  const cardFullAt = cardFullDay !== null && cardFullDay < deploymentDays ? isoAfterDays(start, cardFullDay) : null;
  const batteryDeadAt = batteryDeadDay !== null && batteryDeadDay < deploymentDays ? isoAfterDays(start, batteryDeadDay) : null;
  let stopsEarlyBecause: EarlyStop = null;
  if (cardFullAt && (!batteryDeadAt || cardFullDay! <= batteryDeadDay!)) stopsEarlyBecause = 'card';
  else if (batteryDeadAt) stopsEarlyBecause = 'battery';

  return {
    totalBytes,
    bytesPerDay: weighted((phase) => phase.bytesPerDay),
    cardBytesPerDay,
    clipsPerDay: weighted((phase) => phase.clipsPerDay),
    averageCurrentMa,
    deploymentDays,
    storageDays,
    batteryDays,
    cardFullAt,
    batteryDeadAt,
    stopsEarlyBecause,
    recordingDays: Math.min(deploymentDays, cardFullDay ?? Infinity, batteryDeadDay ?? Infinity),
    totalClips: Math.round(totalClips),
    totalAudioHours: totalAudioSeconds / 3600,
    cardUsableBytes,
    allocationUnitBytes,
    clipWeights,
    cardUsedFraction: cardUsableBytes > 0 ? Math.min(1, totalBytes / cardUsableBytes) : 0,
    confidence: weakestConfidence(...contributing),
    caveats: [...new Set(caveats)],
    perPhase,
    measurementsRevision: MEASUREMENTS_REVISION,
  };
}

/**
 * Readiness warnings for a deployment that will stop before its end date.
 *
 * Warnings rather than errors: running a unit until its card or battery gives out is an
 * ordinary way to deploy, and nothing about the configuration is wrong. What is worth
 * saying before the card is written is that the end date will not be reached.
 */
export function forecastIssues(plan: Forecast, timezone: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const short = (days: number) => {
    const remaining = Math.max(1, Math.round(plan.deploymentDays - days));
    return remaining === 1 ? '1 day' : `${remaining} days`;
  };
  if (plan.cardFullAt) {
    issues.push({
      severity: 'warning',
      path: 'forecast.card',
      message:
        `The card is expected to fill on ${formatZonedDate(plan.cardFullAt, timezone)}, about ` +
        `${short(plan.storageDays)} before the deployment ends. Recording stops when it does.`,
    });
  }
  if (plan.batteryDeadAt) {
    issues.push({
      severity: 'warning',
      path: 'forecast.battery',
      message:
        plan.stopsEarlyBecause === 'battery'
          ? `The battery is expected to run out on ${formatZonedDate(plan.batteryDeadAt, timezone)}, about ` +
            `${short(plan.batteryDays)} before the deployment ends. Recording stops when it does.`
          : // The card fills first, and nothing here models what the device draws after that,
            // so this is what the battery would do if recording carried on.
            `If the card did not fill first, the battery would run out on ` +
            `${formatZonedDate(plan.batteryDeadAt, timezone)}, about ${short(plan.batteryDays)} before the deployment ends.`,
    });
  }
  return issues;
}

/**
 * Fraction of wall-clock time the device is actively writing audio.
 *
 * CONTINUOUS is 1 by definition. SCHEDULED and INTERVAL are exact. AMPLITUDE is a
 * WORST CASE — it assumes every permitted clip is triggered, because the true rate
 * depends on how noisy the site is, which no model can know.
 *
 * A solar schedule changes from day to day, so its duty cycle depends on WHEN the phase
 * runs and WHERE; pass `context` to have it resolved day by day the way the device does.
 * Without one, a solar phase is judged by its fallback periods alone.
 */
export function dutyCycle(
  phase: PhaseConfig,
  caveats: string[] = [],
  firmware: FirmwareProfile = DEFAULT_FIRMWARE_PROFILE,
  context?: ScheduleContext,
): number {
  switch (phase.audioRecordingMode) {
    case 'CONTINUOUS':
      return 1;

    case 'SCHEDULED':
      return scheduledActivity(phase, caveats, context).duty;

    case 'INTERVAL': {
      const intervalSeconds =
        phase.audioTriggerInterval * TIME_SCALE_SECONDS[phase.audioTriggerIntervalTimeScale];
      if (intervalSeconds <= 0) return 0;
      return Math.min(1, phase.audioClipLengthSeconds / intervalSeconds);
    }

    case 'AMPLITUDE': {
      const windowSeconds = TIME_SCALE_SECONDS[phase.maxClipsTimeScale];
      if (windowSeconds <= 0) return 0;

      if (phase.maxAudioClips <= 0) {
        // Zero means opposite things depending on firmware: "never arm the trigger"
        // on legacy units, "no limit" from 2026.08 onward.
        if (!firmware.capabilities.zeroClipCapIsRewritten) return 0;
        caveats.push(
          `Phase "${phase.name}" has no cap on clips, so it could record continuously. ` +
            `These figures assume it does — the true rate depends on how noisy the site is.`,
        );
        return 1;
      }

      caveats.push(
        `Phase "${phase.name}" records on sound, so its storage and battery figures are a ` +
          `worst case assuming every permitted clip fires.`,
      );
      return Math.min(1, (phase.maxAudioClips * phase.audioClipLengthSeconds) / windowSeconds);
    }
  }
}

/** Where and when a scheduled phase runs, for resolving a solar schedule. */
export interface ScheduleContext {
  config: Pick<DeploymentConfig, 'latitude' | 'longitude' | 'timezone' | 'startTime'>;
  /** The span the phase covers, as epoch milliseconds. */
  fromMs: number;
  toMs: number;
}

interface Activity {
  duty: number;
  /** Four-hour directory buckets a day of this phase writes into. */
  bucketsPerDay: number;
}

function phaseActivity(
  phase: PhaseConfig,
  config: DeploymentConfig,
  segment: { startDay: number; endDay: number },
  start: number,
  caveats: string[],
  firmware: FirmwareProfile,
): Activity {
  if (phase.audioRecordingMode === 'SCHEDULED') {
    return scheduledActivity(phase, caveats, {
      config,
      fromMs: start + segment.startDay * SECONDS_PER_DAY * 1000,
      toMs: start + segment.endDay * SECONDS_PER_DAY * 1000,
    });
  }
  const duty = dutyCycle(phase, caveats, firmware);
  if (duty <= 0) return { duty, bucketsPerDay: 0 };
  // An interval longer than a bucket leaves some buckets empty.
  if (phase.audioRecordingMode === 'INTERVAL') {
    const intervalSeconds = phase.audioTriggerInterval * TIME_SCALE_SECONDS[phase.audioTriggerIntervalTimeScale];
    return { duty, bucketsPerDay: Math.min(BUCKETS_PER_DAY, SECONDS_PER_DAY / Math.max(1, intervalSeconds)) };
  }
  return { duty, bucketsPerDay: BUCKETS_PER_DAY };
}

/**
 * The scheduled duty cycle, as the device will run it.
 *
 * Each sampled day is resolved by `scheduleOnDay`, which mirrors the firmware: solar
 * windows against that day's sun, the clock periods where the sun gives none, and
 * continuous recording where there is nothing to schedule by at all. A clip that starts in
 * a period runs to its full length, so each period records whole clips.
 */
function scheduledActivity(phase: PhaseConfig, caveats: string[], context?: ScheduleContext): Activity {
  const clip = phase.audioClipLengthSeconds;
  const solar = phase.audioScheduleType === 'SOLAR' && phase.audioSolarWindows.length > 0;

  const summarize = (periods: TriggerWindow[], continuous: boolean, offsetSeconds: number) => ({
    seconds: continuous ? SECONDS_PER_DAY : Math.min(SECONDS_PER_DAY, recordedSecondsInPeriods(periods, clip)),
    buckets: continuous ? BUCKETS_PER_DAY : bucketsTouched(periods, offsetSeconds),
  });

  if (!solar || !context) {
    const offset = context ? deviceUtcOffsetSeconds(context.config) : 0;
    if (phase.audioTriggerTimes.length === 0) {
      caveats.push(
        `Phase "${phase.name}" has no recording periods, and a scheduled phase with nothing to ` +
          'schedule by records continuously. These figures assume it does.',
      );
    }
    const day = summarize(phase.audioTriggerTimes, phase.audioTriggerTimes.length === 0, offset);
    return { duty: day.seconds / SECONDS_PER_DAY, bucketsPerDay: day.buckets };
  }

  const offset = deviceUtcOffsetSeconds(context.config);
  const spanMs = Math.max(0, context.toMs - context.fromMs);
  const days = Math.max(1, Math.ceil(spanMs / (SECONDS_PER_DAY * 1000)));
  const samples = Math.min(days, MAX_SCHEDULE_SAMPLES);
  let seconds = 0;
  let buckets = 0;
  let fallbackDays = 0;
  let continuousDays = 0;
  for (let i = 0; i < samples; i++) {
    // The middle of each sampled day, so a sample never lands on a day boundary.
    const at = context.fromMs + ((i + 0.5) / samples) * spanMs;
    const day = scheduleOnDay(phase, context.config, Math.floor(at / 1000), offset);
    const summary = summarize(day.periods, day.continuous, offset);
    seconds += summary.seconds;
    buckets += summary.buckets;
    if (day.usedFallback) fallbackDays++;
    if (day.continuous) continuousDays++;
  }

  if (context.config.latitude === null || context.config.longitude === null) {
    caveats.push(
      `Phase "${phase.name}" follows the sun but the deployment has no position, so the device ` +
        'will use its fallback periods every day. These figures assume it does.',
    );
  } else if (continuousDays > 0) {
    caveats.push(
      `On about ${Math.round((continuousDays / samples) * 100)}% of days the sun gives phase ` +
        `"${phase.name}" no usable period and there are no fallback periods, so the device records ` +
        'continuously on those days. These figures include that.',
    );
  } else if (fallbackDays > 0) {
    caveats.push(
      `On about ${Math.round((fallbackDays / samples) * 100)}% of days the sun gives phase ` +
        `"${phase.name}" no usable period, and the device uses its fallback periods instead.`,
    );
  }

  return { duty: seconds / samples / SECONDS_PER_DAY, bucketsPerDay: buckets / samples };
}

/**
 * How many of the day's four-hour directories the periods write into.
 *
 * The firmware buckets by UTC epoch, not by local time (`storage.c`,
 * `ensure_audio_directory`), so the local periods are shifted back onto UTC first.
 */
function bucketsTouched(periods: readonly TriggerWindow[], utcOffsetSeconds: number): number {
  const touched = new Set<number>();
  for (const period of periods) {
    if (periodDuration(period) <= 0) continue;
    for (const segment of periodSegments(period)) {
      const from = segment.startSecond - utcOffsetSeconds;
      const to = segment.endSecond - utcOffsetSeconds;
      for (let bucket = Math.floor(from / BUCKET_SECONDS); bucket * BUCKET_SECONDS < to; bucket++) {
        touched.add(((bucket % BUCKETS_PER_DAY) + BUCKETS_PER_DAY) % BUCKETS_PER_DAY);
      }
    }
  }
  return touched.size;
}

/**
 * What one day of a phase costs on the card.
 *
 * Every recording rounds up to whole clusters, one audio file and — when motion is recorded
 * with the audio — one IMU file per clip. Each four-hour bucket the day writes into is a
 * directory of its own with a log in it, and each day is a directory holding the buckets.
 * Directories grow in whole clusters as their entries fill them. The logs are assumed to
 * fit in one cluster each, which a four-hour log does comfortably at any cluster size the
 * dashboard recommends.
 */
function cardBytesPerDayFor(
  phase: PhaseConfig,
  clipsPerDay: number,
  imuBytesPerDay: number,
  bucketsPerDay: number,
  clusterBytes: number,
): number {
  if (clipsPerDay <= 0 && imuBytesPerDay <= 0) return 0;
  const footprint = clipFootprint(phase);
  const imuPerClip = phase.imuRecordingMode === 'AUDIO' && footprint.imuBytes > 0;
  const filesPerClip = imuPerClip ? 2 : 1;
  const clipClusters = clustersFor(footprint.audioBytes, clusterBytes) + (imuPerClip ? clustersFor(footprint.imuBytes, clusterBytes) : 0);
  // Motion recorded on movement is written as it comes, so it is charged by the byte.
  const activityImuBytes = phase.imuRecordingMode === 'ACTIVITY' ? imuBytesPerDay : 0;

  const buckets = Math.max(bucketsPerDay, clipsPerDay > 0 ? 1 : 0);
  const filesPerBucket = buckets > 0 ? (clipsPerDay * filesPerClip) / buckets : 0;
  const bucketDirectoryClusters = Math.max(
    1,
    Math.ceil(
      (filesPerBucket * directoryEntryBytes(RECORDING_NAME_LENGTH + (phase.useOpusEncoding ? 1 : 0)) +
        directoryEntryBytes(BUCKET_LOG_NAME_LENGTH)) /
        clusterBytes,
    ),
  );
  const logClusters = 1;
  const dayDirectoryClusters = Math.max(1, Math.ceil((buckets * directoryEntryBytes(BUCKET_DIRECTORY_NAME_LENGTH)) / clusterBytes));

  return (
    clipsPerDay * clipClusters * clusterBytes +
    buckets * (bucketDirectoryClusters + logClusters) * clusterBytes +
    dayDirectoryClusters * clusterBytes +
    activityImuBytes
  );
}

/**
 * The day the battery is exhausted, drawing each phase's current in the order they run.
 *
 * Returns null when it outlasts the deployment. Gaps between phases draw nothing here, as
 * they draw nothing in the per-phase figures; the VHF beacon adds its current from the
 * moment it starts.
 */
function drainBattery(
  timeline: Array<PhaseForecast & { startDay: number; endDay: number }>,
  capacityMah: number,
  deploymentDays: number,
  vhfStartDay: number | null,
): number | null {
  let remaining = capacityMah;
  for (const segment of timeline) {
    const from = Math.max(0, segment.startDay);
    const to = Math.min(deploymentDays, segment.endDay);
    // Split where the beacon starts, since the draw changes there.
    const cuts = [from, ...(vhfStartDay !== null && vhfStartDay > from && vhfStartDay < to ? [vhfStartDay] : []), to];
    for (let i = 0; i < cuts.length - 1; i++) {
      const pieceFrom = cuts[i];
      const days = cuts[i + 1] - pieceFrom;
      if (days <= 0) continue;
      const vhf = vhfStartDay !== null && pieceFrom >= vhfStartDay ? VHF.activeCurrentMa.value : 0;
      const perDay = (segment.averageCurrentMa + vhf) * 24;
      if (perDay <= 0) continue;
      if (remaining <= days * perDay) return pieceFrom + remaining / perDay;
      remaining -= days * perDay;
    }
  }
  return null;
}

/** ACTIVITY-mode IMU storage assumption until field data says otherwise. */
const MOTION_DUTY_ASSUMPTION = 0.05;

/** Share of wall-clock time the IMU is streaming to the card. */
function imuDutyCycle(phase: PhaseConfig, audioDuty: number): number {
  switch (phase.imuRecordingMode) {
    case 'AUDIO':
      return audioDuty;
    case 'ACTIVITY':
      return MOTION_DUTY_ASSUMPTION;
    case 'NONE':
      return 0;
  }
}

function imuEffectiveSampleRate(phase: PhaseConfig): number {
  return phase.imuRecordingMode === 'NONE' ? 0 : phase.imuSampleRateHz;
}

/**
 * Average current while actively recording — the direct port of Calculations!L.
 *
 * Verbatim from the sheet:
 *   L = ((J*E28) + (K*E27) + (G*E23) + (H*E24) + (I*E25)) / 1000
 *       + MagPower!E6 + micPower(mic) + imuPower(imuRate)
 */
export function recordingCurrentMa(
  phase: PhaseConfig,
  options: { sdSpeedClass: string; microphone: string; imuSampleRateHz: number },
): number {
  const rate = effectiveSampleRateHz(phase);
  const imuRate = options.imuSampleRateHz;

  // Calculations!E22 — milliseconds to write one byte, capped at the SDIO ceiling.
  const cardMbPerS = SD_SPEED_CLASS_MB_PER_S[options.sdSpeedClass] ?? 10;
  const msPerByte = 1000 / (Math.min(SD_BUS_CEILING_MB_PER_S, cardMbPerS) * 1024 * 1024);

  // Planner!E — audio processing interval, matching audio_num_seconds_per_dma().
  const audioIntervalS = audioProcessingIntervalSeconds(rate, phase.audioClipLengthSeconds);

  // Planner!F — SD write interval. WAV flushes every DMA buffer; Opus flushes when
  // the 64 KiB cache fills, which at low bitrates is far less often.
  //
  // The sheet expresses bitrate in kbps (Planner!C12 = 16) and derives KB/s as
  // C/8, so F = E19 / (D * 1000). We carry bitrate in bits per second, which makes
  // the same quantity simply cacheBytes * 8 / bitrate.
  const sdIntervalS = phase.useOpusEncoding
    ? (BUFFERS.sdAudioCacheBytes.value * 8) / phase.opusBitrate
    : audioIntervalS;

  // Planner!H — IMU write interval.
  const imuIntervalS = imuRate > 0 ? Math.min(BUFFERS.sdImuCacheSamples.value / imuRate, sdIntervalS) : 0;

  // Planner!J / Planner!K — time spent writing each kind of data per SD interval.
  const audioWriteMs = phase.useOpusEncoding
    ? msPerByte * BUFFERS.sdAudioCacheBytes.value
    : msPerByte * BUFFERS.audioDmaSamples.value * AUDIO_BYTES_PER_SAMPLE;
  const imuWriteMs = msPerByte * sdIntervalS * imuRate * IMU_BYTES_PER_SAMPLE;

  // Planner!I — processing cost per audio interval.
  const processingMs = phase.useOpusEncoding
    ? opusEncodeMs(phase.opusBitrate)
    : WAV_PROCESSING_MS_PER_INTERVAL.value;

  // Calculations!E / !F
  const sdWriteMsPerActivation = audioWriteMs + imuWriteMs + SD_CARD.fatMaintenanceMs.value;
  // The spreadsheet's CEILING(F/H) divides by zero when the IMU is off; one
  // activation per write interval is the correct limit.
  const activationsPerWrite = imuIntervalS > 0 ? Math.ceil(sdIntervalS / imuIntervalS) : 1;
  const mcuActiveMsPerActivation =
    sdWriteMsPerActivation + activationsPerWrite * SD_CARD.activationDurationMs.value;

  // Calculations!G / !H / !I / !J / !K — milliseconds per second in each state.
  const sdWriteMsPerSecond = sdWriteMsPerActivation / sdIntervalS;
  const sdIdleMsPerSecond = (activationsPerWrite * SD_CARD.activationDurationMs.value) / sdIntervalS;
  const sdSleepMsPerSecond = Math.max(0, 1000 - (sdWriteMsPerSecond + sdIdleMsPerSecond));
  const mcuActiveMsPerSecond =
    mcuActiveMsPerActivation / sdIntervalS + processingMs / audioIntervalS;
  const mcuIdleMsPerSecond = Math.max(0, 1000 - mcuActiveMsPerSecond);

  const coreMa =
    (mcuActiveMsPerSecond * MCU.activeCurrentMa.value +
      mcuIdleMsPerSecond * MCU.idleCurrentMa.value +
      sdWriteMsPerSecond * SD_CARD.writeCurrentMa.value +
      sdIdleMsPerSecond * SD_CARD.activationCurrentMa.value +
      sdSleepMsPerSecond * SD_CARD.sleepCurrentMa.value) /
    1000;

  return coreMa + magnetAverageMa() + micCurrentMa(options.microphone) + imuCurrentMa(imuRate);
}

/** Current while armed but not recording. Wholly extrapolated. */
function idleCurrentMa(phase: PhaseConfig, microphone: string): number {
  let ma =
    IDLE_STATE.mcuCurrentMa.value +
    IDLE_STATE.sdCurrentMa.value +
    magnetAverageMa() +
    micCurrentMa(microphone);
  if (phase.audioRecordingMode === 'AMPLITUDE') {
    ma += IDLE_STATE.comparatorCurrentMa.value;
  }
  return ma;
}

/** MagPower!E6 — duty-cycled magnetometer polling. */
export function magnetAverageMa(): number {
  const {
    measurementDurationMs,
    measurementCurrentMa,
    idleCurrentMa: magIdle,
    sleepCurrentMa,
    activeWindowMs,
    sleepWindowMs,
  } = MAGNET;
  const perCycle =
    (measurementDurationMs.value * measurementCurrentMa.value) / 1000 +
    ((activeWindowMs.value - measurementDurationMs.value) * magIdle.value) / 1000 +
    ((sleepWindowMs.value - activeWindowMs.value) * sleepCurrentMa.value) / 1000;
  return perCycle * (1000 / sleepWindowMs.value);
}

/**
 * Planner!E — the largest whole number of seconds of audio the DMA buffer can hold
 * that also divides the clip length evenly.
 */
export function audioProcessingIntervalSeconds(sampleRateHz: number, clipLengthSeconds: number): number {
  const maxSeconds = Math.floor(BUFFERS.audioDmaSamples.value / sampleRateHz);
  if (maxSeconds <= 0) return 1;
  if (maxSeconds > clipLengthSeconds) return clipLengthSeconds;
  for (let candidate = maxSeconds; candidate >= 1; candidate--) {
    if (clipLengthSeconds % candidate === 0) return candidate;
  }
  return 1;
}

/** Linear interpolation across the measured Opus encode costs. */
export function opusEncodeMs(bitrate: number): number {
  const table = OPUS_ENCODE_MS_BY_BITRATE;
  if (bitrate <= table[0].bitrate) return table[0].encodeMs;
  const last = table.at(-1)!;
  if (bitrate >= last.bitrate) return last.encodeMs;
  for (let i = 1; i < table.length; i++) {
    const hi = table[i];
    const lo = table[i - 1];
    if (bitrate <= hi.bitrate) {
      const t = (bitrate - lo.bitrate) / (hi.bitrate - lo.bitrate);
      return lo.encodeMs + t * (hi.encodeMs - lo.encodeMs);
    }
  }
  return last.encodeMs;
}

function micCurrentMa(microphone: string): number {
  return (MICROPHONE_CURRENT_MA[microphone] ?? MICROPHONE_CURRENT_MA[DEFAULT_MICROPHONE]).value;
}

function imuCurrentMa(sampleRateHz: number): number {
  const exact = IMU_CURRENT_MA[sampleRateHz];
  if (exact) return exact.value;
  // LOOKUP() in the sheet falls back to the largest listed rate at or below.
  const rates = Object.keys(IMU_CURRENT_MA)
    .map(Number)
    .sort((a, b) => a - b);
  let value = 0;
  for (const rate of rates) {
    if (rate <= sampleRateHz) value = IMU_CURRENT_MA[rate].value;
  }
  return value;
}

/**
 * Where a phase sits on the deployment, in days from its start.
 *
 * An unphased deployment is one phase covering all of it. Phases need not tile: a gap
 * between two is legal and the device records nothing in it, which falls out of this
 * naturally because the gap belongs to no segment. Unparseable times fall back to an
 * even split so a half-edited configuration still forecasts something sensible.
 */
function phaseSegment(
  phase: PhaseConfig,
  config: DeploymentConfig,
  index: number,
  start: number,
  deploymentDays: number,
): { startDay: number; endDay: number } {
  if (!config.isPhased || config.phases.length <= 1) return { startDay: 0, endDay: deploymentDays };
  const even = deploymentDays / config.phases.length;
  const phaseStart = Date.parse(phase.startTime ?? config.startTime);
  const phaseEnd = Date.parse(phase.endTime ?? config.endTime);
  if (Number.isNaN(phaseStart) || Number.isNaN(phaseEnd)) {
    return { startDay: index * even, endDay: (index + 1) * even };
  }
  const toDays = (ms: number) => (ms - start) / 1000 / SECONDS_PER_DAY;
  return { startDay: toDays(phaseStart), endDay: toDays(phaseEnd) };
}

function isoAfterDays(startMs: number, days: number): string {
  return new Date(startMs + days * SECONDS_PER_DAY * 1000).toISOString();
}
