import type {
  AudioFilterType,
  AudioRecordingMode,
  AudioScheduleType,
  SolarAnchor,
  ImuRecordingMode,
  MicType,
  TimeScale,
  VhfMode,
} from './firmware-constants.js';

/**
 * The in-app representation of a deployment configuration.
 *
 * Deliberately NOT a 1:1 mirror of the .cfg file: times are ISO instants rather
 * than UTC epoch seconds, and phase names / timezone are first-class even though
 * the firmware ignores them. `serializeConfig()` is the only place the two
 * representations meet.
 */

export interface TriggerWindow {
  /** Seconds past local midnight, in [0, 86400). */
  startSecond: number;
  /**
   * Seconds past the SAME local midnight, so a period running past midnight ends beyond
   * 86 400 — 21:00 to 03:00 is 75 600 to 97 200. The serializer writes such a period as the
   * two entries either side of midnight, which is all the firmware can express, and the
   * parser joins them back up. See `schedule.ts`.
   */
  endSecond: number;
}

/**
 * A recording window expressed against the sun rather than the clock.
 *
 * Resolved ON THE DEVICE, once per local day, by `solar_compute()` in the firmware. That is
 * the point of it: a schedule resolved here would be correct only on the day it was written,
 * and dawn moves by more than two hours across a year at temperate latitudes.
 *
 * Offsets are seconds, and the firmware stores them as int16, so they are limited to roughly
 * nine hours either side of the anchor — far more than a dawn or dusk window needs.
 */
export interface SolarWindow {
  startAnchor: SolarAnchor;
  /** Seconds relative to the anchor; negative is before it. */
  startOffsetSeconds: number;
  endAnchor: SolarAnchor;
  endOffsetSeconds: number;
}

export interface PhaseConfig {
  /**
   * Written as PHASE_NAME. The firmware parser has no branch for this key, so it
   * is round-tripped for the dashboard's benefit only.
   */
  name: string;

  /** Absent on a single-phase deployment; the device inherits the deployment span. */
  startTime?: string; // ISO 8601
  endTime?: string; // ISO 8601

  // --- audio ---
  audioRecordingMode: AudioRecordingMode;
  audioSampleRateHz: number;
  audioClipLengthSeconds: number;
  extendClipIfContinuousAudio: boolean;

  /**
   * AMPLITUDE mode only. A FRACTION OF FULL SCALE in 0..1 — despite the desktop
   * dashboard labelling this field "dB". audio.c receives it as
   * `float trigger_threshold_percent`. See FIRMWARE-FINDINGS.md #4.
   */
  audioTriggerThreshold: number;

  /**
   * AMPLITUDE mode only. Zero is never a useful value: legacy firmware never armed
   * the trigger at all, and current firmware rewrites it to 1 and marks the
   * configuration as corrected. `validateConfig` rejects it.
   */
  maxAudioClips: number;
  maxClipsTimeScale: TimeScale;

  /** INTERVAL mode only. */
  audioTriggerInterval: number;
  audioTriggerIntervalTimeScale: TimeScale;

  /**
   * SCHEDULED mode only. Whether the windows below are clock times or anchored to the sun.
   *
   * These are genuinely different settings rather than two spellings of one: a CLOCK schedule
   * is fixed for the deployment, while a SOLAR schedule is recomputed by the device every day
   * and needs a position to be computed from.
   */
  audioScheduleType: AudioScheduleType;

  /**
   * SCHEDULED mode only. At most MAX_AUDIO_TRIGGER_TIMES entries.
   *
   * Under a SOLAR schedule these are still written, and still matter: they are the fallback
   * the device falls back on for any day the sun supplies no usable window, which above the
   * Arctic circle is most of the summer.
   */
  audioTriggerTimes: TriggerWindow[];

  /** SCHEDULED + SOLAR only. At most MAX_AUDIO_TRIGGER_TIMES entries. */
  audioSolarWindows: SolarWindow[];

  /**
   * Band-limits the recorded audio. Unlike the silence threshold below, this changes
   * what is stored rather than whether it is stored.
   */
  audioFilterType: AudioFilterType;
  /** High-pass corner, Hz. Used by BAND and HIGH. */
  audioFilterLowHz: number;
  /** Low-pass corner, Hz. Used by BAND and LOW. */
  audioFilterHighHz: number;

  /** Fraction of full scale, 0..1. Written as SILENCE_THRESHOLD. */
  silenceThreshold: number;
  minFrequencyHz: number;
  /** Clamped by firmware to (sampleRate / 2) - 200. */
  maxFrequencyHz: number;

  useOpusEncoding: boolean;
  opusBitrate: number;

  // --- IMU ---
  imuRecordingMode: ImuRecordingMode;
  imuSampleRateHz: number;
  imuDegreesOfFreedom: number;
  /**
   * Motion sensitivity in ABSOLUTE MILLI-G, written as IMU_TRIGGER_THRESHOLD.
   *
   * Firmware before 2026.08.1 parsed this and then ignored it, so no older card
   * carries a meaningful value under the previous fractional interpretation —
   * there is nothing to migrate. Hardware resolves about 7.8 mg.
   */
  imuTriggerThresholdMg: number;
}

export interface DeploymentConfig {
  schemaVersion: number;

  // --- identity ---
  deviceLabel: string;
  /** IANA zone. Written as DEVICE_TIMEZONE; firmware reads only the UTC offsets. */
  timezone: string;

  /**
   * Where the device will be, in signed degrees, or null when it has not been said.
   *
   * Only a solar schedule consults it, but it is deployment identity rather than a recording
   * setting: it describes the site, not how to record there, so a protocol never carries it.
   * Null rather than zero because (0, 0) is a real position in the Gulf of Guinea, and the
   * firmware makes the same distinction with its own `position_available` flag.
   */
  latitude: number | null;
  longitude: number | null;

  // --- schedule ---
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  setRtcAtMagnetDetect: boolean;

  // --- device behavior ---
  gpsAvailable: boolean;
  awakeOnMagnet: boolean;
  magnetValidationMs: number;
  forbidDeactivationSeconds: number;
  ledsEnabled: boolean;
  ledsActiveSeconds: number;
  batteryLowMv: number;
  micType: MicType;
  micAmplificationDb: number;

  // --- VHF retrieval beacon ---
  vhfMode: VhfMode;
  /** Ignored unless vhfMode === 'SCHEDULED'; derived for 'END'. */
  vhfStartTime: string; // ISO 8601

  /**
   * Keep clock-time recording periods on the local wall clock across daylight-saving changes.
   *
   * The device holds one UTC offset, so without this a 06:00 period runs at 05:00 or 07:00
   * local after a change. With it, the serializer splits each affected phase at the change
   * and shifts the later part's periods to compensate, and writes DST_ADJUSTED so the parser
   * can put them back. Absent means on.
   */
  adjustForDst?: boolean;

  /** True when phases carry their own start/end times. */
  isPhased: boolean;
  phases: PhaseConfig[];
}

export interface ValidationIssue {
  /** 'error' blocks writing to a card. 'warning' does not. */
  severity: 'error' | 'warning';
  /** Dot path into DeploymentConfig, e.g. `phases.0.maxAudioClips`. */
  path: string;
  message: string;
  /**
   * Items the message introduces, rendered as a list rather than run together.
   *
   * For findings that enumerate — one line per phase, say. Kept separate from `message`
   * so the UI decides how to lay them out instead of parsing punctuation back out of a
   * sentence.
   */
  details?: string[];
  /** Optional machine-readable remedy the UI can offer as a button. */
  fix?: { label: string; patch: Record<string, unknown> };
}
