import { achievableSampleRate } from './audio-clock.js';
import {
  AUDIO_RECORDING_MODES,
  IMU_RECORDING_MODES,
  BATTERY_CUTOFF_ADVISED_MIN_MV,
  BATTERY_DEFAULT_LOW_MV,
  BATTERY_CUTOFF_MAX_MV,
  BATTERY_CUTOFF_MIN_MV,
  DEVICE_LABEL_MAX_LEN,
  MIC_AMPLIFICATION_DIGITAL_STEP_DB,
  MIC_AMPLIFICATION_MIN_DB,
  micAmplificationMaxDb,
  snapDigitalGainDb,
  MIC_DEFAULT_AMPLIFICATION_DB,
  LEDS_MAX_ACTIVE_SECONDS,
  MAGNET_VALIDATION_MAX_MS,
  MAGNET_VALIDATION_MIN_MS,
  MAX_AUDIO_TRIGGER_TIMES,
  SOLAR_OFFSET_MIN_SECONDS,
  SOLAR_OFFSET_MAX_SECONDS,
  LATITUDE_MAX_DEG,
  LONGITUDE_MAX_DEG,
  AUDIO_DEFAULT_CLIP_LENGTH_SECONDS,
  AUDIO_MAX_CLIP_LENGTH_SECONDS,
  AUDIO_MIN_CLIP_LENGTH_SECONDS,
  MAX_DEPLOYMENT_PHASES,
  IMU_MOTION_THRESHOLD_MAX_MG,
  IMU_MOTION_THRESHOLD_MIN_MG,
  MAX_REPRESENTABLE_EPOCH_SECONDS,
  OPUS_MAX_BITRATE,
  OPUS_MIN_BITRATE,
  TIME_SCALE_SECONDS,
  maxFrequencyCeilingHz,
  PHASE_NAME_MAX_LEN,
} from './firmware-constants.js';
import { effectiveSampleRateHz, filterCornerCeilingHz } from './serialize.js';
import { DEFAULT_FIRMWARE_PROFILE, type FirmwareProfile } from './firmware-profile.js';
import { MIN_THRESHOLD_DBFS, MIN_WIPER, fractionToWiper, wiperToStoredFraction } from './audio-threshold.js';
import type { DeploymentConfig, PhaseConfig, ValidationIssue } from './types.js';
import {
  approximateSolarNoonMinutes,
  deviceUtcOffsetSeconds,
  dstAdjustmentApplies,
  dstSegments,
  firmwareEntryCount,
  periodDuration,
  periodSegments,
  SECONDS_PER_DAY,
  solarPeriodReports,
} from './schedule.js';
import { formatZonedDate } from './timezone.js';

/**
 * Every rule the desktop `validate_details()` enforced, plus the ones the
 * firmware needs but nothing checked. Rules marked FIRMWARE are new here and each
 * one corresponds to a way a config could previously reach a device and misbehave.
 *
 * `firmware` selects which firmware the card is destined for. It defaults to the
 * legacy profile, because assuming a device lacks the recent fixes is the safe
 * direction to be wrong in.
 *
 * Returns errors before warnings, each group in the order the editor presents its panes.
 *
 * `options.now` switches on the checks that only make sense for a card about to be written —
 * that the deployment is not already over, say. Without it nothing is judged against the
 * clock, which is right for a configuration read off a card to be reviewed.
 */
export interface ValidateOptions {
  /** Epoch milliseconds to judge the deployment dates against. */
  now?: number;
}

export function validateConfig(
  config: DeploymentConfig,
  firmware: FirmwareProfile = DEFAULT_FIRMWARE_PROFILE,
  options: ValidateOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const start = Date.parse(config.startTime);
  const end = Date.parse(config.endTime);

  const error = (path: string, message: string, fix?: ValidationIssue['fix']) =>
    issues.push({ severity: 'error', path, message, fix });
  const warn = (path: string, message: string, fix?: ValidationIssue['fix']) =>
    issues.push({ severity: 'warning', path, message, fix });

  // --- identity -----------------------------------------------------------
  for (const problem of deviceLabelProblems(config.deviceLabel)) error('deviceLabel', problem);

  // --- deployment window --------------------------------------------------
  if (start >= end) {
    error('endTime', 'The deployment must end after it starts.');
  }
  /*
    Dates already behind us, for a card about to be written.

    An end in the past is always a mistake — it is usually the previous deployment's dates,
    kept by the saved draft and by every protocol applied since. A start in the past is
    only a warning, because configuring at the site minutes before activating is ordinary,
    but it is never harmless: with the clock set at activation, every recording is stamped
    at least that far in the past.
  */
  if (options.now !== undefined && Number.isFinite(end) && Number.isFinite(start)) {
    if (end <= options.now) {
      error('endTime', 'The deployment ends in the past. Set the dates for this deployment.');
    } else if (start < options.now - 60_000) {
      warn(
        'startTime',
        config.setRtcAtMagnetDetect
          ? 'The deployment starts in the past. The device sets its clock to this start time when ' +
              'it is activated, so every recording would be stamped that much earlier than it was made.'
          : 'The deployment starts in the past, so the device will begin recording as soon as it is activated.',
      );
    }
  }
  // FIRMWARE: main.c seeds the RTC only when SET_RTC_AT_MAGNET_DETECT is on. Without it, and
  // without a GPS fix to set it, the clock is whatever the device last knew — the newest file
  // on the card, or the time in MRAM from its previous deployment.
  if (!config.setRtcAtMagnetDetect && !config.gpsAvailable) {
    warn(
      'setRtcAtMagnetDetect',
      'The device will not set its clock when activated and has no GPS to set it, so it runs on ' +
        'whatever time it last knew. Unless its clock is already correct, recording starts at the ' +
        'wrong moment and every time on the card is wrong by the same amount.',
    );
  }
  // FIRMWARE: every timestamp on device is a 32-bit time_t.
  if (end / 1000 > MAX_REPRESENTABLE_EPOCH_SECONDS) {
    error(
      'endTime',
      'The device cannot represent a date past 19 January 2038. Shorten the deployment.',
    );
  }
  /*
    The position, checked whether or not anything uses it yet.

    Out-of-range coordinates fail `solar_position_valid()` on the device, which silently
    disarms the position entirely — so a typo here would not break a solar schedule loudly,
    it would make it quietly run the fallback for the whole deployment.
  */
  for (const [path, value, limit] of [
    ['latitude', config.latitude, LATITUDE_MAX_DEG],
    ['longitude', config.longitude, LONGITUDE_MAX_DEG],
  ] as const) {
    if (value === null) continue;
    if (!Number.isFinite(value) || Math.abs(value) > limit) {
      error(path, `The ${path} must be a number between -${limit} and ${limit} degrees.`);
    }
  }
  // Half a position is no position: the firmware arms `position_available` only when both
  // are present, so one on its own reads exactly as none at all.
  if ((config.latitude === null) !== (config.longitude === null)) {
    error(
      config.latitude === null ? 'latitude' : 'longitude',
      'A position needs both a latitude and a longitude. The device ignores one without the other.',
    );
  }

  if (config.vhfMode === 'SCHEDULED') {
    const vhf = Date.parse(config.vhfStartTime);
    if (vhf < start) {
      error('vhfStartTime', 'The VHF beacon cannot be scheduled before the deployment starts.');
    }
    if (vhf > end) {
      warn(
        'vhfStartTime',
        'The VHF beacon is scheduled after the deployment ends, so it will never activate ' +
          'while the device is recording.',
      );
    }
  }

  // --- indicators and magnet ----------------------------------------------
  if (config.ledsEnabled && config.ledsActiveSeconds <= 0) {
    warn(
      'ledsActiveSeconds',
      'The LEDs are enabled but set to stay active for no time at all, so nothing will ever light. ' +
        'Disable them outright if that is what you mean.',
    );
  }
  if (config.ledsActiveSeconds < 0 || config.ledsActiveSeconds > LEDS_MAX_ACTIVE_SECONDS) {
    error(
      'ledsActiveSeconds',
      `Keep the LED active time between 0 and ${LEDS_MAX_ACTIVE_SECONDS} seconds.`,
    );
  }
  // FIRMWARE: magnet.c validates a held field for this long before acting on it. Too short and
  // handling the device in transit can trip it; too long and the field must be held awkwardly.
  if (config.awakeOnMagnet) {
    if (config.magnetValidationMs < MAGNET_VALIDATION_MIN_MS) {
      error(
        'magnetValidationMs',
        `A hold time under ${MAGNET_VALIDATION_MIN_MS} ms risks the device activating or shutting ` +
          'down from a stray magnetic field while it is being carried.',
        { label: `Use ${MAGNET_VALIDATION_MIN_MS} ms`, patch: { magnetValidationMs: MAGNET_VALIDATION_MIN_MS } },
      );
    } else if (config.magnetValidationMs > MAGNET_VALIDATION_MAX_MS) {
      error(
        'magnetValidationMs',
        `A hold time over ${MAGNET_VALIDATION_MAX_MS} ms is longer than anyone will hold a magnet ` +
          'against the case, so the device would appear not to respond.',
        { label: `Use ${MAGNET_VALIDATION_MAX_MS} ms`, patch: { magnetValidationMs: MAGNET_VALIDATION_MAX_MS } },
      );
    }
  }

  // --- battery cutoff -----------------------------------------------------
  const gainCeiling = micAmplificationMaxDb(config.micType);
  if (
    !Number.isFinite(config.micAmplificationDb) ||
    config.micAmplificationDb < MIC_AMPLIFICATION_MIN_DB ||
    config.micAmplificationDb > gainCeiling
  ) {
    error(
      'micAmplificationDb',
      `${micPhrase(config.micType, true)} takes a gain between ${MIC_AMPLIFICATION_MIN_DB} ` +
        `and ${gainCeiling} dB. The device clamps silently to that range rather than reporting it, ` +
        'so a higher number here would simply not be the gain it runs at.',
      {
        label: `Use ${Math.min(MIC_DEFAULT_AMPLIFICATION_DB, gainCeiling)} dB`,
        patch: { micAmplificationDb: Math.min(MIC_DEFAULT_AMPLIFICATION_DB, gainCeiling) },
      },
    );
  } else if (config.micType === 'DIGITAL') {
    // The PDM path has no continuous gain control, only a ladder of 1.5 dB steps.
    const actual = snapDigitalGainDb(config.micAmplificationDb);
    if (Math.abs(actual - config.micAmplificationDb) > 0.001) {
      warn(
        'micAmplificationDb',
        `A digital microphone sets gain in ${MIC_AMPLIFICATION_DIGITAL_STEP_DB} dB steps, so ` +
          `${config.micAmplificationDb} dB will run at ${actual} dB.`,
        { label: `Use ${actual} dB`, patch: { micAmplificationDb: actual } },
      );
    }
  }

  // Digital is what A3EM units are built with. An analog setting on a digital unit records
  // nothing usable, and the device has no way to notice, so this is worth a second look.
  if (config.micType === 'ANALOG') {
    warn(
      'micType',
      'This deployment is set for an analog microphone; however, most A3EM units use a digital one. ' +
        'Check your hardware before writing the card.',
    );
  }

  // FIRMWARE: battery.c `battery_monitor_is_critically_low()` returns false outright on a
  // zero threshold, so zero disables the cutoff rather than ending the deployment instantly.
  if (config.batteryLowMv < 0 || !Number.isFinite(config.batteryLowMv)) {
    error('batteryLowMv', 'The low-battery cutoff must be a voltage in millivolts, or 0 to disable it.');
  } else if (config.batteryLowMv === 0) {
    warn(
      'batteryLowMv',
      'The low-battery cutoff is disabled, so the device will record until the battery cannot ' +
        'power it. Expect the final clip to be truncated wherever the power fails.',
    );
  } else if (config.batteryLowMv < BATTERY_CUTOFF_MIN_MV) {
    error(
      'batteryLowMv',
      `A cutoff below ${BATTERY_CUTOFF_MIN_MV} mV will never fire — the card stops accepting ` +
        'writes before the battery falls that far. Use 0 if you mean to disable it.',
      { label: `Use ${BATTERY_CUTOFF_MIN_MV} mV`, patch: { batteryLowMv: BATTERY_CUTOFF_MIN_MV } },
    );
  } else if (config.batteryLowMv > BATTERY_CUTOFF_MAX_MV) {
    error(
      'batteryLowMv',
      `A cutoff above ${BATTERY_CUTOFF_MAX_MV} mV is higher than a fully charged cell, so the ` +
        'deployment would stop as soon as it starts.',
      { label: `Use ${BATTERY_DEFAULT_LOW_MV} mV`, patch: { batteryLowMv: BATTERY_DEFAULT_LOW_MV } },
    );
  } else if (config.batteryLowMv < BATTERY_CUTOFF_ADVISED_MIN_MV) {
    warn(
      'batteryLowMv',
      `A cutoff of ${config.batteryLowMv} mV leaves little margin — the device needs headroom to ` +
        'finish the clip it is writing and close the file cleanly.',
    );
  }

  // --- phases -------------------------------------------------------------
  if (config.phases.length === 0) {
    error('phases', 'Add at least one recording phase.');
  }
  // FIRMWARE: the phase array holds six. On legacy firmware parse_line() indexes it
  // with no bounds check, so exceeding it corrupts memory rather than being ignored.
  if (config.phases.length > MAX_DEPLOYMENT_PHASES) {
    error(
      'phases',
      firmware.capabilities.boundsCheckedArrays
        ? `A deployment can have at most ${MAX_DEPLOYMENT_PHASES} phases. The device ignores any beyond that.`
        : `A deployment can have at most ${MAX_DEPLOYMENT_PHASES} phases. ` +
          `More than that overruns the device's memory and corrupts the deployment.`,
    );
  }

  /*
    The phases the card will actually carry, once daylight-saving changes are split out.

    Only worth its own message when the split is what pushes the count over; a deployment
    already over the limit is reported above.
  */
  if (config.phases.length <= MAX_DEPLOYMENT_PHASES && dstAdjustmentApplies(config)) {
    const written = dstSegments(config).length;
    if (written > MAX_DEPLOYMENT_PHASES) {
      error(
        'adjustForDst',
        `Adjusting for daylight saving splits this deployment into ${written} phases on the card, and ` +
          `the device holds ${MAX_DEPLOYMENT_PHASES}. Use fewer phases, or turn the adjustment off.`,
      );
    }
  }

  /*
    A position and a timezone that describe different places.

    The device resolves sunrise from the position and reads the schedule on the timezone's
    clock, so a mismatch — the browser's zone left in place for a site elsewhere, or a west
    longitude typed as positive — moves every solar period by hours without anything looking
    wrong. Solar noon more than three hours from 12:00 local is not a real place.
  */
  if (hasPosition(config) && config.phases.some((phase) => phase.audioRecordingMode === 'SCHEDULED' && phase.audioScheduleType === 'SOLAR')) {
    const noon = approximateSolarNoonMinutes(config.longitude!, deviceUtcOffsetSeconds(config));
    const fromNoon = Math.min(Math.abs(noon - 720), 1440 - Math.abs(noon - 720));
    if (fromNoon > 180) {
      const clock = `${String(Math.floor(noon / 60)).padStart(2, '0')}:${String(Math.round(noon % 60) % 60).padStart(2, '0')}`;
      // Clocks at a longitude sit within an hour or so of its solar time, so the two whole
      // hours either side of longitude / 15 are what the right timezone would be near.
      const hours = config.longitude! / 15;
      const utc = (value: number) => (value === 0 ? 'UTC' : `UTC${value > 0 ? '+' : '−'}${Math.abs(value)}`);
      const near = Math.floor(hours) === Math.ceil(hours) ? utc(Math.round(hours)) : `${utc(Math.floor(hours))} or ${utc(Math.ceil(hours))}`;
      warn(
        'longitude',
        `The deployment position and its timezone do not look like the same place: the sun is highest ` +
          `there at about ${clock} by ${config.timezone.replace(/_/g, ' ')} time, not near midday. A site at ` +
          `this longitude would normally use a timezone near ${near}. Check the timezone, and that a ` +
          'longitude west of Greenwich is negative.',
      );
    }
  }

  if (config.isPhased) {
    /*
      The name is dashboard metadata — the firmware ignores it — but it is the ONLY thing
      that distinguishes one phase from another in the pickers and in every message here.
      Two phases called the same thing makes "Phase Night overlaps the phase before it"
      impossible to act on.
    */
    const seenNames = new Map<string, number>();
    config.phases.forEach((phase, index) => {
      const key = phase.name.trim().toLowerCase();
      if (!key) {
        error(`phases.${index}.name`, 'Every phase needs a name, so they can be told apart.');
        return;
      }
      const first = seenNames.get(key);
      if (first === undefined) seenNames.set(key, index);
      else {
        error(
          `phases.${index}.name`,
          `Two phases are both called "${phase.name}". Give each one a distinct name — it is ` +
            'how they are told apart everywhere they are listed.',
        );
      }
    });

    /*
      Every phase carries its OWN audio and motion settings, and the editor shows one at a
      time. Summarizing them here is more use than telling someone to go and look: a phase
      left on the defaults is visible in the line rather than a click away.
    */
    if (config.phases.length > 1) {
      issues.push({
        severity: 'warning',
        path: 'phases',
        message: 'Each phase records with its own settings, so check every one before writing.',
        details: config.phases.map((phase) => {
          const audio = AUDIO_RECORDING_MODES[phase.audioRecordingMode] ?? phase.audioRecordingMode;
          const motion = IMU_RECORDING_MODES[phase.imuRecordingMode] ?? phase.imuRecordingMode;
          // "motion recording", not "motion": the ACTIVITY mode is itself called
          // "Motion-triggered", and the shorter prefix read "motion motion-triggered".
          // The rate only means something while something is being recorded.
          const motionDetail =
            phase.imuRecordingMode === 'NONE'
              ? `motion recording ${motion.toLowerCase()}`
              : `motion recording ${motion.toLowerCase()} at ${phase.imuSampleRateHz} Hz`;
          return `${phase.name} — ${audio.toLowerCase()} at ${phase.audioSampleRateHz / 1000} kHz, ${motionDetail}`;
        }),
      });
    }

    const ordered = [...config.phases]
      .map((phase, index) => ({ phase, index }))
      .sort((a, b) => Date.parse(a.phase.startTime ?? '') - Date.parse(b.phase.startTime ?? ''));

    let previousEnd: number | null = null;
    for (const { phase, index } of ordered) {
      const phaseStart = Date.parse(phase.startTime ?? '');
      const phaseEnd = Date.parse(phase.endTime ?? '');
      if (Number.isNaN(phaseStart) || Number.isNaN(phaseEnd)) {
        error(`phases.${index}`, `Phase "${phase.name}" needs both a start and an end time.`);
        continue;
      }
      if (phaseStart >= phaseEnd) {
        error(`phases.${index}.endTime`, `Phase "${phase.name}" must end after it starts.`);
      }
      if (phaseStart < start || phaseEnd > end) {
        error(
          `phases.${index}`,
          `Phase "${phase.name}" falls outside the deployment dates.`,
        );
      }
      if (previousEnd !== null && phaseStart < previousEnd) {
        error(`phases.${index}.startTime`, `Phase "${phase.name}" overlaps the phase before it.`);
      }
      // FIRMWARE: config_get_active_deployment_phase_index() returns -1 in a gap,
      // and the device records nothing until the next phase opens.
      if (previousEnd !== null && phaseStart > previousEnd) {
        warn(
          `phases.${index}.startTime`,
          `There is a gap before phase "${phase.name}". The device records nothing during a gap.`,
        );
      }
      previousEnd = phaseEnd;
    }
  }

  config.phases.forEach((phase, index) => validatePhase(phase, index, config, firmware, issues));
  // Errors first: only they stop a write, so they are what to read first. Stable, so each
  // group keeps the order the editor's panes run in.
  return [...issues.filter((issue) => issue.severity === 'error'), ...issues.filter((issue) => issue.severity === 'warning')];
}

/**
 * What is wrong with a device label, one sentence per problem.
 *
 * Shared by the editor and batch preparation, which applies it to every unit's label.
 */
export function deviceLabelProblems(label: string): string[] {
  const problems: string[] = [];
  if (!label.trim()) problems.push('Give the device a label.');
  if (label.length > DEVICE_LABEL_MAX_LEN) {
    problems.push(`Device labels are limited to ${DEVICE_LABEL_MAX_LEN} characters (this one is ${label.length}).`);
  }
  // FIRMWARE: the label becomes a FAT directory name via f_mkdir().
  if (/[\\/:*?"<>|]/.test(label)) {
    problems.push('Device labels cannot contain \\ / : * ? " < > or | — the label is used as a folder name on the card.');
  }
  return problems;
}

/** A window as the editor shows it, so an error names something findable on screen. */
function describeWindow(window: { startSecond: number; endSecond: number }): string {
  const clock = (seconds: number) => {
    const ofDay = ((seconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
    return `${String(Math.floor(ofDay / 3600)).padStart(2, '0')}:${String(Math.floor((ofDay % 3600) / 60)).padStart(2, '0')}`;
  };
  return `${clock(window.startSecond)}–${clock(window.endSecond)}`;
}

function validatePhase(
  phase: PhaseConfig,
  index: number,
  config: DeploymentConfig,
  firmware: FirmwareProfile,
  issues: ValidationIssue[],
): void {
  const at = (field: string) => `phases.${index}.${field}`;
  /**
   * Which phase a message is about, when that is a question worth answering.
   *
   * A single-phase deployment has exactly one set of everything, so naming "Default" in
   * every message is noise. With several phases it is the only way to know where to look.
   */
  const namesPhase = config.isPhased && config.phases.length > 1;
  /** Prefixes the phase where that is worth saying, and capitalizes whatever leads. */
  const inPhase = (body: string) =>
    namesPhase ? `Phase "${phase.name}": ${body}` : `${body.charAt(0).toUpperCase()}${body.slice(1)}`;
  /*
    Every message from here is ABOUT one phase, and the editor shows one phase at a time —
    so a message that does not say which one sends the reader hunting through the others.
    Applied in the helpers rather than at each of the call sites below, because doing it by
    hand is how most of them came to be missing it.
  */
  const error = (path: string, message: string, fix?: ValidationIssue['fix']) =>
    issues.push({ severity: 'error', path, message: inPhase(message), fix });
  const warn = (path: string, message: string, fix?: ValidationIssue['fix']) =>
    issues.push({ severity: 'warning', path, message: inPhase(message), fix });

  // The device never reads PHASE_NAME, but it still has to get past the line reader: a line
  // longer than it can buffer ends the parse and silently discards every phase after this one.
  if (phase.name.length > PHASE_NAME_MAX_LEN) {
    error(
      at('name'),
      `Phase names are limited to ${PHASE_NAME_MAX_LEN} characters (this one is ${phase.name.length}). ` +
        'A longer name makes a config line the device cannot read, and it discards the rest of the file.',
      { label: 'Shorten the name', patch: { [at('name')]: phase.name.slice(0, PHASE_NAME_MAX_LEN) } },
    );
  }

  const rate = effectiveSampleRateHz(phase);

  // Amplitude triggering runs off the analog comparator; there is no digital path.
  if (config.micType === 'DIGITAL' && phase.audioRecordingMode === 'AMPLITUDE') {
    error(
      at('audioRecordingMode'),
      'Sound-triggered recording needs an analog microphone. This device has a digital one.',
      {
        label: 'Switch to scheduled recording',
        patch: { [at('audioRecordingMode')]: 'SCHEDULED' },
      },
    );
  }

  if (phase.audioRecordingMode === 'AMPLITUDE') {
    // FIRMWARE, and the single most consequential rule here. Zero has meant three
    // different things across three builds: "never record" on legacy, briefly
    // "unlimited", and now "one clip per window" — runtime_config.c rewrites a zero cap
    // to 1 for amplitude phases and records that it corrected the file. None of those is
    // what someone writing zero intends, so the editor never writes it.
    if (phase.maxAudioClips <= 0) {
      error(
        at('maxAudioClips'),
        firmware.capabilities.zeroClipCapIsRewritten
          ? `A cap of zero is rewritten to a single clip per ${phase.maxClipsTimeScale.toLowerCase().replace(/s$/, '')} ` +
            'by the device, which is almost certainly not what you want. Set the number of clips it may capture.'
          : `On ${firmware.label} firmware a cap of zero stops the device recording altogether. ` +
            'Set how many clips it may capture per time period.',
        {
          label: 'Use 60 per hour',
          patch: { [at('maxAudioClips')]: 60, [at('maxClipsTimeScale')]: 'HOURS' },
        },
      );
    }
    if (phase.audioTriggerThreshold <= 0 || phase.audioTriggerThreshold > 1) {
      error(
        at('audioTriggerThreshold'),
        'The trigger level is a fraction of full scale between 0 and 1.',
      );
    } else if (fractionToWiper(phase.audioTriggerThreshold) < MIN_WIPER) {
      // The comparator reference is an 8-bit digipot and the firmware truncates into
      // it, so anything below 1/255 lands on wiper 0 and never arms the trigger.
      // Ordinary quantization above that point is inherent to the hardware and is
      // handled by the control, not reported here.
      error(
        at('audioTriggerThreshold'),
        `A trigger level this low cannot be set on the hardware, and the device would ` +
          `never record. The quietest usable level is ${MIN_THRESHOLD_DBFS.toFixed(0)} dBFS.`,
        {
          label: `Use ${MIN_THRESHOLD_DBFS.toFixed(0)} dBFS`,
          patch: { [at('audioTriggerThreshold')]: wiperToStoredFraction(MIN_WIPER) },
        },
      );
    }
    if (phase.extendClipIfContinuousAudio && phase.maxAudioClips === 1) {
      warn(
        at('extendClipIfContinuousAudio'),
        'An allowance of one clip leaves nothing for a clip to extend into, so recordings will ' +
          'stop at the clip length anyway. Raise the allowance to let a longer sound run on.',
      );
    }
    // The cap window has to be long enough to actually fit the clips it permits.
    const windowSeconds = TIME_SCALE_SECONDS[phase.maxClipsTimeScale];
    if (phase.maxAudioClips * phase.audioClipLengthSeconds > windowSeconds) {
      warn(
        at('maxAudioClips'),
        `${phase.maxAudioClips} clips of ${phase.audioClipLengthSeconds}s cannot fit in one ` +
          `${phase.maxClipsTimeScale.toLowerCase().replace(/s$/, '')}. The device will record ` +
          `continuously up to the cap instead.`,
      );
    }
  }

  // FIRMWARE: extension runs on in whole clip lengths while the sound lasts, and each one
  // spends a clip from the allowance — so the worst case stays at max clips x clip length,
  // which is exactly what the storage and battery estimate is built on.
  // Deliberately not warned about. The checkbox only exists under sound-triggered
  // recording, so changing the mode takes the control off screen and leaves a warning
  // pointing at something the user can no longer see or fix. The serializer already omits
  // AUDIO_EXTEND_CLIP outside that mode, so a stale flag never reaches the device.

  if (phase.audioRecordingMode === 'INTERVAL') {
    const intervalSeconds =
      phase.audioTriggerInterval * TIME_SCALE_SECONDS[phase.audioTriggerIntervalTimeScale];
    if (phase.audioClipLengthSeconds > intervalSeconds) {
      error(
        at('audioTriggerInterval'),
        // Phrased without an article in front of a number, which "a 80s interval" got wrong.
        `Clips of ${phase.audioClipLengthSeconds} s do not fit into an interval of ${intervalSeconds} s. ` +
          'Lengthen the interval or shorten the clip.',
      );
    }
  }

  if (phase.audioRecordingMode === 'SCHEDULED') {
    const solar = phase.audioScheduleType === 'SOLAR';

    /*
      The fixed windows mean different things under the two schedule types, so they are
      judged differently.

      Under a CLOCK schedule they ARE the schedule, and having none means recording nothing.
      Under a SOLAR schedule the device computes the real windows itself and these are only
      the fallback for a day the sun gives it nothing — so their absence is a warning about a
      specific risk rather than an error, and the warning names that risk instead of telling
      someone to add windows they did not think they needed.
    */
    if (phase.audioTriggerTimes.length === 0) {
      if (solar) {
        // FIRMWARE: an empty schedule is not silence. seconds_until_next_scheduled_recording()
        // returns zero for an empty list, so a solar day with nothing to fall back on is
        // recorded around the clock — and runtime_config.c marks the file corrected for it.
        warn(
          at('audioTriggerTimes'),
          'the solar schedule has no fallback recording periods. On any day the sun gives no ' +
            'usable period, the device records continuously instead.',
        );
      } else {
        error(
          at('audioTriggerTimes'),
          'add at least one recording period. With none, the device ignores the schedule and records continuously.',
        );
      }
    }

    if (solar) {
      if (phase.audioSolarWindows.length === 0) {
        error(at('audioSolarWindows'), 'add at least one solar recording period.');
      }
      // FIRMWARE: solar_trigger_times[] is the same fixed 12-entry array as the clock schedule,
      // and runtime_config.c refuses the extras rather than writing past the end.
      if (phase.audioSolarWindows.length > MAX_AUDIO_TRIGGER_TIMES) {
        error(
          at('audioSolarWindows'),
          `A phase can have at most ${MAX_AUDIO_TRIGGER_TIMES} solar recording periods. The device ignores any beyond that.`,
        );
      }
      for (const window of phase.audioSolarWindows) {
        // FIRMWARE: the offset is stored in an int16 and runtime_config.c REFUSES an entry
        // outside that range rather than clamping it, so an over-large offset silently drops
        // the whole period rather than shifting it.
        for (const offset of [window.startOffsetSeconds, window.endOffsetSeconds]) {
          if (!Number.isInteger(offset) || offset < SOLAR_OFFSET_MIN_SECONDS || offset > SOLAR_OFFSET_MAX_SECONDS) {
            error(
              at('audioSolarWindows'),
              `A solar offset must be a whole number of seconds between ${SOLAR_OFFSET_MIN_SECONDS} and ` +
                `${SOLAR_OFFSET_MAX_SECONDS}. The device refuses the whole period otherwise.`,
            );
            break;
          }
        }
      }
      /*
        A period that ends before it starts, on any day the phase runs.

        FIRMWARE: resolve_solar_schedule() skips it for that day and logs SOLAR_REVERSED. It is
        a configuration mistake rather than a period across midnight — which the device now
        records, split either side — and it can hold on only part of the year, since the gap
        between two anchors changes with the season.
      */
      if (hasPosition(config)) {
        const from = Date.parse(config.isPhased ? (phase.startTime ?? config.startTime) : config.startTime);
        const to = Date.parse(config.isPhased ? (phase.endTime ?? config.endTime) : config.endTime);
        solarPeriodReports(phase, config, from, to).forEach((report, windowIndex) => {
          if (!report.reversedDays) return;
          const days = report.reversedDays === report.daysChecked ? 'every day' : `${report.reversedDays} of the ${report.daysChecked} days checked`;
          error(
            at('audioSolarWindows'),
            `solar recording period ${windowIndex + 1} ends before it starts on ${days}` +
              (report.firstReversedAt !== null && report.reversedDays < report.daysChecked
                ? `, starting ${formatZonedDate(new Date(report.firstReversedAt).toISOString(), config.timezone)}`
                : '') +
              '. The device skips it on those days. Move its end later, or its start earlier.',
          );
        });
      }

      // Without a position the device can never resolve any of this, so it would run the
      // fallback every single day and the solar schedule would be decoration.
      if (!hasPosition(config)) {
        error(
          'latitude',
          'A solar schedule needs the deployment position. Without it the device cannot work ' +
            'out sunrise and will use the fallback recording periods every day.',
        );
      }
    }

    /*
      The clock periods, as the device will receive them.

      An overnight period is written as two entries either side of midnight, so the device's
      limit is on entries rather than on periods — twelve overnight periods would not fit.
    */
    const entries = firmwareEntryCount(phase.audioTriggerTimes);
    if (entries > MAX_AUDIO_TRIGGER_TIMES) {
      const overnight = entries > phase.audioTriggerTimes.length;
      error(
        at('audioTriggerTimes'),
        `A phase can have at most ${MAX_AUDIO_TRIGGER_TIMES} recording period entries` +
          (overnight ? `, and each period that runs past midnight takes two (this schedule needs ${entries}).` : '.') +
          (firmware.capabilities.boundsCheckedArrays
            ? ' The device ignores any beyond that.'
            : " More than that overruns the device's memory."),
      );
    }
    for (const window of phase.audioTriggerTimes) {
      if (window.startSecond === window.endSecond) {
        error(
          at('audioTriggerTimes'),
          `recording period ${describeWindow(window)} starts and ends at the same time.`,
        );
        break;
      }
      if (window.startSecond < 0 || window.startSecond >= SECONDS_PER_DAY || window.endSecond < window.startSecond) {
        error(at('audioTriggerTimes'), `recording period ${describeWindow(window)} must end after it starts.`);
        break;
      }
      if (periodDuration(window) > SECONDS_PER_DAY) {
        error(at('audioTriggerTimes'), `recording period ${describeWindow(window)} is longer than a day.`);
        break;
      }
    }
    // Overlaps are judged on the part of the day each period covers, so an overnight period
    // collides with a morning one exactly where it should.
    const segments = phase.audioTriggerTimes
      .filter((window) => periodDuration(window) > 0 && periodDuration(window) <= SECONDS_PER_DAY)
      .flatMap((window) => periodSegments(window).map((segment) => ({ segment, window })))
      .sort((a, b) => a.segment.startSecond - b.segment.startSecond);
    let reach: (typeof segments)[number] | null = null;
    for (const current of segments) {
      if (reach && current.segment.startSecond < reach.segment.endSecond && current.window !== reach.window) {
        // Naming both is the point: "periods cannot overlap" leaves someone scanning a list
        // of twelve to work out which pair is at fault.
        error(
          at('audioTriggerTimes'),
          `recording periods ${describeWindow(reach.window)} and ${describeWindow(current.window)} must not overlap.`,
        );
        break;
      }
      if (!reach || current.segment.endSecond > reach.segment.endSecond) reach = current;
    }
  }

  // --- audio quality ------------------------------------------------------
  if (phase.audioClipLengthSeconds < 1) {
    error(at('audioClipLengthSeconds'), 'Clips must be at least 1 second long.');
  }
  if (phase.useOpusEncoding) {
    if (phase.opusBitrate < OPUS_MIN_BITRATE || phase.opusBitrate > OPUS_MAX_BITRATE) {
      error(
        at('opusBitrate'),
        `Opus bitrate must be between ${OPUS_MIN_BITRATE} and ${OPUS_MAX_BITRATE} bps.`,
      );
    }
    // FIRMWARE: runtime_config.c overrides the sample rate whenever Opus is on.
    if (phase.audioSampleRateHz !== rate) {
      warn(
        at('audioSampleRateHz'),
        `Opus recording always runs at ${rate} Hz. The device ignores the ${phase.audioSampleRateHz} Hz setting.`,
      );
    }
  }

  // The hardware cannot produce every rate exactly, and which ones it misses depends on
  // the microphone. The firmware writes the achieved rate into the WAV header, so nothing
  // is mislabeled -- but the label will not be the number that was asked for, and that
  // is worth knowing before a card is written rather than after a field season.
  const clock = achievableSampleRate(phase.audioSampleRateHz, config.micType);
  if (!clock.reachable) {
    error(
      at('audioSampleRateHz'),
      `${micPhrase(config.micType, true)} cannot produce ${phase.audioSampleRateHz} Hz at all.`,
    );
  } else if (!clock.exact) {
    warn(
      at('audioSampleRateHz'),
      `${micPhrase(config.micType, true)} cannot produce exactly ${phase.audioSampleRateHz} Hz. ` +
        `It will record at ${clock.actualHz} Hz, ${Math.abs(clock.errorFraction * 100).toFixed(2)}% ` +
        `${clock.errorFraction > 0 ? 'fast' : 'slow'}, and label the files with that rate.`,
    );
  }

  // --- audio filter -------------------------------------------------------
  if (phase.audioFilterType !== 'NONE') {
    // NOT maxFrequencyCeilingHz: that 200 Hz headroom belongs to the silence filter's FFT
    // bins. audio_filter.c clamps its corners to nyquist - 1, and nothing narrower.
    const filterCeiling = filterCornerCeilingHz(phase);
    const usesLow = phase.audioFilterType === 'HIGH' || phase.audioFilterType === 'BAND';
    const usesHigh = phase.audioFilterType === 'LOW' || phase.audioFilterType === 'BAND';

    if (usesLow && (phase.audioFilterLowHz <= 0 || phase.audioFilterLowHz >= filterCeiling)) {
      error(
        at('audioFilterLowHz'),
        `The high-pass corner must be between 1 and ${filterCeiling} Hz at this sample rate.`,
      );
    }
    if (usesHigh && (phase.audioFilterHighHz <= 0 || phase.audioFilterHighHz > filterCeiling)) {
      error(
        at('audioFilterHighHz'),
        `The low-pass corner must be between 1 and ${filterCeiling} Hz at this sample rate.`,
        { label: `Use ${filterCeiling} Hz`, patch: { [at('audioFilterHighHz')]: filterCeiling } },
      );
    }
    if (phase.audioFilterType === 'BAND' && phase.audioFilterLowHz >= phase.audioFilterHighHz) {
      error(at('audioFilterLowHz'), 'The high-pass corner must be below the low-pass corner.');
    }
    // A band that excludes what the silence detector listens for would discard the
    // very energy that decides whether a clip is kept.
    if (phase.silenceThreshold > 0 && usesHigh && phase.minFrequencyHz > phase.audioFilterHighHz) {
      warn(
        at('minFrequencyHz'),
        'Silence detection listens above the filter band, so every clip will look silent.',
      );
    }
  }

  if (
    !Number.isFinite(phase.audioClipLengthSeconds) ||
    phase.audioClipLengthSeconds < AUDIO_MIN_CLIP_LENGTH_SECONDS ||
    phase.audioClipLengthSeconds > AUDIO_MAX_CLIP_LENGTH_SECONDS
  ) {
    // FIRMWARE: runtime_config.c and audio.c both clamp this, so an out-of-range value is
    // not rejected on device — it is quietly replaced, and the deployment records clips of
    // a length the configuration never asked for.
    error(
      at('audioClipLengthSeconds'),
      `Clip length must be between ${AUDIO_MIN_CLIP_LENGTH_SECONDS} and ` +
        `${AUDIO_MAX_CLIP_LENGTH_SECONDS} seconds. The device clamps anything outside that ` +
        'rather than reporting it.',
      {
        label: `Use ${AUDIO_DEFAULT_CLIP_LENGTH_SECONDS} s`,
        patch: { [at('audioClipLengthSeconds')]: AUDIO_DEFAULT_CLIP_LENGTH_SECONDS },
      },
    );
  }

  /*
    Only when a threshold makes the device read the band.

    `serializeConfig` omits MIN_FREQUENCY and MAX_FREQUENCY entirely at a zero threshold,
    and the editor now hides the controls to match, so complaining about them otherwise
    raised a readiness issue about a value that is neither written nor on screen.
  */
  const ceiling = maxFrequencyCeilingHz(rate);
  if (phase.silenceThreshold > 0) {
    if (phase.maxFrequencyHz > ceiling) {
      // FIRMWARE: silently clamped on device, so the card and the plan disagreed.
      warn(
        at('maxFrequencyHz'),
        `The highest usable frequency at ${rate} Hz is ${ceiling} Hz. The device clamps anything above it.`,
        { label: `Use ${ceiling} Hz`, patch: { [at('maxFrequencyHz')]: ceiling } },
      );
    }
    if (phase.minFrequencyHz >= phase.maxFrequencyHz) {
      error(at('minFrequencyHz'), 'The low end of the frequency range must be below the high end.');
    }
  }
  if (phase.silenceThreshold < 0 || phase.silenceThreshold > 1) {
    error(at('silenceThreshold'), 'The silence threshold is a fraction of full scale between 0 and 1.');
  }

  // --- IMU ----------------------------------------------------------------
  // FIRMWARE: active_main.c passes the threshold to imu_enable_motion_change_detection(),
  // which converts it to the sensor's own units. Legacy firmware ignored it entirely and
  // used the part's built-in default, so on that profile this is a warning, not an error.
  if (phase.imuRecordingMode === 'ACTIVITY') {
    if (!firmware.capabilities.adjustableMotionThreshold) {
      warn(
        at('imuTriggerThresholdMg'),
        `Motion sensitivity is not adjustable on ${firmware.label} firmware. The device uses ` +
          'its built-in motion detection regardless of this value.',
      );
    } else if (
      phase.imuTriggerThresholdMg < IMU_MOTION_THRESHOLD_MIN_MG ||
      phase.imuTriggerThresholdMg > IMU_MOTION_THRESHOLD_MAX_MG
    ) {
      error(
        at('imuTriggerThresholdMg'),
        `Motion sensitivity must be between ${IMU_MOTION_THRESHOLD_MIN_MG.toFixed(1)} and ` +
          `${IMU_MOTION_THRESHOLD_MAX_MG} mg.`,
      );
    }
  }
}

/** True when nothing blocks writing this config to a card. */
export function isWritable(
  config: DeploymentConfig,
  firmware: FirmwareProfile = DEFAULT_FIRMWARE_PROFILE,
  options: ValidateOptions = {},
): boolean {
  return !validateConfig(config, firmware, options).some((issue) => issue.severity === 'error');
}

/** Both coordinates present and in range, matching `solar_position_valid()` on the device. */
function hasPosition(config: DeploymentConfig): boolean {
  return (
    config.latitude !== null &&
    config.longitude !== null &&
    Number.isFinite(config.latitude) &&
    Number.isFinite(config.longitude) &&
    Math.abs(config.latitude) <= LATITUDE_MAX_DEG &&
    Math.abs(config.longitude) <= LONGITUDE_MAX_DEG
  );
}

/** "An analog microphone" or "A digital microphone" — the article follows the word. */
function micPhrase(micType: DeploymentConfig['micType'], capitalized = false): string {
  const phrase = micType === 'ANALOG' ? 'an analog microphone' : 'a digital microphone';
  return capitalized ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
}
