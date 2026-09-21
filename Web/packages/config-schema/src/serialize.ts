import {
  CONFIG_SCHEMA_VERSION,
  MAX_CFG_LINE_CONTENT_LENGTH,
  OPUS_REQUIRED_SAMPLE_RATE_HZ,
  maxFrequencyCeilingHz,
} from './firmware-constants.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';
import { utcOffsetSecondsAt } from './timezone.js';

/**
 * Renders a DeploymentConfig to the exact `_a3em.cfg` text the firmware parses.
 *
 * Three properties of runtime_config.c constrain this function, and breaking any
 * of them corrupts a deployment silently rather than loudly:
 *
 *  1. KEY ORDER. `parse_line()` seeds each new phase's start/end from the
 *     already-parsed deployment span, so DEPLOYMENT_START_TIME and
 *     DEPLOYMENT_END_TIME must appear before the first `[PHASE]`.
 *
 *  2. PHASE ORDER. `config_get_active_deployment_phase_index()` returns the FIRST
 *     phase whose window contains the current time, so phases must be emitted in
 *     ascending start-time order.
 *
 *  3. LINE LENGTH. `storage_read_line()` reads 80 bytes and then looks for the newline
 *     inside those same 80, so 79 characters is the true ceiling. Past it the caller's
 *     loop stops and the rest of the file is discarded. Every emitted line is checked.
 *
 * Trailing newline is mandatory: a final line without one is dropped.
 */
export function serializeConfig(config: DeploymentConfig): string {
  const lines: string[] = [];
  const kv = (key: string, value: string | number | boolean) => {
    const rendered = typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value);
    const line = `${key} = "${rendered}"`;
    if (line.length > MAX_CFG_LINE_CONTENT_LENGTH) {
      throw new ConfigLineTooLongError(key, line.length);
    }
    lines.push(line);
  };

  const startEpoch = toEpochSeconds(config.startTime);
  const endEpoch = toEpochSeconds(config.endTime);

  // The desktop tool used the UTC offset *at the moment of writing*. That is wrong
  // across a DST boundary — a config authored in March for a July deployment shifts
  // every scheduled recording window by an hour. Resolve the offset at the
  // deployment's own start instant instead.
  const utcOffset = utcOffsetSecondsAt(config.timezone, config.startTime);

  kv('DEVICE_LABEL', config.deviceLabel);
  kv('DEVICE_TIMEZONE', config.timezone); // firmware ignores; kept for round-tripping
  kv('DEVICE_UTC_OFFSET', utcOffset);
  // DEVICE_UTC_OFFSET_HOUR is deliberately NOT written. It existed so recording filenames
  // could carry a "_+10" suffix; epoch naming dropped the suffix and the firmware has read
  // nothing from it since. No whole number of hours is correct for a half-hour zone anyway,
  // and DEVICE_UTC_OFFSET carries the exact value the device actually uses.
  kv('SET_RTC_AT_MAGNET_DETECT', config.setRtcAtMagnetDetect);
  kv('DEPLOYMENT_START_TIME', startEpoch); // must precede any [PHASE]
  kv('DEPLOYMENT_END_TIME', endEpoch); // must precede any [PHASE]
  // FIRMWARE: runtime_config.c only arms `position_available` when BOTH are present and in
  // range, and only a solar schedule reads them. Writing them unconditionally would put two
  // lines claiming a position on every card from a lab that never uses one.
  if (hasPosition(config)) {
    kv('DEPLOYMENT_LATITUDE', config.latitude!.toFixed(5));
    kv('DEPLOYMENT_LONGITUDE', config.longitude!.toFixed(5));
  }
  kv('GPS_AVAILABLE', config.gpsAvailable);
  kv('AWAKE_ON_MAGNET', config.awakeOnMagnet);
  kv('LEDS_ENABLED', config.ledsEnabled);
  // FIRMWARE: active_main.c only ever lights an LED when they are enabled, and runtime_config.c
  // defaults the duration to zero, so writing it for a device with the LEDs off says nothing.
  if (config.ledsEnabled) kv('LEDS_ACTIVE_SECONDS', config.ledsActiveSeconds);
  kv('MIC_TYPE', config.micType);
  kv('MIC_AMPLIFICATION', config.micAmplificationDb.toFixed(1));
  kv('BATTERY_LOW_MV', config.batteryLowMv);
  kv('MAGNET_FIELD_VALIDATION_MS', config.magnetValidationMs);
  kv('FORBID_DEACTIVATION_SECONDS', config.forbidDeactivationSeconds);
  kv('VHF_MODE', config.vhfMode);
  // FIRMWARE: main.c gates the beacon on `vhf_enable_timestamp && now >= vhf_enable_timestamp`,
  // and the default is zero, so an omitted start time is exactly a disabled beacon.
  if (config.vhfMode !== 'NEVER') kv('VHF_RADIO_START_TIME', resolveVhfEpoch(config, endEpoch));
  kv('PHASED_DEPLOYMENT', config.isPhased);

  for (const phase of orderPhases(config)) {
    lines.push('');
    lines.push('[PHASE]'); // must contain no quote character to be recognized
    kv('PHASE_NAME', phase.name); // firmware ignores; dashboard metadata
    if (config.isPhased) {
      kv('PHASE_START_TIME', toEpochSeconds(requirePhaseTime(phase, 'startTime')));
      kv('PHASE_END_TIME', toEpochSeconds(requirePhaseTime(phase, 'endTime')));
    }
    kv('AUDIO_RECORDING_MODE', phase.audioRecordingMode);
    // FIRMWARE: active_main.c switches on the recording mode and reads only that arm's settings.
    // AMPLITUDE takes the clip cap, the extend flag and the trigger threshold; SCHEDULED takes
    // the windows and passes a threshold of 0.0 itself; INTERVAL takes the interval. CONTINUOUS
    // reads none of them. Writing the other arms' values records intent the device never
    // consults.
    if (phase.audioRecordingMode === 'AMPLITUDE') {
      kv('AUDIO_EXTEND_CLIP', phase.extendClipIfContinuousAudio);
      kv('AUDIO_MAX_CLIPS_NUMBER', phase.maxAudioClips);
      kv('AUDIO_MAX_CLIPS_TIME_SCALE', phase.maxClipsTimeScale);
      kv('AUDIO_TRIGGER_THRESHOLD', phase.audioTriggerThreshold);
    }
    if (phase.audioRecordingMode === 'INTERVAL') {
      kv('AUDIO_TRIGGER_INTERVAL', phase.audioTriggerInterval);
      kv('AUDIO_TRIGGER_INTERVAL_TIME_SCALE', phase.audioTriggerIntervalTimeScale);
    }
    if (phase.audioRecordingMode === 'SCHEDULED') {
      kv('AUDIO_TRIGGER_SCHEDULE_TYPE', phase.audioScheduleType);
      /*
        The fixed windows are written under BOTH schedule types.

        Under a solar schedule they are not the schedule — the device recomputes that daily —
        but they are what it falls back on for any day the sun supplies no usable window. That
        is not a rare corner: above the Arctic circle it is most of the summer, and a caribou
        deployment with no fallback would simply stop recording.
      */
      for (const window of phase.audioTriggerTimes) {
        kv('AUDIO_TRIGGER_SCHEDULE', `${window.startSecond}-${window.endSecond}`);
      }
      if (phase.audioScheduleType === 'SOLAR') {
        for (const window of phase.audioSolarWindows) {
          // Commas, not the clock schedule's '-', because an offset may be negative and a
          // leading minus cannot be told apart from a separator.
          kv(
            'AUDIO_SOLAR_SCHEDULE',
            `${window.startAnchor},${window.startOffsetSeconds},${window.endAnchor},${window.endOffsetSeconds}`,
          );
        }
      }
    }
    kv('AUDIO_SAMPLING_RATE_HZ', effectiveSampleRateHz(phase));
    kv('AUDIO_CLIP_LENGTH_SECONDS', phase.audioClipLengthSeconds);
    kv('IMU_RECORDING_MODE', phase.imuRecordingMode);
    if (phase.imuRecordingMode !== 'NONE') {
      kv('IMU_DEGREES_OF_FREEDOM', phase.imuDegreesOfFreedom);
      // Only the motion-triggered mode consults a threshold. (Milli-g; ignored before 2026.08.1.)
      if (phase.imuRecordingMode === 'ACTIVITY') kv('IMU_TRIGGER_THRESHOLD', phase.imuTriggerThresholdMg);
      kv('IMU_SAMPLING_RATE_HZ', phase.imuSampleRateHz);
    }
    kv('FILTER_TYPE', phase.audioFilterType);
    // FIRMWARE: audio_filter.c returns immediately on FILTER_NONE, and otherwise designs a
    // high-pass from the low corner and a low-pass from the high corner — so each corner only
    // matters to the filters that use it.
    if (phase.audioFilterType === 'HIGH' || phase.audioFilterType === 'BAND') {
      kv('FILTER_LOW_FREQUENCY', phase.audioFilterLowHz);
    }
    if (phase.audioFilterType === 'LOW' || phase.audioFilterType === 'BAND') {
      kv('FILTER_HIGH_FREQUENCY', phase.audioFilterHighHz);
    }
    kv('SILENCE_THRESHOLD', phase.silenceThreshold);
    // FIRMWARE: the band of interest is read only inside `if (use_silence_filter)`, which is
    // itself `silence_threshold > 0`.
    if (phase.silenceThreshold > 0) {
      kv('MIN_FREQUENCY', phase.minFrequencyHz);
      kv('MAX_FREQUENCY', effectiveMaxFrequencyHz(phase));
    }
    kv('USE_OPUS', phase.useOpusEncoding);
    if (phase.useOpusEncoding) kv('OPUS_BITRATE', phase.opusBitrate);
  }

  return lines.join('\n') + '\n'; // trailing newline is required
}

export class ConfigLineTooLongError extends Error {
  constructor(
    readonly key: string,
    readonly length: number,
  ) {
    super(
      `Config line for "${key}" is ${length} bytes; the firmware reads at most ` +
        `${MAX_CFG_LINE_CONTENT_LENGTH} and silently discards the remainder of the file beyond it.`,
    );
    this.name = 'ConfigLineTooLongError';
  }
}

/**
 * Whether AUDIO_EXTEND_CLIP means anything for this phase.
 *
 * Only amplitude triggering, which is the one mode where a SOUND started the recording — so
 * "keep going while that sound lasts" is a question that can be asked at all. A clock started
 * the clip in every other mode: continuous recording never stops between clips, a scheduled
 * window already records back to back, and an interval is a deliberate subsample whose whole
 * point is an even spacing that extension would make ragged.
 */
export function extendClipApplies(phase: PhaseConfig): boolean {
  return phase.audioRecordingMode === 'AMPLITUDE';
}

/**
 * Firmware clamps the sample rate to 48 kHz whenever Opus is on. Emit the value
 * the device will actually use so the file and the forecast agree.
 */
export function effectiveSampleRateHz(phase: PhaseConfig): number {
  return phase.useOpusEncoding ? OPUS_REQUIRED_SAMPLE_RATE_HZ : phase.audioSampleRateHz;
}

/**
 * The highest low-pass corner the filter will honour, which is NOT the frequencies-of-interest
 * ceiling. The 200 Hz headroom in `maxFrequencyCeilingHz` exists for the silence filter's FFT
 * bins; `audio_filter.c` clamps its own corners to `nyquist - 1` and nothing else. Applying the
 * stricter number here used to lower a perfectly valid corner behind the user's back.
 */
export function filterCornerCeilingHz(phase: PhaseConfig): number {
  return Math.floor(effectiveSampleRateHz(phase) / 2) - 1;
}

/** Firmware clamps to (rate / 2) - 200; apply it here so the file matches the device. */
export function effectiveMaxFrequencyHz(phase: PhaseConfig): number {
  const ceiling = maxFrequencyCeilingHz(effectiveSampleRateHz(phase));
  return phase.maxFrequencyHz > 0 ? Math.min(phase.maxFrequencyHz, ceiling) : ceiling;
}

function orderPhases(config: DeploymentConfig): PhaseConfig[] {
  if (!config.isPhased) return config.phases.slice(0, 1);
  return [...config.phases].sort(
    (a, b) =>
      toEpochSeconds(requirePhaseTime(a, 'startTime')) -
      toEpochSeconds(requirePhaseTime(b, 'startTime')),
  );
}

function resolveVhfEpoch(config: DeploymentConfig, endEpoch: number): number {
  switch (config.vhfMode) {
    case 'NEVER':
      return 0; // firmware gates on VHF_MODE != NEVER, so the value is inert
    case 'END':
      return endEpoch;
    case 'SCHEDULED':
      return toEpochSeconds(config.vhfStartTime);
  }
}

function requirePhaseTime(phase: PhaseConfig, field: 'startTime' | 'endTime'): string {
  const value = phase[field];
  if (!value) {
    throw new Error(`Phase "${phase.name}" is missing ${field} on a phased deployment.`);
  }
  return value;
}

function toEpochSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid ISO 8601 timestamp: ${iso}`);
  return Math.floor(ms / 1000);
}

export { CONFIG_SCHEMA_VERSION };

/** Both coordinates present and in range, which is what the firmware requires before it uses either. */
function hasPosition(config: DeploymentConfig): boolean {
  return (
    config.latitude !== null &&
    config.longitude !== null &&
    Number.isFinite(config.latitude) &&
    Number.isFinite(config.longitude) &&
    Math.abs(config.latitude) <= 90 &&
    Math.abs(config.longitude) <= 180
  );
}
