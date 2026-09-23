import {
  CONFIG_SCHEMA_VERSION,
  MAX_AUDIO_TRIGGER_TIMES,
  MAX_CFG_LINE_CONTENT_LENGTH,
  MAX_DEPLOYMENT_PHASES,
  SOLAR_ANCHORS,
} from './firmware-constants.js';
import { defaultPhase, defaultConfig } from './defaults.js';
import type { SolarAnchor, TimeScale } from './firmware-constants.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';
import { dstChangesAffectingSchedule, joinDstSegments, mergeMidnightPeriods } from './schedule.js';

export interface ParseResult {
  config: DeploymentConfig;
  /** Conditions under which the DEVICE would read this file differently than we did. */
  warnings: string[];
}

/**
 * Parses `_a3em.cfg` using the same matching rules as runtime_config.c, so the
 * app's reading of a card agrees with the device's.
 *
 * The firmware matches keys by PREFIX (`memcmp(key, "KEY", sizeof("KEY")-1)`) in a
 * fixed if/else-if order, which makes order significant wherever one key is a
 * prefix of another — DEVICE_UTC_OFFSET_HOUR must be tested before
 * DEVICE_UTC_OFFSET, and AUDIO_TRIGGER_INTERVAL_TIME_SCALE before
 * AUDIO_TRIGGER_INTERVAL. KEY_ORDER below preserves that order exactly; the test
 * suite asserts no key is shadowed by an earlier prefix.
 */
export const KEY_ORDER = [
  'DEVICE_LABEL',
  'DEVICE_TIMEZONE',
  // Still RECOGNISED, never written. It has to stay ahead of DEVICE_UTC_OFFSET: matching is
  // by prefix, so an older file's DEVICE_UTC_OFFSET_HOUR would otherwise be read as the
  // seconds offset. Retired from output — see serialize.ts.
  'DEVICE_UTC_OFFSET_HOUR',
  'DEVICE_UTC_OFFSET',
  // The dashboard's own; the firmware ignores it. See serialize.ts.
  'DST_ADJUSTED',
  'SET_RTC_AT_MAGNET_DETECT',
  'DEPLOYMENT_START_TIME',
  'DEPLOYMENT_END_TIME',
  'DEPLOYMENT_LATITUDE',
  'DEPLOYMENT_LONGITUDE',
  'GPS_AVAILABLE',
  'AWAKE_ON_MAGNET',
  'LEDS_ENABLED',
  'LEDS_ACTIVE_SECONDS',
  'MIC_TYPE',
  'MIC_AMPLIFICATION',
  'BATTERY_LOW_MV',
  'MAGNET_FIELD_VALIDATION_MS',
  'FORBID_DEACTIVATION_SECONDS',
  'VHF_MODE',
  'VHF_RADIO_START_TIME',
  'PHASED_DEPLOYMENT',
  'PHASE_NAME',
  'PHASE_START_TIME',
  'PHASE_END_TIME',
  'AUDIO_RECORDING_MODE',
  'AUDIO_EXTEND_CLIP',
  'AUDIO_MAX_CLIPS_NUMBER',
  'AUDIO_MAX_CLIPS_TIME_SCALE',
  'AUDIO_TRIGGER_THRESHOLD',
  'AUDIO_TRIGGER_INTERVAL_TIME_SCALE', // before AUDIO_TRIGGER_INTERVAL
  'AUDIO_TRIGGER_INTERVAL',
  // Before AUDIO_TRIGGER_SCHEDULE, which is a prefix of it — the firmware matches on a
  // prefix too, and runtime_config.c orders these the same way for the same reason.
  'AUDIO_TRIGGER_SCHEDULE_TYPE',
  'AUDIO_SOLAR_SCHEDULE',
  'AUDIO_TRIGGER_SCHEDULE',
  'AUDIO_SAMPLING_RATE_HZ',
  'AUDIO_CLIP_LENGTH_SECONDS',
  'FILTER_TYPE',
  'FILTER_LOW_FREQUENCY',
  'FILTER_HIGH_FREQUENCY',
  'IMU_RECORDING_MODE',
  'IMU_DEGREES_OF_FREEDOM',
  'IMU_TRIGGER_THRESHOLD',
  'IMU_SAMPLING_RATE_HZ',
  'SILENCE_THRESHOLD',
  'MIN_FREQUENCY',
  'MAX_FREQUENCY',
  'USE_OPUS',
  'OPUS_BITRATE',
] as const;

export function parseConfig(text: string, timezoneHint = 'UTC'): ParseResult {
  const warnings: string[] = [];
  const config = defaultConfig(timezoneHint);
  config.phases = [];

  let timezone = timezoneHint;
  let deploymentStart = 0;
  let deploymentEnd = 0;
  let vhfEpoch = 0;
  let sawPhaseMarker = false;
  let dstAdjusted = false;

  const rawLines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');

  for (let index = 0; index < rawLines.length; index++) {
    const isLast = index === rawLines.length - 1;
    if (isLast && rawLines[index] === '') continue;

    const line = rawLines[index].replace(/\r$/, '');

    // storage_read_line() returns -1 for a line it cannot terminate, and the
    // caller's `while (... >= 0)` loop stops. Everything after is invisible to
    // the device even though it is plainly readable here.
    // The firmware reads into char[MAX_CFG_FILE_LINE_LENGTH] and searches that buffer for a
    // newline; a line that fills it exactly leaves no room for the terminator, the search
    // fails, and parsing STOPS there — silently truncating the deployment. So the limit on
    // content is one less than the buffer.
    if (line.length > MAX_CFG_LINE_CONTENT_LENGTH) {
      warnings.push(
        `Line ${index + 1} is ${line.length} bytes (limit ${MAX_CFG_LINE_CONTENT_LENGTH}). ` +
          `The device stops reading here and ignores everything below it.`,
      );
      break;
    }
    if (isLast && !endsWithNewline && line.length > 0) {
      warnings.push(
        `The file does not end with a newline, so the device discards its last line ("${line.trim()}").`,
      );
      break;
    }
    if (line.length < 4) continue; // firmware: line_length < 4 -> ignored

    const trimmed = line.replace(/^[ \t]+/, '');

    if (!trimmed.includes('"')) {
      if (trimmed.startsWith('[PHASE]')) {
        if (config.phases.length >= MAX_DEPLOYMENT_PHASES) {
          warnings.push(
            `More than ${MAX_DEPLOYMENT_PHASES} phases present. The device writes past the end ` +
              `of its phase array — this card's configuration is unsafe.`,
          );
        }
        config.phases.push(defaultPhase(`Phase ${config.phases.length + 1}`));
        sawPhaseMarker = true;
      }
      continue;
    }

    const value = trimmed.slice(trimmed.indexOf('"') + 1, trimmed.lastIndexOf('"'));
    const key = KEY_ORDER.find((candidate) => trimmed.startsWith(candidate));
    if (!key) continue;

    const phase = config.phases[config.phases.length - 1];
    if (!phase && isPhaseKey(key)) {
      warnings.push(`"${key}" appears before any [PHASE] marker and is ignored.`);
      continue;
    }

    switch (key) {
      case 'DEVICE_LABEL':
        config.deviceLabel = value;
        break;
      case 'DEVICE_TIMEZONE':
        timezone = value || timezoneHint;
        config.timezone = timezone;
        break;
      case 'DEVICE_UTC_OFFSET_HOUR':
      case 'DEVICE_UTC_OFFSET':
        break; // derived from timezone on write; nothing to restore
      case 'SET_RTC_AT_MAGNET_DETECT':
        config.setRtcAtMagnetDetect = value === 'True';
        break;
      case 'DST_ADJUSTED':
        dstAdjusted = value === 'True';
        break;
      case 'DEPLOYMENT_LATITUDE':
        config.latitude = Number(value);
        break;
      case 'DEPLOYMENT_LONGITUDE':
        config.longitude = Number(value);
        break;
      case 'DEPLOYMENT_START_TIME':
        deploymentStart = Number(value);
        config.startTime = epochToIso(deploymentStart);
        break;
      case 'DEPLOYMENT_END_TIME':
        deploymentEnd = Number(value);
        config.endTime = epochToIso(deploymentEnd);
        break;
      case 'GPS_AVAILABLE':
        config.gpsAvailable = value === 'True';
        break;
      case 'AWAKE_ON_MAGNET':
        config.awakeOnMagnet = value === 'True';
        break;
      case 'LEDS_ENABLED':
        config.ledsEnabled = value === 'True';
        break;
      case 'LEDS_ACTIVE_SECONDS':
        config.ledsActiveSeconds = Number(value);
        break;
      case 'MIC_TYPE':
        config.micType = value === 'DIGITAL' ? 'DIGITAL' : 'ANALOG';
        break;
      case 'MIC_AMPLIFICATION':
        config.micAmplificationDb = Number(value);
        break;
      case 'BATTERY_LOW_MV':
        config.batteryLowMv = Number(value);
        break;
      case 'MAGNET_FIELD_VALIDATION_MS':
        config.magnetValidationMs = Number(value);
        break;
      case 'FORBID_DEACTIVATION_SECONDS':
        config.forbidDeactivationSeconds = Number(value);
        break;
      case 'VHF_MODE':
        config.vhfMode = value === 'NEVER' || value === 'END' ? value : 'SCHEDULED';
        break;
      case 'VHF_RADIO_START_TIME':
        vhfEpoch = Number(value);
        break;
      case 'PHASED_DEPLOYMENT':
        config.isPhased = value === 'True';
        break;
      case 'PHASE_NAME':
        phase!.name = value;
        break;
      case 'PHASE_START_TIME':
        phase!.startTime = epochToIso(Number(value));
        break;
      case 'PHASE_END_TIME':
        phase!.endTime = epochToIso(Number(value));
        break;
      case 'AUDIO_RECORDING_MODE':
        phase!.audioRecordingMode = coerceAudioMode(value);
        break;
      case 'AUDIO_EXTEND_CLIP':
        phase!.extendClipIfContinuousAudio = value === 'True';
        break;
      case 'AUDIO_MAX_CLIPS_NUMBER':
        phase!.maxAudioClips = Number(value);
        break;
      case 'AUDIO_MAX_CLIPS_TIME_SCALE':
        phase!.maxClipsTimeScale = coerceTimeScale(value);
        break;
      case 'AUDIO_TRIGGER_THRESHOLD':
        phase!.audioTriggerThreshold = Number(value);
        break;
      case 'AUDIO_TRIGGER_INTERVAL_TIME_SCALE':
        phase!.audioTriggerIntervalTimeScale = coerceTimeScale(value);
        break;
      case 'AUDIO_TRIGGER_INTERVAL':
        phase!.audioTriggerInterval = Number(value);
        break;
      case 'AUDIO_TRIGGER_SCHEDULE_TYPE':
        phase!.audioScheduleType = value === 'SOLAR' ? 'SOLAR' : 'CLOCK';
        break;
      case 'AUDIO_SOLAR_SCHEDULE': {
        const [startAnchor, startOffset, endAnchor, endOffset] = value.split(',');
        if (phase!.audioSolarWindows.length >= MAX_AUDIO_TRIGGER_TIMES) {
          warnings.push(
            `Phase "${phase!.name}" has more than ${MAX_AUDIO_TRIGGER_TIMES} solar recording periods. ` +
              `The device ignores the extras.`,
          );
        }
        // A malformed entry is dropped rather than half-read. runtime_config.c does the same
        // and marks the file corrected, so reading one back as a window with NaN edges would
        // disagree with the device about what it is actually running.
        if (!isSolarAnchor(startAnchor) || !isSolarAnchor(endAnchor)) {
          warnings.push(`Phase "${phase!.name}" has a solar recording period naming an unknown anchor. The device ignores it.`);
          break;
        }
        phase!.audioSolarWindows.push({
          startAnchor,
          startOffsetSeconds: Number(startOffset),
          endAnchor,
          endOffsetSeconds: Number(endOffset),
        });
        break;
      }
      case 'AUDIO_TRIGGER_SCHEDULE': {
        const [start, end] = value.split('-');
        if (phase!.audioTriggerTimes.length >= MAX_AUDIO_TRIGGER_TIMES) {
          warnings.push(
            `Phase "${phase!.name}" has more than ${MAX_AUDIO_TRIGGER_TIMES} recording period entries. ` +
              `The device overruns its schedule array — this card's configuration is unsafe.`,
          );
        }
        phase!.audioTriggerTimes.push({ startSecond: Number(start), endSecond: Number(end) });
        break;
      }
      case 'AUDIO_SAMPLING_RATE_HZ':
        phase!.audioSampleRateHz = Number(value);
        break;
      case 'AUDIO_CLIP_LENGTH_SECONDS':
        phase!.audioClipLengthSeconds = Number(value);
        break;
      case 'IMU_RECORDING_MODE':
        phase!.imuRecordingMode = coerceImuMode(value);
        break;
      case 'IMU_DEGREES_OF_FREEDOM':
        phase!.imuDegreesOfFreedom = Number(value);
        break;
      case 'IMU_TRIGGER_THRESHOLD':
        phase!.imuTriggerThresholdMg = Number(value);
        break;
      case 'IMU_SAMPLING_RATE_HZ':
        phase!.imuSampleRateHz = Number(value);
        break;
      case 'FILTER_TYPE':
        phase!.audioFilterType = coerceFilterType(value);
        break;
      case 'FILTER_LOW_FREQUENCY':
        phase!.audioFilterLowHz = Number(value);
        break;
      case 'FILTER_HIGH_FREQUENCY':
        phase!.audioFilterHighHz = Number(value);
        break;
      case 'SILENCE_THRESHOLD':
        phase!.silenceThreshold = Number(value);
        break;
      case 'MIN_FREQUENCY':
        phase!.minFrequencyHz = Number(value);
        break;
      case 'MAX_FREQUENCY':
        phase!.maxFrequencyHz = Number(value);
        break;
      case 'USE_OPUS':
        phase!.useOpusEncoding = value === 'True';
        break;
      case 'OPUS_BITRATE':
        phase!.opusBitrate = Number(value);
        break;
    }
  }

  // An overnight period is written as the two entries either side of midnight; read it back
  // as the one period it was entered as.
  for (const phase of config.phases) {
    phase.audioTriggerTimes = mergeMidnightPeriods(phase.audioTriggerTimes);
  }

  if (!sawPhaseMarker) {
    warnings.push('No [PHASE] section found; the device would run with built-in defaults.');
    config.phases = [defaultPhase()];
  }

  // Put back what the serializer split for daylight saving, so the editor shows the phases
  // and local times that were entered rather than the pieces the device was given.
  if (dstAdjusted && config.isPhased) {
    const joined = joinDstSegments(config);
    config.phases = joined.phases;
    config.isPhased = joined.isPhased;
  }

  // A non-phased deployment inherits the deployment span, matching the firmware's
  // pre-seeding of phase_time in parse_line().
  if (!config.isPhased) {
    for (const phase of config.phases) {
      phase.startTime = undefined;
      phase.endTime = undefined;
    }
  }

  // A card written without the adjustment, across a change that would have moved its
  // periods, ran unadjusted — which is what reviewing it must assume.
  config.adjustForDst = dstAdjusted || dstChangesAffectingSchedule(config).length === 0;

  config.vhfStartTime = epochToIso(vhfEpoch || deploymentEnd || deploymentStart);
  config.schemaVersion = CONFIG_SCHEMA_VERSION;
  return { config, warnings };
}

function isPhaseKey(key: string): boolean {
  return (
    key.startsWith('PHASE_') ||
    key.startsWith('AUDIO_') ||
    key.startsWith('IMU_') ||
    key.startsWith('FILTER_') ||
    key === 'SILENCE_THRESHOLD' ||
    key === 'MIN_FREQUENCY' ||
    key === 'MAX_FREQUENCY' ||
    key === 'USE_OPUS' ||
    key === 'OPUS_BITRATE'
  );
}

function epochToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function coerceAudioMode(value: string): PhaseConfig['audioRecordingMode'] {
  // Mirrors parse_audio_recording_mode(): anything unrecognized becomes CONTINUOUS.
  return value === 'AMPLITUDE' || value === 'SCHEDULED' || value === 'INTERVAL'
    ? value
    : 'CONTINUOUS';
}

function coerceImuMode(value: string): PhaseConfig['imuRecordingMode'] {
  // Mirrors parse_imu_recording_mode(): anything unrecognized becomes NONE.
  return value === 'ACTIVITY' || value === 'AUDIO' ? value : 'NONE';
}

function coerceFilterType(value: string): PhaseConfig['audioFilterType'] {
  // Mirrors parse_audio_filter_type(): anything unrecognized disables filtering.
  return value === 'LOW' || value === 'BAND' || value === 'HIGH' ? value : 'NONE';
}

function coerceTimeScale(value: string): TimeScale {
  // Mirrors parse_time_scale(): anything unrecognized becomes MINUTES.
  return value === 'SECONDS' || value === 'HOURS' || value === 'DAYS' ? value : 'MINUTES';
}

/** Whether a config file's anchor name is one `solar.c` will actually parse. */
function isSolarAnchor(value: string | undefined): value is SolarAnchor {
  return value !== undefined && Object.prototype.hasOwnProperty.call(SOLAR_ANCHORS, value);
}
