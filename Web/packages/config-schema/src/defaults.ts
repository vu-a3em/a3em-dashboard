import {
  AUDIO_DEFAULT_CLIP_LENGTH_SECONDS,
  AUDIO_DEFAULT_SAMPLE_RATE_HZ,
  CONFIG_SCHEMA_VERSION,
  OPUS_DEFAULT_BITRATE,
  maxFrequencyCeilingHz,
  LEDS_DEFAULT_ACTIVE_SECONDS,
} from './firmware-constants.js';
import { fromZonedInput, localMidnight, toZonedInput } from './timezone.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';

/**
 * Defaults matching `fetch_runtime_configuration()` in runtime_config.c, with two
 * deliberate departures where the firmware default is a trap:
 *
 *  - `maxAudioClips` is 60/hour rather than the firmware's 0. Zero disarms the
 *    amplitude trigger entirely (`num_clips_stored < max_clips` is never true),
 *    so a device configured with the firmware default in threshold mode records
 *    nothing at all.
 *
 *  - `maxFrequencyHz` is the clamped ceiling rather than rate/2, so the value
 *    shown in the app is the value the device runs.
 */
/*
  What a NEW deployment starts at.

  Deliberately separate from the firmware's own MIC, MAGNET, and IMU default constants,
  which record what the DEVICE falls back to when a setting is absent and are checked
  against the firmware snapshot. These are a product choice about where to put someone who
  has not decided yet, and the two are free to differ.
*/
// 1.5 rather than 1 because the default microphone is digital, and the PDM gain ladder has
// no 1 dB rung - asking for 1 simply runs at 1.5. Naming the achievable value keeps a fresh
// deployment free of a correction it cannot avoid.
const START_MIC_AMPLIFICATION_DB = 1.5;
const START_MAGNET_VALIDATION_MS = 3000;
const START_IMU_SAMPLE_RATE_HZ = 50;

/**
 * How many years after its start a new deployment ends, and how far past the start the end
 * is put when the start is moved to or beyond it.
 */
export const DEFAULT_DEPLOYMENT_YEARS = 5;

export function defaultPhase(name = 'Phase 1'): PhaseConfig {
  return {
    name,
    audioRecordingMode: 'CONTINUOUS',
    audioSampleRateHz: AUDIO_DEFAULT_SAMPLE_RATE_HZ,
    audioClipLengthSeconds: AUDIO_DEFAULT_CLIP_LENGTH_SECONDS,
    extendClipIfContinuousAudio: false,
    audioTriggerThreshold: 0.25,
    maxAudioClips: 60,
    maxClipsTimeScale: 'HOURS',
    audioTriggerInterval: 10,
    audioTriggerIntervalTimeScale: 'MINUTES',
    audioScheduleType: 'CLOCK',
    audioTriggerTimes: [],
    audioSolarWindows: [],
    audioFilterType: 'NONE',
    // 1, not 0: the moment a high-pass is selected the corner is in use, and zero is not
    // a corner the firmware can design a filter around. Starting at zero meant choosing
    // High-pass immediately painted the field red before the user had touched it.
    audioFilterLowHz: 1,
    audioFilterHighHz: maxFrequencyCeilingHz(AUDIO_DEFAULT_SAMPLE_RATE_HZ),
    silenceThreshold: 0,
    /*
      100, not 250. This band is inert while `silenceThreshold` is zero, but the two fields
      are independent — the moment someone raises the threshold to save card space, this
      value silently becomes a high-pass on the KEEP/DISCARD decision, and a buffer judged
      silent is never written at all. 250 Hz sat above every large-mammal call this device
      is pointed at, so the old default turned a storage tweak into signal loss with no log
      line to show for it. 100 Hz clears wind and handling rumble while leaving the
      harmonics of the low-frequency callers inside the band.
    */
    minFrequencyHz: 100,
    maxFrequencyHz: maxFrequencyCeilingHz(AUDIO_DEFAULT_SAMPLE_RATE_HZ),
    useOpusEncoding: false,
    opusBitrate: OPUS_DEFAULT_BITRATE,
    imuRecordingMode: 'AUDIO',
    imuSampleRateHz: START_IMU_SAMPLE_RATE_HZ,
    imuDegreesOfFreedom: 3,
    imuTriggerThresholdMg: 100,
  };
}

export function defaultConfig(timezone = 'UTC', now = new Date()): DeploymentConfig {
  /*
    The coming local midnight in the DEPLOYMENT's zone, and the same local date and time
    DEFAULT_DEPLOYMENT_YEARS later.

    It used to be today's UTC midnight, which read as 7 PM yesterday to anyone in Chicago —
    a start already in the past before a single field had been touched, and at an hour
    nobody would choose.
  */
  let startIso: string;
  let endIso: string;
  try {
    startIso = localMidnight(timezone, now, 1);
    endIso = withLocalYear(startIso, timezone, localYear(startIso, timezone) + DEFAULT_DEPLOYMENT_YEARS);
  } catch {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() + 1);
    startIso = start.toISOString();
    endIso = withLocalYear(startIso, 'UTC', start.getUTCFullYear() + DEFAULT_DEPLOYMENT_YEARS);
  }

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    deviceLabel: '',
    timezone,
    latitude: null,
    longitude: null,
    startTime: startIso,
    endTime: endIso,
    setRtcAtMagnetDetect: true,
    gpsAvailable: false,
    awakeOnMagnet: true,
    magnetValidationMs: START_MAGNET_VALIDATION_MS,
    forbidDeactivationSeconds: 0,
    ledsEnabled: true,
    ledsActiveSeconds: LEDS_DEFAULT_ACTIVE_SECONDS,
    // Off unless asked for: recording until the battery gives out, rather than stopping at a
    // voltage chosen for someone else's cells. Not the firmware's own default, which is what a
    // card that leaves BATTERY_LOW_MV out gets (parse.ts).
    batteryLowMv: 0,
    micType: 'DIGITAL',
    micAmplificationDb: START_MIC_AMPLIFICATION_DB,
    vhfMode: 'NEVER',
    vhfStartTime: endIso,
    adjustForDst: true,
    isPhased: false,
    phases: [defaultPhase()],
  };
}

/**
 * The schedule once the start has been moved to `startTime`.
 *
 * A start moved to or past the end would leave a deployment that ends before it begins, so
 * the end moves with it: the same local date and time, in the year DEFAULT_DEPLOYMENT_YEARS
 * after the new start's. An end still after the new start is left exactly as it was.
 */
export function moveDeploymentStart(
  config: Pick<DeploymentConfig, 'endTime' | 'timezone'>,
  startTime: string,
): Pick<DeploymentConfig, 'startTime' | 'endTime'> {
  if (Date.parse(startTime) < Date.parse(config.endTime)) return { startTime, endTime: config.endTime };
  try {
    const year = localYear(startTime, config.timezone) + DEFAULT_DEPLOYMENT_YEARS;
    return { startTime, endTime: withLocalYear(config.endTime, config.timezone, year) };
  } catch {
    // An unreadable time or zone has nothing to carry the end along by.
    return { startTime, endTime: config.endTime };
  }
}

/** The year on the wall clock in `timezone` at an instant. */
function localYear(isoInstant: string, timezone: string): number {
  return Number(toZonedInput(isoInstant, timezone).split('-')[0]);
}

/**
 * The same local date and time in `timezone`, in another year.
 *
 * Done on the wall clock rather than by adding seconds, so the time of day survives a
 * daylight-saving difference between the two dates. 29 February becomes the 28th in a year
 * without one.
 */
function withLocalYear(isoInstant: string, timezone: string, year: number): string {
  const [, month, day, time] = /^\d+-(\d{2})-(\d{2})T(.+)$/.exec(toZonedInput(isoInstant, timezone)) ?? [];
  if (!month || !day || !time) throw new Error(`Invalid ISO 8601 timestamp: ${isoInstant}`);
  // Day 0 of the following month is the last day of this one.
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(year, Number(month), 0);
  const clampedDay = Math.min(Number(day), monthEnd.getUTCDate());
  return fromZonedInput(`${String(year).padStart(4, '0')}-${month}-${String(clampedDay).padStart(2, '0')}T${time}`, timezone);
}
