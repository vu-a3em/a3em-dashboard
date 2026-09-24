import { maxFrequencyCeilingHz } from './firmware-constants.js';
import { defaultConfig, defaultPhase } from './defaults.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';

/**
 * Reusable recording configurations.
 *
 * A lab runs the same setup over and over — the same sample rate, the same schedule
 * shape, the same microphone — and today every one of those is retyped for every
 * deployment. A protocol fixes everything that stays the same so a new deployment is a
 * label, a date range, and a device.
 *
 * The split that defines this file: a protocol holds RECORDING settings, never
 * DEPLOYMENT identity. A label, a start and end date, a timezone, and the derived VHF
 * start belong to one deployment and must never be carried into the next — copying a
 * previous deployment's dates onto a new one is precisely the mistake this is meant to
 * eliminate.
 */

/** Keys that belong to a single deployment and are never stored in a protocol. */
export const DEPLOYMENT_SPECIFIC_KEYS = [
  'deviceLabel',
  'startTime',
  'endTime',
  'timezone',
  // The site, not how to record at it. A protocol carrying a position would drop the
  // previous study's coordinates onto a new deployment the moment it was applied, and a
  // solar schedule would then resolve against the wrong place without saying so.
  'latitude',
  'longitude',
  'vhfStartTime',
] as const;

export type DeploymentSpecificKey = (typeof DEPLOYMENT_SPECIFIC_KEYS)[number];
export type ProtocolSettings = Omit<DeploymentConfig, DeploymentSpecificKey>;

/**
 * Where each phase sits within the deployment, as a fraction of its total span.
 *
 * Phase boundaries are absolute instants in a config, which makes them meaningless in a
 * protocol — a schedule captured in April must not drag April's dates into a September
 * deployment. Storing proportions instead lets the same three-week/one-week split land
 * correctly on any window it is applied to.
 */
export interface PhaseSpan {
  startFraction: number;
  endFraction: number;
}

export interface Protocol {
  id: string;
  name: string;
  /** What this is for, in the terms someone choosing between protocols would use. */
  description: string;
  /**
   * Bumped on every save. Recorded against a deployment when applied, so a deployment
   * can later say which version of a protocol produced it even after the protocol moves on.
   */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** True for the shipped starter set, which cannot be edited or deleted in place. */
  builtIn: boolean;
  settings: ProtocolSettings;
  /** Present only when `settings.isPhased`. One entry per phase. */
  phaseSpans?: PhaseSpan[];
}

/** What a deployment records about the protocol it came from. */
export interface ProtocolProvenance {
  protocolId: string;
  name: string;
  version: number;
  appliedAt: string;
}

// ---------------------------------------------------------------------------
// Capturing and applying
// ---------------------------------------------------------------------------

export function protocolSettingsFrom(config: DeploymentConfig): ProtocolSettings {
  const settings = { ...config } as Partial<DeploymentConfig>;
  for (const key of DEPLOYMENT_SPECIFIC_KEYS) delete settings[key];
  // Phase boundaries live in phaseSpans as proportions; carrying the instants too would
  // leave two sources of truth that disagree the moment a protocol is reused.
  settings.phases = settings.phases!.map(stripPhaseTimes);
  // Absent means on, so a protocol saved before the setting existed compares as it runs.
  settings.adjustForDst = config.adjustForDst !== false;
  return settings as ProtocolSettings;
}

export function phaseSpansFrom(config: DeploymentConfig): PhaseSpan[] | undefined {
  if (!config.isPhased) return undefined;
  const start = Date.parse(config.startTime);
  const span = Date.parse(config.endTime) - start;
  if (!Number.isFinite(span) || span <= 0) return undefined;

  return config.phases.map((phase) => ({
    startFraction: clampFraction(phase.startTime ? (Date.parse(phase.startTime) - start) / span : 0),
    endFraction: clampFraction(phase.endTime ? (Date.parse(phase.endTime) - start) / span : 1),
  }));
}

export function createProtocol(
  config: DeploymentConfig,
  meta: { id: string; name: string; description: string; now: string },
): Protocol {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    version: 1,
    createdAt: meta.now,
    updatedAt: meta.now,
    builtIn: false,
    settings: protocolSettingsFrom(config),
    phaseSpans: phaseSpansFrom(config),
  };
}

/** Replaces a protocol's settings from a config, bumping its version. */
export function updateProtocol(
  protocol: Protocol,
  config: DeploymentConfig,
  now: string,
): Protocol {
  return {
    ...protocol,
    version: protocol.version + 1,
    updatedAt: now,
    builtIn: false,
    settings: protocolSettingsFrom(config),
    phaseSpans: phaseSpansFrom(config),
  };
}

/**
 * Lays a protocol over a deployment, keeping everything specific to that deployment.
 *
 * The label, dates, and timezone already entered survive untouched. Phase boundaries are
 * rebased onto the current window from the stored proportions, and the VHF start is
 * recomputed rather than carried, since it is derived from the end date.
 */
export function applyProtocol(config: DeploymentConfig, protocol: Protocol): DeploymentConfig {
  const applied: DeploymentConfig = {
    ...protocol.settings,
    deviceLabel: config.deviceLabel,
    startTime: config.startTime,
    endTime: config.endTime,
    timezone: config.timezone,
    latitude: config.latitude,
    longitude: config.longitude,
    vhfStartTime: config.vhfStartTime,
    phases: protocol.settings.phases.map((phase) => ({ ...phase })),
  };

  if (applied.isPhased && protocol.phaseSpans?.length === applied.phases.length) {
    applied.phases = rebasePhases(applied.phases, protocol.phaseSpans, config.startTime, config.endTime);
  }
  // Derived from the deployment end, so it must follow the new dates rather than the old.
  if (applied.vhfMode === 'END') applied.vhfStartTime = config.endTime;

  return applied;
}

function rebasePhases(
  phases: PhaseConfig[],
  spans: PhaseSpan[],
  startTime: string,
  endTime: string,
): PhaseConfig[] {
  const start = Date.parse(startTime);
  const total = Date.parse(endTime) - start;
  if (!Number.isFinite(total) || total <= 0) return phases;

  return phases.map((phase, index) => ({
    ...phase,
    startTime: new Date(start + spans[index].startFraction * total).toISOString(),
    endTime: new Date(start + spans[index].endFraction * total).toISOString(),
  }));
}

/**
 * Whether a config still matches the protocol it was built from.
 *
 * Answers "have I changed anything since?", which is what makes it safe to offer saving
 * the edits back. Compares only what a protocol stores, so entering a device label or
 * shifting the dates never counts as drift.
 */
export function matchesProtocol(config: DeploymentConfig, protocol: Protocol): boolean {
  const stored = { ...protocol.settings, adjustForDst: protocol.settings.adjustForDst !== false };
  return stableStringify(protocolSettingsFrom(config)) === stableStringify(stored);
}

/**
 * JSON with object keys in a fixed order.
 *
 * A plain `JSON.stringify` comparison depends on the order keys were inserted, which
 * differs between a config built by the editor and one read back off a card by
 * `parseConfig`. Two identical configurations would then be reported as drifted purely
 * because of the order their fields happened to be written in.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const clampFraction = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

function stripPhaseTimes(phase: PhaseConfig): PhaseConfig {
  const copy = { ...phase };
  delete copy.startTime;
  delete copy.endTime;
  return copy;
}

// ---------------------------------------------------------------------------
// The starter set
// ---------------------------------------------------------------------------

/**
 * Protocols shipped with the app, so a first-time user has a working configuration
 * before understanding a single field.
 *
 * NONE OF THESE IS A DEFAULT. A new deployment starts blank, and every one of these has
 * to be chosen deliberately. That is not timidity about the numbers — it is that the
 * literature will not support a default. The most-cited practitioner review of acoustic
 * monitoring design (Teixeira et al. 2024, Conserv Sci Pract 6:e13132) declines to give
 * general recording-schedule recommendations at all, and the AudioMoth configuration app
 * — the tool these users already know — ships no presets of its own. What is defensible
 * is a starting point chosen against a stated question, which is how each of these is
 * named and described.
 *
 * They are organized by what you are trying to MEASURE rather than by species. A protocol
 * called "African elephant" would promise a calibration nobody here has done; a protocol
 * called "low-frequency continuous" promises only what its settings actually deliver, and
 * leaves the ecologist to decide whether it suits their animal.
 *
 * Two hardware facts shape the whole set:
 *
 *  - There is deliberately no ultrasonic protocol. The maximum sample rate is 48 kHz, so
 *    nothing above 24 kHz can be recorded, and offering such a setting would promise
 *    something the device cannot deliver.
 *
 *  - Sample rate is not the lever for deployment length that it looks like. From the
 *    deployment planner (128 GB card, 7000 mAh pack, continuous recording), 8 kHz WAV
 *    runs out of CARD at 95 days while 48 kHz Opus at 32 kbps runs out of BATTERY at 116.
 *    Dropping the sample rate to stretch a deployment is therefore often the wrong move,
 *    and the descriptions below say which resource each protocol actually exhausts.
 */
function starter(
  id: string,
  name: string,
  description: string,
  shape: (config: DeploymentConfig) => DeploymentConfig,
): Protocol {
  const EPOCH = '2026-01-01T00:00:00.000Z';
  const config = shape(defaultConfig('UTC', new Date(EPOCH)));
  return {
    id,
    name,
    description,
    version: 1,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    builtIn: true,
    settings: protocolSettingsFrom(config),
    phaseSpans: phaseSpansFrom(config),
  };
}

const hours = (h: number, m = 0) => h * 3600 + m * 60;

/**
 * The silence-detection band every protocol below states explicitly.
 *
 * These are inert while `silenceThreshold` is zero, which is where all of these leave it.
 * They are set anyway because the two fields are independent: someone who later raises the
 * threshold to reclaim card space would otherwise inherit whatever the default happened to
 * be, and a buffer judged silent is dropped before a file exists rather than trimmed.
 * Naming the band here means that decision is already correct for the protocol's target
 * when it becomes live.
 */
const SILENCE_LOW_HZ = 100;
/** For the low-frequency protocol, whose target sits under everything the others care about. */
const SILENCE_RUMBLE_LOW_HZ = 20;

export const STARTER_PROTOCOLS: Protocol[] = [
  starter(
    'starter.low-frequency-continuous',
    'Low-frequency continuous',
    'Continuous 8 kHz, uncompressed, for the low-frequency calls of large mammals, such as elephant ' +
      'rumble harmonics and the vocalizations of bears and caribou. Nothing above 3.8 kHz is captured.',
    (config) => ({
      ...config,
      /*
        The digital microphone, for robustness rather than frequency response.

        It removes the analog path's DC-offset calibration, its temperature sensitivity, and
        the discrete microphone wiring that has caused at least one deployment loss in the
        field. The cost is honest and worth stating: the SPH18R1LM4H specifies a
        low-frequency rolloff of 30 Hz, and the PDM path additionally runs a high-pass that
        `audio.c` enables unconditionally (`bHighPassEnable = AM_HAL_PDM_HIGH_PASS_ENABLE`,
        HPGAIN 3), whose corner the Ambiq SDK does not document.

        So this protocol does NOT capture an elephant rumble's fundamental at 8-34 Hz. It
        captures the harmonic stack above it — the formants near 50 and 100 Hz and upward —
        which is what rumble detection generally works from in any case. The description
        says "harmonics" for that reason, and it should keep saying so unless someone
        measures that corner on a bench unit.
      */
      micType: 'DIGITAL',
      ledsActiveSeconds: 600,
      phases: [
        {
          ...defaultPhase('Continuous'),
          audioRecordingMode: 'CONTINUOUS',
          audioSampleRateHz: 8000,
          audioClipLengthSeconds: 300,
          maxFrequencyHz: maxFrequencyCeilingHz(8000),
          // Rumbles sit near the noise floor, so wind is the main competitor. A gentle
          // high-pass would remove the signal itself, hence none by default.
          audioFilterType: 'NONE',
          minFrequencyHz: SILENCE_RUMBLE_LOW_HZ,
          imuRecordingMode: 'NONE',
        },
      ],
    }),
  ),

  starter(
    'starter.continuous-full',
    'Continuous, full bandwidth',
    'Everything the hardware can capture at 48 kHz continuous, Opus compressed. Lossy, so weak ' +
      'signals near the noise floor are the first thing the encoder discards.',
    (config) => ({
      ...config,
      phases: [
        {
          ...defaultPhase('Continuous'),
          audioRecordingMode: 'CONTINUOUS',
          audioSampleRateHz: 48000,
          audioClipLengthSeconds: 300,
          useOpusEncoding: true,
          opusBitrate: 32000,
          maxFrequencyHz: maxFrequencyCeilingHz(48000),
          minFrequencyHz: SILENCE_LOW_HZ,
          imuRecordingMode: 'NONE',
        },
      ],
    }),
  ),

  starter(
    'starter.duty-cycled',
    'Duty-cycled sampling',
    'One minute in every ten at 48 kHz, uncompressed — a 10% duty cycle that trades continuous ' +
      'coverage for roughly ten times the calendar span. Useful when the question is "what is out ' +
      'there" rather than "what happened at this moment".',
    (config) => ({
      ...config,
      phases: [
        {
          ...defaultPhase('Duty cycle'),
          audioRecordingMode: 'INTERVAL',
          audioSampleRateHz: 48000,
          audioClipLengthSeconds: 60,
          /*
            The interval is the PERIOD, start to start, not the gap between clips —
            `process_audio_scheduled()` arms a free-running timer at this value. So 60 s in
            600 s is a 10% duty cycle, not 1/11th.

            Ten minutes rather than something longer because of the one duty-cycle finding
            that transfers across taxa: a cycle period much longer than a typical event
            misses events wholesale, and frequent short listens beat rare long ones at equal
            total effort (Stanistreet et al. 2016, JASA 140:EL31). Lengthen this only after
            deciding how long the target sound actually lasts.
          */
          audioTriggerInterval: 10,
          audioTriggerIntervalTimeScale: 'MINUTES',
          maxFrequencyHz: maxFrequencyCeilingHz(48000),
          minFrequencyHz: SILENCE_LOW_HZ,
          imuRecordingMode: 'NONE',
        },
      ],
    }),
  ),

  starter(
    'starter.dawn-dusk',
    'Dawn and dusk periods',
    'Roughly two hours around first light and two around dusk, at 48 kHz, high-pass filtered at ' +
      '200 Hz to cut wind and collar noise without touching bird song. Anchored to civil twilight ' +
      'and sunrise at the deployment position, so the periods follow the sun rather than the clock.',
    (config) => ({
      ...config,
      phases: [
        {
          ...defaultPhase('Dawn and dusk'),
          audioRecordingMode: 'SCHEDULED',
          audioSampleRateHz: 48000,
          audioClipLengthSeconds: 60,
          audioScheduleType: 'SOLAR',
          /*
            Civil dawn to ninety minutes past sunrise, and an hour before sunset to civil dusk.

            Civil twilight rather than sunrise as the opening anchor because the chorus is
            already under way before the sun clears the horizon — opening at sunrise misses its
            beginning, which is the part most worth having. The evening window hangs off sunset
            instead, because dusk singing builds before the sun goes down rather than after it.

            The DEVICE resolves these, once per local day, so a three-month deployment tracks
            the season rather than drifting away from the dawn it was configured for.

            Worth saying plainly for an on-animal deployment: dawn-chorus sampling is a
            STATIONARY survey convention, where the recorder's fixed site is the sampling
            unit. On a collar the recorder travels with one individual, so this is a
            reasonable way to sample that animal's dawn and dusk soundscape, not a site survey.
          */
          audioSolarWindows: [
            { startAnchor: 'DAWN', startOffsetSeconds: 0, endAnchor: 'SUNRISE', endOffsetSeconds: 5400 },
            { startAnchor: 'SUNSET', startOffsetSeconds: -3600, endAnchor: 'DUSK', endOffsetSeconds: 1800 },
          ],
          /*
            The fallback, for any day the sun supplies no usable window.

            Not decoration: above the Arctic circle there is no sunrise for most of the summer,
            and a caribou deployment whose only schedule was solar would simply stop recording.
            These are deliberately plain clock times — honestly arbitrary rather than falsely
            precise — and the device logs SOLAR_SCHEDULE with windows=0 on any day it uses them.
          */
          audioTriggerTimes: [
            { startSecond: hours(5), endSecond: hours(7) },
            { startSecond: hours(18), endSecond: hours(20) },
          ],
          audioFilterType: 'HIGH',
          audioFilterLowHz: 200,
          audioFilterHighHz: maxFrequencyCeilingHz(48000),
          minFrequencyHz: SILENCE_LOW_HZ,
          maxFrequencyHz: maxFrequencyCeilingHz(48000),
          imuRecordingMode: 'NONE',
        },
      ],
    }),
  ),

  starter(
    'starter.activity-budget',
    'Activity budget (audio and motion)',
    'Continuous 16 kHz audio with motion recorded alongside it, for classifying what the animal is ' +
      'doing, such as feeding, ruminating, or moving.',
    (config) => ({
      ...config,
      phases: [
        {
          ...defaultPhase('Activity'),
          audioRecordingMode: 'CONTINUOUS',
          /*
            16 kHz because the sounds this targets are the carrier's own: chewing, footfalls,
            rumination. The on-animal literature is consistent that this is what a collar
            microphone is uniquely good for — Lynch et al. (2013) classified 3300 h of deer
            collar audio as 38% rumination, 34% browsing and 21% mastication, some 92% of the
            classifiable signal — and none of it needs the top octave.
          */
          audioSampleRateHz: 16000,
          // 60 s so one IMU buffer spans a whole clip at 50 Hz (IMU_BUFFER_MAX_SAMPLES is
          // 3000), letting the IMU flush ride along with an audio flush instead of waking
          // the card on its own.
          audioClipLengthSeconds: 60,
          maxFrequencyHz: maxFrequencyCeilingHz(16000),
          minFrequencyHz: SILENCE_LOW_HZ,
          // Synchronized rather than motion-triggered: an activity budget needs the quiet
          // intervals too, and a gap means "not moving" only if it was recorded as one.
          imuRecordingMode: 'AUDIO',
          imuSampleRateHz: 200,
        },
      ],
    }),
  ),

  starter(
    'starter.amplitude-detection',
    'Amplitude detection',
    'Records only when sound crosses a loudness threshold, for sparse loud events against a quiet ' +
      'background, such as gunshots, vehicles, and alarm calls. Capped at 30 clips an hour so a windy ' +
      'or busy site cannot fill the card early. Triggers on loudness alone and cannot tell what made ' +
      'the sound.',
    (config) => ({
      ...config,
      /*
        Analog, because it has to be: the trigger is an analog comparator fed by a digipot
        reference, not a digital comparison, so `validateConfig` rejects AMPLITUDE mode on a
        digital microphone. This protocol therefore names the microphone rather than
        inheriting whatever a new deployment starts with.
      */
      micType: 'ANALOG',
      phases: [
        {
          ...defaultPhase('Triggered'),
          audioRecordingMode: 'AMPLITUDE',
          audioSampleRateHz: 16000,
          audioClipLengthSeconds: 30,
          audioTriggerThreshold: 0.2,
          // Bounded rather than unlimited. Left uncapped, a device in a windy or busy place
          // triggers almost continuously and fills a 128 GB card halfway through a
          // three-month deployment — a starter should not do that to someone.
          maxAudioClips: 30,
          maxClipsTimeScale: 'HOURS',
          maxFrequencyHz: maxFrequencyCeilingHz(16000),
          minFrequencyHz: SILENCE_LOW_HZ,
          imuRecordingMode: 'ACTIVITY',
          imuSampleRateHz: 50,
          imuTriggerThresholdMg: 100,
        },
      ],
    }),
  ),
];
