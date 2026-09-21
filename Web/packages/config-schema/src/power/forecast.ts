import {
  AUDIO_BYTES_PER_SAMPLE,
  IMU_BYTES_PER_SAMPLE,
  TIME_SCALE_SECONDS,
} from '../firmware-constants.js';
import { effectiveSampleRateHz } from '../serialize.js';
import { DEFAULT_FIRMWARE_PROFILE, type FirmwareProfile } from '../firmware-profile.js';
import type { DeploymentConfig, PhaseConfig } from '../types.js';
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
 */

export interface ForecastInputs {
  config: DeploymentConfig;
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
}

export interface PhaseForecast {
  phaseName: string;
  dutyCycle: number;
  bytesPerDay: number;
  averageCurrentMa: number;
  clipsPerDay: number;
  audioSecondsPerDay: number;
}

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
  clipsPerDay: number;
  averageCurrentMa: number;

  deploymentDays: number;
  /** Days until the card is full at this rate. Infinity when it never fills. */
  storageDays: number;
  /** Days until the battery reaches its cutoff. */
  batteryDays: number;

  /** ISO instant the card fills, or null if it lasts the whole deployment. */
  cardFullAt: string | null;
  /** ISO instant the battery dies, or null if it lasts the whole deployment. */
  batteryDeadAt: string | null;

  totalClips: number;
  totalAudioHours: number;

  cardUsedFraction: number;
  confidence: Confidence;
  /** Human-readable notes on what limits the forecast's accuracy. */
  caveats: string[];
  perPhase: PhaseForecast[];
  measurementsRevision: string;
}

const SECONDS_PER_DAY = 86400;
const BYTES_PER_GB = 1024 ** 3;

export function forecast(inputs: ForecastInputs): Forecast {
  const {
    config,
    sdCardCapacityGb = DEFAULTS.sdCardCapacityGb,
    batteryCapacityMah = DEFAULTS.batteryCapacityMah,
    sdSpeedClass = DEFAULT_SD_SPEED_CLASS,
    microphone = DEFAULT_MICROPHONE,
    firmware = DEFAULT_FIRMWARE_PROFILE,
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

  const perPhase: PhaseForecast[] = [];
  /* Each phase placed on the deployment's own clock, so the card can be filled in the
     order the phases actually run rather than at their blended average rate. */
  const timeline: Array<PhaseForecast & { startDay: number; endDay: number }> = [];
  let weightedBytesPerDay = 0;
  let weightedClipsPerDay = 0;
  let weightedCurrentMa = 0;

  config.phases.forEach((phase, phaseIndex) => {
    const segment = phaseSegment(phase, config, phaseIndex, start, deploymentDays);
    const share =
      deploymentDays > 0
        ? Math.max(0, segment.endDay - segment.startDay) / deploymentDays
        : 1 / config.phases.length;
    const duty = dutyCycle(phase, caveats, firmware);
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

    const bytesPerDay =
      duty * audioBytesPerSecond * SECONDS_PER_DAY + imuDuty * imuBytesPerSecond * SECONDS_PER_DAY;

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

    const entry: PhaseForecast = {
      phaseName: phase.name,
      dutyCycle: duty,
      bytesPerDay,
      averageCurrentMa: averageMa,
      clipsPerDay,
      audioSecondsPerDay: duty * SECONDS_PER_DAY,
    };
    perPhase.push(entry);
    timeline.push({ ...entry, ...segment });

    weightedBytesPerDay += bytesPerDay * share;
    weightedClipsPerDay += clipsPerDay * share;
    weightedCurrentMa += averageMa * share;

    if (duty < 1) contributing.push(IDLE_STATE.mcuCurrentMa);
    if (phase.audioRecordingMode === 'AMPLITUDE') contributing.push(IDLE_STATE.comparatorCurrentMa);
  });

  // The VHF beacon runs continuously from activation to the end of the deployment.
  let averageCurrentMa = weightedCurrentMa;
  if (config.vhfMode !== 'NEVER') {
    const vhfStart = config.vhfMode === 'END' ? end : Date.parse(config.vhfStartTime);
    const vhfDays = Math.max(0, (end - vhfStart) / 1000 / SECONDS_PER_DAY);
    if (vhfDays > 0 && deploymentDays > 0) {
      averageCurrentMa += (vhfDays / deploymentDays) * VHF.activeCurrentMa.value;
      contributing.push(VHF.activeCurrentMa);
      caveats.push('VHF beacon current is a placeholder and has not been measured.');
    }
  }

  const cardBytes = sdCardCapacityGb * BYTES_PER_GB;
  const batteryDays = averageCurrentMa > 0 ? batteryCapacityMah / averageCurrentMa / 24 : Infinity;

  /*
    Run the phases in order and fill the card as they go.

    Doing this at the deployment's average rate instead gets two things wrong once
    phases differ. A heavy phase early fills the card sooner than the average predicts,
    so the fill date lands late; and the clip and audio-hour totals kept counting past
    the point where the card was full, which contradicted the card-usage meter sitting
    directly above them. Recording stops when the card fills, so the totals stop too.
  */
  let totalBytes = 0;
  let totalClips = 0;
  let totalAudioSeconds = 0;
  let cardFullDay: number | null = null;

  for (const segment of [...timeline].sort((a, b) => a.startDay - b.startDay)) {
    if (cardFullDay !== null) break;
    const from = Math.max(0, segment.startDay);
    const days = Math.min(deploymentDays, segment.endDay) - from;
    if (days <= 0) continue;

    let recorded = days;
    if (segment.bytesPerDay > 0) {
      const remaining = cardBytes - totalBytes;
      if (remaining <= days * segment.bytesPerDay) {
        recorded = Math.max(0, remaining / segment.bytesPerDay);
        cardFullDay = from + recorded;
      }
    }

    totalBytes += recorded * segment.bytesPerDay;
    totalClips += recorded * segment.clipsPerDay;
    totalAudioSeconds += recorded * segment.audioSecondsPerDay;
  }

  // Exact when the card fills; otherwise the average rate extrapolated past the end.
  const storageDays =
    cardFullDay ?? (weightedBytesPerDay > 0 ? cardBytes / weightedBytesPerDay : Infinity);

  return {
    totalBytes,
    bytesPerDay: weightedBytesPerDay,
    clipsPerDay: weightedClipsPerDay,
    averageCurrentMa,
    deploymentDays,
    storageDays,
    batteryDays,
    cardFullAt: cardFullDay !== null && cardFullDay < deploymentDays ? isoAfterDays(start, cardFullDay) : null,
    batteryDeadAt: batteryDays < deploymentDays ? isoAfterDays(start, batteryDays) : null,
    totalClips: Math.round(totalClips),
    totalAudioHours: totalAudioSeconds / 3600,
    cardUsedFraction: cardBytes > 0 ? Math.min(1, totalBytes / cardBytes) : 0,
    confidence: weakestConfidence(...contributing),
    caveats,
    perPhase,
    measurementsRevision: MEASUREMENTS_REVISION,
  };
}

/**
 * Fraction of wall-clock time the device is actively writing audio.
 *
 * CONTINUOUS is 1 by definition. SCHEDULED and INTERVAL are exact. AMPLITUDE is a
 * WORST CASE — it assumes every permitted clip is triggered, because the true rate
 * depends on how noisy the site is, which no model can know.
 */
export function dutyCycle(
  phase: PhaseConfig,
  caveats: string[] = [],
  firmware: FirmwareProfile = DEFAULT_FIRMWARE_PROFILE,
): number {
  switch (phase.audioRecordingMode) {
    case 'CONTINUOUS':
      return 1;

    case 'SCHEDULED': {
      const active = phase.audioTriggerTimes.reduce(
        (sum, window) => sum + Math.max(0, window.endSecond - window.startSecond),
        0,
      );
      return Math.min(1, active / SECONDS_PER_DAY);
    }

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
