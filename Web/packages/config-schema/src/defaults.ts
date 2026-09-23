import {
  AUDIO_DEFAULT_CLIP_LENGTH_SECONDS,
  AUDIO_DEFAULT_SAMPLE_RATE_HZ,
  BATTERY_DEFAULT_LOW_MV,
  CONFIG_SCHEMA_VERSION,
  OPUS_DEFAULT_BITRATE,
  maxFrequencyCeilingHz,
  LEDS_DEFAULT_ACTIVE_SECONDS,
} from './firmware-constants.js';
import { localMidnight } from './timezone.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';

/**
 * Defaults matching `fetch_runtime_configuration()` in runtime_config.c, with two
 * deliberate departures where the firmware default is a trap:
 *
 *  - `maxAudioClips` is 60/hour rather than the firmware's 0. Zero disarms the
 *    amplitude trigger entirely (`num_clips_stored < max_clips` is never true),
 *    so a device configured with the firmware default in threshold mode records
 *    nothing at all. See FIRMWARE-FINDINGS.md #3.
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
    The coming local midnight, and two weeks after it, in the DEPLOYMENT's zone.

    It used to be today's UTC midnight, which read as 7 PM yesterday to anyone in Chicago —
    a start already in the past before a single field had been touched, and at an hour
    nobody would choose.
  */
  let startIso: string;
  let endIso: string;
  try {
    startIso = localMidnight(timezone, now, 1);
    endIso = localMidnight(timezone, now, 15);
  } catch {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() + 1);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 14);
    startIso = start.toISOString();
    endIso = end.toISOString();
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
    batteryLowMv: BATTERY_DEFAULT_LOW_MV,
    micType: 'DIGITAL',
    micAmplificationDb: START_MIC_AMPLIFICATION_DB,
    vhfMode: 'NEVER',
    vhfStartTime: endIso,
    adjustForDst: true,
    isPhased: false,
    phases: [defaultPhase()],
  };
}
