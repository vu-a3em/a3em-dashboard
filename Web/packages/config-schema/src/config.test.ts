import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultConfig, defaultPhase } from './defaults.js';
import { serializeConfig, ConfigLineTooLongError } from './serialize.js';
import { parseConfig, KEY_ORDER } from './parse.js';
import { validateConfig, isWritable } from './validate.js';
import { FIRMWARE_CURRENT, FIRMWARE_LEGACY } from './firmware-profile.js';
import {
  MAX_CFG_LINE_CONTENT_LENGTH,
  MAX_CFG_LINE_LENGTH,
  MAX_DEPLOYMENT_PHASES,
} from './firmware-constants.js';

describe('firmware key matching', () => {
  /**
   * runtime_config.c compares keys with memcmp against a PREFIX, in a fixed
   * if/else-if order. Any key that is a prefix of a later key would swallow it.
   * The firmware handles this today by hand-ordering two specific pairs; this
   * test makes the invariant explicit so a future key addition cannot break it
   * silently on device.
   */
  it('never places a key before another key it is a prefix of', () => {
    for (let i = 0; i < KEY_ORDER.length; i++) {
      for (let j = i + 1; j < KEY_ORDER.length; j++) {
        assert.ok(
          !KEY_ORDER[j].startsWith(KEY_ORDER[i]),
          `"${KEY_ORDER[i]}" (position ${i}) is a prefix of "${KEY_ORDER[j]}" (position ${j}), ` +
            `so the firmware would match the wrong key. Move the longer key first.`,
        );
      }
    }
  });

  it('keeps the two orderings the firmware depends on', () => {
    const at = (key: string) => KEY_ORDER.indexOf(key as (typeof KEY_ORDER)[number]);
    assert.ok(at('DEVICE_UTC_OFFSET_HOUR') < at('DEVICE_UTC_OFFSET'));
    assert.ok(at('AUDIO_TRIGGER_INTERVAL_TIME_SCALE') < at('AUDIO_TRIGGER_INTERVAL'));
  });
});

describe('serializeConfig', () => {
  it('emits the deployment window before the first [PHASE]', () => {
    // parse_line() seeds each phase's times from the already-parsed deployment
    // span, so a [PHASE] appearing first would inherit zeroes.
    const text = serializeConfig(defaultConfig('America/Chicago'));
    const lines = text.split('\n');
    assert.ok(
      lines.findIndex((l) => l.startsWith('DEPLOYMENT_END_TIME')) <
        lines.findIndex((l) => l === '[PHASE]'),
    );
  });

  it('ends with a newline', () => {
    // storage_read_line() returns -1 for an unterminated final line and the
    // caller's loop stops, discarding it.
    assert.ok(serializeConfig(defaultConfig()).endsWith('\n'));
  });

  it('keeps every line within the firmware read buffer', () => {
    const config = defaultConfig('America/Argentina/ComodRivadavia');
    config.deviceLabel = 'ABCDEFGHIJKLMNO'; // 15 chars, the product maximum
    for (const line of serializeConfig(config).split('\n')) {
      assert.ok(
        line.length <= MAX_CFG_LINE_CONTENT_LENGTH,
        `"${line}" is ${line.length} bytes, over the ${MAX_CFG_LINE_CONTENT_LENGTH} the device reads`,
      );
    }
  });

  it('refuses to emit an over-long line rather than truncating a deployment', () => {
    const config = defaultConfig('UTC');
    config.phases[0].name = 'x'.repeat(200);
    assert.throws(() => serializeConfig(config), ConfigLineTooLongError);
  });

  it('counts the newline the reader has to find inside its own buffer', () => {
    // storage_read_line() reads MAX_CFG_FILE_LINE_LENGTH bytes and then searches THOSE bytes
    // for '\n'. A line of exactly that length puts its newline one past the end of the read,
    // so the scan fails, the caller's loop stops, and every phase after this one is lost.
    // 79 characters is the real ceiling, and the boundary is worth pinning because the
    // off-by-one is invisible: the file looks correct and the device just ignores most of it.
    const lineFor = (nameLength: number) => {
      const config = defaultConfig('UTC');
      config.phases[0].name = 'x'.repeat(nameLength);
      return serializeConfig(config)
        .split('\n')
        .find((line) => line.startsWith('PHASE_NAME'))!;
    };
    assert.equal(lineFor(MAX_CFG_LINE_CONTENT_LENGTH - 'PHASE_NAME = ""'.length).length, 79);
    assert.throws(
      () => lineFor(MAX_CFG_LINE_CONTENT_LENGTH - 'PHASE_NAME = ""'.length + 1),
      ConfigLineTooLongError,
      'an 80-byte line must be refused, not emitted',
    );
  });

  it('writes phases in ascending start-time order', () => {
    // config_get_active_deployment_phase_index() returns the first window that
    // contains the current time, so out-of-order phases misbehave.
    const config = defaultConfig('UTC');
    config.isPhased = true;
    const base = Date.parse(config.startTime);
    const day = 86400_000;
    config.phases = [
      { ...defaultPhase('Late'), startTime: new Date(base + 8 * day).toISOString(), endTime: new Date(base + 12 * day).toISOString() },
      { ...defaultPhase('Early'), startTime: new Date(base).toISOString(), endTime: new Date(base + 4 * day).toISOString() },
    ];
    const names = serializeConfig(config)
      .split('\n')
      .filter((l) => l.startsWith('PHASE_NAME'));
    assert.match(names[0], /"Early"/);
    assert.match(names[1], /"Late"/);
  });

  it('writes the sample rate the device will actually use under Opus', () => {
    // runtime_config.c overrides the rate to 48 kHz whenever USE_OPUS is True.
    const config = defaultConfig('UTC');
    config.phases[0].useOpusEncoding = true;
    config.phases[0].audioSampleRateHz = 16000;
    assert.match(serializeConfig(config), /AUDIO_SAMPLING_RATE_HZ = "48000"/);
  });

  it('clamps the frequency ceiling the way the device does', () => {
    // Firmware forces max_frequency to (rate / 2) - 200. The band of interest is only written
    // when a silence threshold makes the device read it, so one has to be set here.
    const config = defaultConfig('UTC');
    config.phases[0].audioSampleRateHz = 48000;
    config.phases[0].maxFrequencyHz = 24000;
    config.phases[0].silenceThreshold = 0.2;
    assert.match(serializeConfig(config), /MAX_FREQUENCY = "23800"/);
  });
});

describe('round trip', () => {
  it('preserves a single-phase deployment', () => {
    const original = defaultConfig('America/Chicago');
    original.deviceLabel = 'BEAR-04';
    original.phases[0].audioRecordingMode = 'INTERVAL';
    original.phases[0].audioTriggerInterval = 15;
    original.phases[0].audioTriggerIntervalTimeScale = 'MINUTES';

    const { config, warnings } = parseConfig(serializeConfig(original), 'America/Chicago');
    assert.deepEqual(warnings, []);
    assert.equal(config.deviceLabel, 'BEAR-04');
    assert.equal(config.startTime, original.startTime);
    assert.equal(config.endTime, original.endTime);
    assert.equal(config.phases[0].audioRecordingMode, 'INTERVAL');
    assert.equal(config.phases[0].audioTriggerInterval, 15);
    assert.equal(config.phases[0].audioTriggerIntervalTimeScale, 'MINUTES');
  });

  it('preserves listening windows and phase names', () => {
    const original = defaultConfig('UTC');
    original.deviceLabel = 'DAWN-01';
    original.phases[0].name = 'Dawn chorus';
    original.phases[0].audioRecordingMode = 'SCHEDULED';
    original.phases[0].audioTriggerTimes = [
      { startSecond: 16200, endSecond: 27000 },
      { startSecond: 64800, endSecond: 79200 },
    ];

    const { config } = parseConfig(serializeConfig(original));
    assert.equal(config.phases[0].name, 'Dawn chorus');
    assert.deepEqual(config.phases[0].audioTriggerTimes, original.phases[0].audioTriggerTimes);
  });

  it('preserves a phased deployment and its ordering', () => {
    const original = defaultConfig('UTC');
    original.deviceLabel = 'PHASED';
    original.isPhased = true;
    const base = Date.parse(original.startTime);
    const day = 86400_000;
    original.phases = [
      { ...defaultPhase('One'), startTime: new Date(base).toISOString(), endTime: new Date(base + 3 * day).toISOString() },
      { ...defaultPhase('Two'), startTime: new Date(base + 3 * day).toISOString(), endTime: new Date(base + 9 * day).toISOString() },
    ];

    const { config } = parseConfig(serializeConfig(original));
    assert.equal(config.isPhased, true);
    assert.equal(config.phases.length, 2);
    assert.equal(config.phases[0].name, 'One');
    assert.equal(config.phases[1].startTime, original.phases[1].startTime);
  });
});

describe('parseConfig — reading what the device would read', () => {
  it('stops at an over-long line, as the device does', () => {
    const text =
      'DEVICE_LABEL = "OK"\n' +
      `COMMENT = "${'x'.repeat(MAX_CFG_LINE_LENGTH)}"\n` +
      'AWAKE_ON_MAGNET = "False"\n';
    const { config, warnings } = parseConfig(text);
    assert.match(warnings[0], /stops reading here/);
    assert.equal(config.awakeOnMagnet, true, 'the line past the long one must not be applied');
  });

  it('warns when the file has no trailing newline', () => {
    const { warnings } = parseConfig('DEVICE_LABEL = "A"\nAWAKE_ON_MAGNET = "False"');
    assert.match(warnings.join(' '), /does not end with a newline/);
  });

  it('flags a phase count the device cannot hold', () => {
    let text = 'DEPLOYMENT_START_TIME = "0"\nDEPLOYMENT_END_TIME = "100"\nPHASED_DEPLOYMENT = "True"\n';
    for (let i = 0; i <= MAX_DEPLOYMENT_PHASES; i++) {
      text += `\n[PHASE]\nPHASE_NAME = "P${i}"\n`;
    }
    const { warnings } = parseConfig(text);
    assert.match(warnings.join(' '), /writes past the end of its phase array/);
  });

  it('coerces unknown enum values the way the firmware does', () => {
    const text =
      'DEPLOYMENT_START_TIME = "0"\nDEPLOYMENT_END_TIME = "100"\n\n[PHASE]\n' +
      'AUDIO_RECORDING_MODE = "NONSENSE"\nIMU_RECORDING_MODE = "NONSENSE"\n' +
      'AUDIO_MAX_CLIPS_TIME_SCALE = "NONSENSE"\n';
    const { config } = parseConfig(text);
    assert.equal(config.phases[0].audioRecordingMode, 'CONTINUOUS');
    assert.equal(config.phases[0].imuRecordingMode, 'NONE');
    assert.equal(config.phases[0].maxClipsTimeScale, 'MINUTES');
  });
});

describe('validateConfig', () => {
  const valid = () => {
    const config = defaultConfig('UTC');
    config.deviceLabel = 'BEAR-04';
    return config;
  };

  it('accepts a sensible default deployment', () => {
    assert.deepEqual(validateConfig(valid()), []);
    assert.ok(isWritable(valid()));
  });

  it('blocks a zero clip cap on legacy firmware', () => {
    // On legacy units the device records nothing at all in this state.
    const config = valid();
    config.phases[0].audioRecordingMode = 'AMPLITUDE';
    config.phases[0].maxAudioClips = 0;
    const issue = validateConfig(config, FIRMWARE_LEGACY).find((i) =>
      i.path.endsWith('maxAudioClips'),
    );
    assert.equal(issue?.severity, 'error');
    assert.match(issue!.message, /stops the device recording altogether/);
    assert.ok(issue!.fix, 'the error should offer a one-click remedy');
  });

  it('refuses a zero clip cap on current firmware, which rewrites it to one', () => {
    // Zero has meant three different things across three builds, and none of them is
    // what someone writing zero intends. Current firmware silently rewrites it to a
    // single clip per window and flags the file as corrected, so the editor never
    // writes it in the first place.
    const config = valid();
    config.phases[0].audioRecordingMode = 'AMPLITUDE';
    config.phases[0].maxAudioClips = 0;
    const issue = validateConfig(config, FIRMWARE_CURRENT).find((i) =>
      i.path.endsWith('maxAudioClips'),
    );
    assert.equal(issue?.severity, 'error');
    assert.match(issue!.message, /rewritten to a single clip/);
    assert.ok(issue!.fix, 'the error should offer a one-click remedy');
    assert.ok(!isWritable(config, FIRMWARE_CURRENT));
  });

  it('refuses it by default too, since that is the firmware every device runs', () => {
    const config = valid();
    config.phases[0].audioRecordingMode = 'AMPLITUDE';
    config.phases[0].maxAudioClips = 0;
    assert.ok(!isWritable(config));
  });

  it('rejects a deployment running past the 32-bit time_t rollover', () => {
    const config = valid();
    config.endTime = new Date('2039-01-01T00:00:00Z').toISOString();
    assert.ok(
      validateConfig(config).some((i) => i.severity === 'error' && /2038/.test(i.message)),
    );
  });

  it('rejects a trigger level the digipot cannot produce', () => {
    const config = valid();
    config.phases[0].audioRecordingMode = 'AMPLITUDE';
    config.phases[0].audioTriggerThreshold = 0.001; // truncates to wiper 0
    const issue = validateConfig(config).find((i) => i.path.endsWith('audioTriggerThreshold'));
    assert.equal(issue?.severity, 'error');
    assert.match(issue!.message, /cannot be set on the hardware/);
  });

  it('says nothing about ordinary digipot quantization', () => {
    // Every stored value quantizes; reporting it would be constant noise. The
    // threshold control surfaces the effective level instead.
    const config = valid();
    config.phases[0].audioRecordingMode = 'AMPLITUDE';
    config.phases[0].audioTriggerThreshold = 0.3; // not a multiple of 1/255
    assert.deepEqual(
      validateConfig(config).filter((i) => i.path.endsWith('audioTriggerThreshold')),
      [],
    );
  });

  it('blocks sound-triggered recording on a digital microphone', () => {
    const config = valid();
    config.micType = 'DIGITAL';
    config.phases[0].audioRecordingMode = 'AMPLITUDE';
    assert.ok(
      validateConfig(config).some(
        (i) => i.severity === 'error' && /analog microphone/.test(i.message),
      ),
    );
  });

  it('blocks more phases than the device can hold', () => {
    const config = valid();
    config.isPhased = true;
    config.phases = Array.from({ length: MAX_DEPLOYMENT_PHASES + 1 }, (_, i) => ({
      ...defaultPhase(`P${i}`),
      startTime: new Date(Date.parse(config.startTime) + i * 86400_000).toISOString(),
      endTime: new Date(Date.parse(config.startTime) + (i + 1) * 86400_000).toISOString(),
    }));
    assert.ok(
      validateConfig(config).some((i) => i.severity === 'error' && /at most 6 phases/.test(i.message)),
    );
  });

  it('blocks a clip longer than its own interval', () => {
    const config = valid();
    config.phases[0].audioRecordingMode = 'INTERVAL';
    config.phases[0].audioClipLengthSeconds = 120;
    config.phases[0].audioTriggerInterval = 1;
    config.phases[0].audioTriggerIntervalTimeScale = 'MINUTES';
    assert.ok(validateConfig(config).some((i) => i.severity === 'error' && /does not fit/.test(i.message)));
  });

  it('accepts a motion threshold, which current firmware applies', () => {
    const config = valid();
    config.phases[0].imuRecordingMode = 'ACTIVITY';
    assert.deepEqual(
      validateConfig(config).filter((i) => i.path.endsWith('imuTriggerThresholdMg')),
      [],
    );
  });

  it('warns rather than blocks when reading a card from firmware that ignored it', () => {
    const config = valid();
    config.phases[0].imuRecordingMode = 'ACTIVITY';
    const issue = validateConfig(config, FIRMWARE_LEGACY).find((i) =>
      i.path.endsWith('imuTriggerThresholdMg'),
    );
    assert.equal(issue?.severity, 'warning');
    assert.ok(isWritable(config, FIRMWARE_LEGACY));
  });

  it('rejects a label that cannot be a folder name', () => {
    const config = valid();
    config.deviceLabel = 'BEAR/04';
    assert.ok(validateConfig(config).some((i) => i.path === 'deviceLabel' && i.severity === 'error'));
  });

  it('warns about a gap between phases', () => {
    const config = valid();
    config.isPhased = true;
    const base = Date.parse(config.startTime);
    const day = 86400_000;
    config.phases = [
      { ...defaultPhase('A'), startTime: new Date(base).toISOString(), endTime: new Date(base + day).toISOString() },
      { ...defaultPhase('B'), startTime: new Date(base + 3 * day).toISOString(), endTime: new Date(base + 4 * day).toISOString() },
    ];
    assert.ok(validateConfig(config).some((i) => /gap before phase/.test(i.message)));
  });


  describe('sample rates the hardware cannot produce exactly', () => {
    // The firmware labels files with the rate it achieved, so nothing is mislabelled --
    // but the label will not be the number that was asked for, and finding that out after
    // a field season is worse than being told before the card is written.
    const withRate = (rate: number, micType: 'ANALOG' | 'DIGITAL') => {
      const config = valid();
      config.micType = micType;
      config.phases[0].audioSampleRateHz = rate;
      return validateConfig(config).find((i) => i.path.endsWith('audioSampleRateHz'));
    };

    it('warns that an analog microphone cannot produce 8 kHz exactly', () => {
      const issue = withRate(8000, 'ANALOG');
      assert.equal(issue?.severity, 'warning');
      assert.match(issue!.message, /7994 Hz/);
      assert.match(issue!.message, /slow/);
    });

    it('warns that a digital microphone cannot produce 32 kHz exactly', () => {
      const issue = withRate(32000, 'DIGITAL');
      assert.equal(issue?.severity, 'warning');
      assert.match(issue!.message, /31914 Hz/);
      assert.match(issue!.message, /slow/);
    });

    it('says nothing when the chosen microphone can hit the rate', () => {
      assert.equal(withRate(8000, 'DIGITAL'), undefined);
      assert.equal(withRate(32000, 'ANALOG'), undefined);
      assert.equal(withRate(48000, 'ANALOG'), undefined);
    });

    it('never blocks writing over it, since the recording is still correctly labelled', () => {
      const config = valid();
      config.micType = 'ANALOG';
      config.phases[0].audioSampleRateHz = 8000;
      assert.ok(isWritable(config));
    });
  });

});
