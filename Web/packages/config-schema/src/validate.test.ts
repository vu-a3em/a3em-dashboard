import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultConfig, defaultPhase } from './defaults.js';
import { validateConfig } from './validate.js';
import { serializeConfig } from './serialize.js';
import { IMU_SAMPLE_RATES_HZ, PHASE_NAME_MAX_LEN } from './firmware-constants.js';
import { DEFAULT_FIRMWARE_PROFILE, FIRMWARE_CURRENT } from './firmware-profile.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';

describe('microphone gain', () => {
  const base = (micType: 'ANALOG' | 'DIGITAL', micAmplificationDb: number) => ({
    ...defaultConfig(),
    deviceLabel: 'TEST',
    micType,
    micAmplificationDb,
    // Amplitude triggering needs the analog comparator; keep the mode out of the way so the
    // only thing under test is the gain.
    phases: defaultConfig().phases.map((p) => ({ ...p, audioRecordingMode: 'CONTINUOUS' as const })),
  });
  const gainIssues = (micType: 'ANALOG' | 'DIGITAL', gain: number) =>
    validateConfig(base(micType, gain), FIRMWARE_CURRENT).filter(
      (issue) => issue.path === 'micAmplificationDb',
    );

  it('rejects a gain the fitted microphone cannot reach', () => {
    // audio.c clamps both paths without reporting it, so anything past the ceiling is simply
    // not the gain the deployment runs at. The two paths do not share a ceiling.
    for (const gain of [-1, 45.5, 100, Number.NaN]) {
      assert.ok(
        gainIssues('ANALOG', gain).some((issue) => issue.severity === 'error'),
        `${gain} dB should have been rejected on an analog microphone`,
      );
    }
    for (const gain of [-1, 34.6, 35, 100, Number.NaN]) {
      assert.ok(
        gainIssues('DIGITAL', gain).some((issue) => issue.severity === 'error'),
        `${gain} dB should have been rejected on a digital microphone`,
      );
    }
  });

  it('accepts the whole analog range, which reaches higher than the digital one', () => {
    // The analog PGA is continuous over [0, 45], so nothing here should be remarked on.
    for (const gain of [0, 1, 17.5, 35, 45]) {
      assert.deepEqual(gainIssues('ANALOG', gain), [], `${gain} dB should be fine on analog`);
    }
  });

  it('warns when a digital microphone will round the gain to its own ladder', () => {
    // The PDM path has only 1.5 dB steps. Landing on one is silent; between two is not.
    for (const gain of [0, 1.5, 18, 34.5]) {
      assert.deepEqual(gainIssues('DIGITAL', gain), [], `${gain} dB is on the ladder`);
    }
    const issues = gainIssues('DIGITAL', 17.5);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'warning');
    assert.match(issues[0]!.message, /will run at 18 dB/);
  });
});

describe('what a new deployment starts at', () => {
  it('uses the chosen starting values, not the firmware fallbacks', () => {
    const config = defaultConfig();
    assert.equal(config.micAmplificationDb, 1.5);
    assert.equal(config.magnetValidationMs, 3000);
    assert.equal(config.vhfMode, 'NEVER');
    assert.equal(config.phases[0].audioRecordingMode, 'CONTINUOUS');
    assert.equal(config.phases[0].imuSampleRateHz, 50);
    assert.equal(config.micType, 'DIGITAL');
  });

  it('starts a deployment with nothing to fix but the label', () => {
    const errors = validateConfig(defaultConfig(), FIRMWARE_CURRENT).filter((i) => i.severity === 'error');
    assert.deepEqual(errors.map((issue) => issue.path), ['deviceLabel']);
  });
});

describe('limits that come from the config file rather than the device', () => {
  it('rejects a phase name that would make an unreadable line', () => {
    // The firmware has no PHASE_NAME branch, so nothing on the device cares what it says —
    // but the line still has to be read, and a line the reader gives up on takes every
    // following phase with it. Serializing throws; validation has to catch it first so the
    // user sees a field to fix instead of an exception.
    const config = { ...defaultConfig(), deviceLabel: 'TEST' };
    config.phases = [{ ...config.phases[0]!, name: 'x'.repeat(PHASE_NAME_MAX_LEN + 1) }];
    const issues = validateConfig(config, FIRMWARE_CURRENT).filter((i) => i.path === 'phases.0.name');
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'error');

    config.phases = [{ ...config.phases[0]!, name: 'x'.repeat(PHASE_NAME_MAX_LEN) }];
    assert.deepEqual(
      validateConfig(config, FIRMWARE_CURRENT).filter((i) => i.path === 'phases.0.name'),
      [],
      'a name that exactly fills the line is still fine',
    );
    assert.doesNotThrow(() => serializeConfig(config));
  });

  it('lets the low-pass corner go where the filter actually allows', () => {
    // audio_filter.c clamps its corners to nyquist - 1. The 200 Hz headroom belongs to the
    // silence filter's FFT bins and has no bearing here, so applying it used to lower a
    // perfectly valid corner without saying so.
    const config = { ...defaultConfig(), deviceLabel: 'TEST' };
    config.phases = [
      {
        ...config.phases[0]!,
        audioSampleRateHz: 16000,
        audioFilterType: 'LOW',
        audioFilterHighHz: 7900, // inside nyquist - 1, but above the 7800 bin ceiling
      },
    ];
    assert.deepEqual(
      validateConfig(config, FIRMWARE_CURRENT).filter((i) => i.path === 'phases.0.audioFilterHighHz'),
      [],
      '7900 Hz is a corner the device honours at 16 kHz',
    );
    assert.match(serializeConfig(config), /FILTER_HIGH_FREQUENCY = "7900"/);

    config.phases = [{ ...config.phases[0]!, audioFilterHighHz: 8000 }]; // nyquist itself
    assert.ok(
      validateConfig(config, FIRMWARE_CURRENT).some(
        (i) => i.path === 'phases.0.audioFilterHighHz' && i.severity === 'error',
      ),
    );
  });

  it('offers only IMU rates the sensor reproduces and the file can state', () => {
    // imu.c snaps to the LIS2DU12 ODR ladder while storage.c writes the CONFIGURED rate into
    // the .imu header as an integer. A rate where those disagree becomes a growing timestamp
    // error, so 12 (really 12.5) and 1.6 are not offered at all.
    const ladder = [3, 6, 12.5, 25, 50, 100, 200, 400, 800];
    for (const rate of IMU_SAMPLE_RATES_HZ) {
      assert.ok(ladder.includes(rate), `${rate} Hz is not an ODR the part produces`);
      assert.equal(rate, Math.round(rate), `${rate} Hz cannot be written to the .imu header`);
    }
  });
});

describe('extending a clip while a sound continues', () => {
  const phaseWith = (overrides: Partial<ReturnType<typeof defaultConfig>['phases'][0]>) => {
    const config = { ...defaultConfig(), deviceLabel: 'TEST', micType: 'ANALOG' as const };
    return {
      ...config,
      phases: [
        {
          ...config.phases[0]!,
          audioRecordingMode: 'AMPLITUDE' as const,
          maxAudioClips: 60,
          audioTriggerThreshold: 0.08,
          extendClipIfContinuousAudio: true,
          audioTriggerTimes: [{ startSecond: 0, endSecond: 3600 }],
          ...overrides,
        },
      ],
    };
  };
  const extendIssues = (config: ReturnType<typeof phaseWith>) =>
    validateConfig(config, FIRMWARE_CURRENT).filter((i) =>
      i.path.endsWith('extendClipIfContinuousAudio'),
    );

  it('is written only for sound-triggered recording', () => {
    // Amplitude is the one mode where a SOUND started the clip, so it is the only one where
    // "keep going while that sound lasts" is a question that can be asked at all. A clock
    // started it everywhere else.
    assert.match(serializeConfig(phaseWith({})), /AUDIO_EXTEND_CLIP/);
    for (const audioRecordingMode of ['SCHEDULED', 'INTERVAL', 'CONTINUOUS'] as const) {
      assert.doesNotMatch(serializeConfig(phaseWith({ audioRecordingMode })), /AUDIO_EXTEND_CLIP/);
      // Not warned about either: the checkbox is gone from the form in these modes, so a
      // warning would point at a control the user can no longer see. The omission above is
      // what actually protects the device.
      assert.deepEqual(extendIssues(phaseWith({ audioRecordingMode })), []);
    }
  });

  it('does not require a silence threshold', () => {
    // The trigger level that started the clip is the fallback stop condition, so extension
    // works with nothing else configured. A silence threshold is an upgrade, not a dependency.
    assert.deepEqual(extendIssues(phaseWith({ silenceThreshold: 0 })), []);
    assert.deepEqual(extendIssues(phaseWith({ silenceThreshold: 0.05 })), []);
  });

  it('points out an allowance that leaves nothing to extend into', () => {
    // Each further clip length spends one clip from the allowance, so a cap of one means the
    // recording stops at the clip length no matter what the sound does.
    const issues = extendIssues(phaseWith({ maxAudioClips: 1 }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'warning');
    assert.match(issues[0]!.message, /nothing for a clip to extend into/);
    assert.deepEqual(extendIssues(phaseWith({ maxAudioClips: 2 })), []);
  });
});

describe('phases are told apart by name', () => {
  const phased = (names: string[]) => {
    const base = defaultConfig();
    const start = Date.parse(base.startTime);
    const span = (Date.parse(base.endTime) - start) / names.length;
    return {
      ...base,
      deviceLabel: 'TEST',
      isPhased: true,
      phases: names.map((name, index) => ({
        ...defaultPhase(name),
        startTime: new Date(start + index * span).toISOString(),
        endTime: new Date(start + (index + 1) * span).toISOString(),
      })),
    };
  };
  const nameIssues = (config: ReturnType<typeof phased>) =>
    validateConfig(config, FIRMWARE_CURRENT).filter((issue) => issue.path.endsWith('.name'));

  it('rejects two phases sharing a name', () => {
    const issues = nameIssues(phased(['Dawn', 'Dawn']));
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'error');
    assert.match(issues[0]!.message, /both called "Dawn"/);
  });

  it('treats names differing only by case or padding as the same', () => {
    // They are indistinguishable in a dropdown, which is the whole point of the rule.
    assert.equal(nameIssues(phased(['Night', ' night '])).length, 1);
  });

  it('accepts distinct names', () => {
    assert.deepEqual(nameIssues(phased(['Dawn', 'Day', 'Night'])), []);
  });

  it('rejects an empty name', () => {
    assert.match(nameIssues(phased(['Dawn', '  ']))[0]!.message, /needs a name/);
  });

  it('reminds that every phase carries its own settings, and says what they are', () => {
    const issues = validateConfig(phased(['Dawn', 'Night']), FIRMWARE_CURRENT).filter(
      (issue) => issue.path === 'phases' && issue.severity === 'warning',
    );
    assert.equal(issues.length, 1);
    // One entry per phase, so the UI can list them rather than run them into a sentence.
    assert.equal(issues[0]!.details?.length, 2);
    assert.match(issues[0]!.details![0]!, /^Dawn — /);
    assert.match(issues[0]!.details![1]!, /^Night — /);
    assert.doesNotMatch(issues[0]!.message, /Dawn/);
  });

  it('says nothing about phases when there is only one', () => {
    assert.deepEqual(
      validateConfig(phased(['Only']), FIRMWARE_CURRENT).filter(
        (issue) => issue.path === 'phases' && issue.severity === 'warning',
      ),
      [],
    );
  });
});

describe('how a phase summary reads', () => {
  const twoPhases = (patch: Partial<ReturnType<typeof defaultPhase>>) => {
    const base = defaultConfig();
    const start = Date.parse(base.startTime);
    const half = (Date.parse(base.endTime) - start) / 2;
    return validateConfig(
      {
        ...base,
        deviceLabel: 'TEST',
        isPhased: true,
        phases: [
          { ...defaultPhase('First'), ...patch, startTime: base.startTime, endTime: new Date(start + half).toISOString() },
          { ...defaultPhase('Second'), startTime: new Date(start + half).toISOString(), endTime: base.endTime },
        ],
      },
      FIRMWARE_CURRENT,
    ).find((issue) => issue.path === 'phases' && issue.severity === 'warning')!.details!;
  };

  it('names the motion rate when motion is being recorded', () => {
    const [first] = twoPhases({ imuRecordingMode: 'AUDIO', imuSampleRateHz: 50 });
    assert.match(first!, /motion recording synchronised with audio at 50 Hz/);
  });

  it('omits the rate when motion is off', () => {
    const [first] = twoPhases({ imuRecordingMode: 'NONE' });
    // Ends there: no rate follows. (The audio half legitimately carries a kHz of its own.)
    assert.match(first!, /motion recording disabled$/);
  });

  it('does not say motion twice for the motion-triggered mode', () => {
    const [first] = twoPhases({ imuRecordingMode: 'ACTIVITY' });
    assert.match(first!, /motion recording motion-triggered at/);
    assert.doesNotMatch(first!, /motion motion-triggered/);
  });
});

describe('recording window errors point at the window', () => {
  const scheduled = (windows: Array<{ startSecond: number; endSecond: number }>, phased = false) => {
    const base = defaultConfig();
    const start = Date.parse(base.startTime);
    const half = (Date.parse(base.endTime) - start) / 2;
    const first = {
      ...defaultPhase('Dawn'),
      audioRecordingMode: 'SCHEDULED' as const,
      audioTriggerTimes: windows,
      startTime: base.startTime,
      endTime: new Date(start + half).toISOString(),
    };
    return validateConfig(
      {
        ...base,
        deviceLabel: 'TEST',
        isPhased: phased,
        phases: phased
          ? [first, { ...defaultPhase('Night'), startTime: new Date(start + half).toISOString(), endTime: base.endTime }]
          : [first],
      },
      FIRMWARE_CURRENT,
    ).filter((issue) => issue.path.endsWith('audioTriggerTimes'));
  };
  const h = (hour: number) => hour * 3600;

  it('names both windows that overlap', () => {
    const [issue] = scheduled([
      { startSecond: h(6), endSecond: h(9) },
      { startSecond: h(8), endSecond: h(10) },
    ]);
    assert.match(issue!.message, /06:00–09:00 and 08:00–10:00/);
    assert.match(issue!.message, /must not overlap\./);
  });

  it('names the phase when there is more than one to confuse', () => {
    const [issue] = scheduled(
      [
        { startSecond: h(6), endSecond: h(9) },
        { startSecond: h(8), endSecond: h(10) },
      ],
      true,
    );
    assert.match(issue!.message, /^Phase "Dawn": /);
  });

  it('stays quiet about the phase when there is only one', () => {
    const [issue] = scheduled([
      { startSecond: h(6), endSecond: h(9) },
      { startSecond: h(8), endSecond: h(10) },
    ]);
    assert.doesNotMatch(issue!.message, /Phase "/);
  });

  it('says which window ends before it starts', () => {
    const [issue] = scheduled([{ startSecond: h(9), endSecond: h(6) }]);
    assert.match(issue!.message, /09:00–06:00/);
  });

  it('never calls them listening windows', () => {
    const [issue] = scheduled([
      { startSecond: h(6), endSecond: h(9) },
      { startSecond: h(8), endSecond: h(10) },
    ]);
    assert.doesNotMatch(issue!.message, /listening/i);
  });
});

describe('selecting a high-pass filter', () => {
  const withFilter = (patch: Partial<ReturnType<typeof defaultPhase>>) =>
    validateConfig(
      { ...defaultConfig(), deviceLabel: 'TEST', phases: [{ ...defaultPhase(), ...patch }] },
      FIRMWARE_CURRENT,
    ).filter((issue) => issue.path.endsWith('audioFilterLowHz'));

  it('is valid straight away on the defaults', () => {
    // Choosing High-pass used to paint the corner red before the user had touched it,
    // because a new phase started at 0 and 0 is not a corner the firmware can design for.
    assert.deepEqual(withFilter({ audioFilterType: 'HIGH' }), []);
    assert.deepEqual(withFilter({ audioFilterType: 'BAND' }), []);
  });

  it('still rejects a zero corner if one reaches it', () => {
    const issues = withFilter({ audioFilterType: 'HIGH', audioFilterLowHz: 0 });
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'error');
  });

  it('leaves the corner alone for filters that do not use it', () => {
    assert.deepEqual(withFilter({ audioFilterType: 'NONE', audioFilterLowHz: 0 }), []);
    assert.deepEqual(withFilter({ audioFilterType: 'LOW', audioFilterLowHz: 0 }), []);
  });
});

describe('input bounds agree with the rules that judge them', () => {
  // The controls carry min/max, but those only bind the spinner arrows — a typed value is
  // judged here. Where the two disagree the user is either offered a value that is then
  // rejected, or stopped from entering one the device would honour. Both have happened.
  const rejects = (config: ReturnType<typeof defaultConfig>, field: string) =>
    validateConfig(config, FIRMWARE_CURRENT).some(
      (issue) => issue.path.endsWith(field) && issue.severity === 'error',
    );

  for (const audioSampleRateHz of [8000, 16000, 24000, 48000]) {
    const phase = (patch: Partial<ReturnType<typeof defaultPhase>>) => ({
      ...defaultConfig(),
      deviceLabel: 'TEST',
      phases: [{ ...defaultPhase(), audioSampleRateHz, ...patch }],
    });
    // audio_filter.c clamps its corners to nyquist - 1, which is NOT the silence band's
    // nyquist - 200. The controls used the stricter one and capped 199 Hz too low.
    const corner = Math.floor(audioSampleRateHz / 2) - 1;

    it(`accepts a low-pass corner on the filter ceiling at ${audioSampleRateHz} Hz`, () => {
      assert.ok(!rejects(phase({ audioFilterType: 'LOW', audioFilterHighHz: corner }), 'audioFilterHighHz'));
      assert.ok(rejects(phase({ audioFilterType: 'LOW', audioFilterHighHz: corner + 1 }), 'audioFilterHighHz'));
    });

    it(`accepts a high-pass corner one below it at ${audioSampleRateHz} Hz`, () => {
      assert.ok(!rejects(phase({ audioFilterType: 'HIGH', audioFilterLowHz: corner - 1 }), 'audioFilterLowHz'));
      assert.ok(rejects(phase({ audioFilterType: 'HIGH', audioFilterLowHz: corner }), 'audioFilterLowHz'));
    });
  }
});

describe('the silence band is only judged when the device reads it', () => {
  // Hidden in the editor and omitted from the written config at a zero threshold, so
  // an issue raised about it would point at nothing the user can reach or change.
  const band = (silenceThreshold: number) => ({
    ...defaultConfig(),
    deviceLabel: 'TEST',
    phases: [
      {
        ...defaultPhase(),
        audioSampleRateHz: 16000,
        silenceThreshold,
        minFrequencyHz: 9000,
        maxFrequencyHz: 8000,
      },
    ],
  });
  const about = (config: ReturnType<typeof defaultConfig>) =>
    validateConfig(config, FIRMWARE_CURRENT).filter((issue) => /[Ff]requency/.test(issue.path));

  it('says nothing about an inverted band while silence detection is off', () => {
    assert.deepEqual(about(band(0)), []);
  });

  it('still catches it once a threshold is set', () => {
    assert.ok(about(band(0.2)).some((issue) => issue.severity === 'error'));
  });
});

describe('solar schedules are judged as their own kind of schedule', () => {
  const solarPhase = (overrides: Partial<PhaseConfig> = {}): PhaseConfig => ({
    ...defaultPhase(),
    audioRecordingMode: 'SCHEDULED',
    audioScheduleType: 'SOLAR',
    audioSolarWindows: [
      { startAnchor: 'DAWN', startOffsetSeconds: 0, endAnchor: 'SUNRISE', endOffsetSeconds: 5400 },
    ],
    audioTriggerTimes: [{ startSecond: 18000, endSecond: 25200 }],
    ...overrides,
  });

  const solarConfig = (phase: PhaseConfig, overrides: Partial<DeploymentConfig> = {}): DeploymentConfig => ({
    ...defaultConfig('Africa/Nairobi'),
    deviceLabel: 'SUN-01',
    latitude: -1.2921,
    longitude: 36.8219,
    phases: [phase],
    ...overrides,
  });

  const errorsFor = (config: DeploymentConfig) =>
    validateConfig(config, DEFAULT_FIRMWARE_PROFILE).filter((issue) => issue.severity === 'error');
  const warningsFor = (config: DeploymentConfig) =>
    validateConfig(config, DEFAULT_FIRMWARE_PROFILE).filter((issue) => issue.severity === 'warning');

  it('accepts a complete solar schedule', () => {
    assert.deepEqual(errorsFor(solarConfig(solarPhase())), []);
  });

  it('does not demand clock windows it no longer needs', () => {
    /*
      The regression this guards. Under a clock schedule an empty window list means recording
      nothing, and that is an error. Under a solar schedule the device computes the windows
      itself, so the same empty list is only a missing fallback — worth a warning about the
      specific risk, never an error telling someone to add windows they did not need.
    */
    const config = solarConfig(solarPhase({ audioTriggerTimes: [] }));
    assert.deepEqual(errorsFor(config), []);
    assert.ok(
      warningsFor(config).some((issue) => issue.path.endsWith('audioTriggerTimes')),
      'a solar schedule with no fallback should warn about the days it would record nothing',
    );
  });

  it('still demands clock windows under a clock schedule', () => {
    const config = solarConfig(solarPhase({ audioScheduleType: 'CLOCK', audioTriggerTimes: [] }));
    assert.ok(errorsFor(config).some((issue) => issue.path.endsWith('audioTriggerTimes')));
  });

  it('says nothing about solar windows under a clock schedule', () => {
    // The mirror of the case above: leftover solar windows are inert when the schedule type
    // is CLOCK, because serializeConfig never writes them, so complaining would be noise.
    const config = solarConfig(solarPhase({ audioScheduleType: 'CLOCK', audioSolarWindows: [] }));
    assert.deepEqual(errorsFor(config), []);
  });

  it('refuses a solar schedule with no position to compute from', () => {
    // Without one the device runs the fallback every single day, so the schedule chosen is
    // not the schedule that would run.
    const config = solarConfig(solarPhase(), { latitude: null, longitude: null });
    assert.ok(errorsFor(config).some((issue) => issue.path === 'latitude'));
  });

  it('refuses half a position, which the device reads as none', () => {
    const config = solarConfig(solarPhase(), { longitude: null });
    assert.ok(errorsFor(config).some((issue) => issue.path === 'longitude'));
  });

  it('refuses coordinates outside the range solar_position_valid() accepts', () => {
    assert.ok(errorsFor(solarConfig(solarPhase(), { latitude: 95 })).some((i) => i.path === 'latitude'));
    assert.ok(errorsFor(solarConfig(solarPhase(), { longitude: -181 })).some((i) => i.path === 'longitude'));
  });

  it('refuses an offset the firmware cannot store', () => {
    // runtime_config.c REFUSES an out-of-range offset rather than clamping it, so the whole
    // window would silently vanish on the device.
    const config = solarConfig(
      solarPhase({
        audioSolarWindows: [
          { startAnchor: 'DAWN', startOffsetSeconds: 40000, endAnchor: 'SUNRISE', endOffsetSeconds: 0 },
        ],
      }),
    );
    assert.ok(errorsFor(config).some((issue) => issue.path.endsWith('audioSolarWindows')));
  });

  it('refuses a solar schedule with no solar windows at all', () => {
    const config = solarConfig(solarPhase({ audioSolarWindows: [] }));
    assert.ok(errorsFor(config).some((issue) => issue.path.endsWith('audioSolarWindows')));
  });
});
