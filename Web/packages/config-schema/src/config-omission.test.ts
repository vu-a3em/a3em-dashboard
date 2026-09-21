import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultConfig } from './defaults.js';
import { serializeConfig } from './serialize.js';
import { parseConfig } from './parse.js';
import { STARTER_PROTOCOLS, applyProtocol } from './protocol.js';
import type { DeploymentConfig } from './types.js';

/**
 * The written config should show only what the device will actually read.
 *
 * Every omission here was checked against the firmware source, and the note on each test names
 * the code that ignores the setting. The point is not brevity for its own sake: a config file
 * that lists a filter cutoff beside `FILTER_TYPE = "NONE"` invites someone to believe the cutoff
 * is doing something.
 *
 * A setting is only omitted when the device IGNORES it — never merely because it matches a
 * default. The firmware's own defaults are not the dashboard's (runtime_config.c starts from
 * LEDs off and an analog microphone), so leaving a line out to mean "use the default" would
 * quietly change the deployment.
 */

const has = (text: string, key: string) => new RegExp(`^${key} = `, 'm').test(text);

function phaseConfig(overrides: Partial<DeploymentConfig['phases'][number]>): DeploymentConfig {
  const config = defaultConfig('UTC');
  config.deviceLabel = 'A3EM';
  config.phases[0] = { ...config.phases[0]!, ...overrides };
  return config;
}

describe('the written config omits what the firmware ignores', () => {
  it('drops both filter corners when no filter is applied', () => {
    // audio_filter.c `audio_filter_initialize()` returns immediately on FILTER_NONE.
    const text = serializeConfig(phaseConfig({ audioFilterType: 'NONE' }));
    assert.ok(has(text, 'FILTER_TYPE'));
    assert.ok(!has(text, 'FILTER_LOW_FREQUENCY'));
    assert.ok(!has(text, 'FILTER_HIGH_FREQUENCY'));
  });

  it('writes only the corner each filter shape actually uses', () => {
    // A high-pass is designed from the low corner, a low-pass from the high corner.
    const high = serializeConfig(phaseConfig({ audioFilterType: 'HIGH' }));
    assert.ok(has(high, 'FILTER_LOW_FREQUENCY') && !has(high, 'FILTER_HIGH_FREQUENCY'));

    const low = serializeConfig(phaseConfig({ audioFilterType: 'LOW' }));
    assert.ok(has(low, 'FILTER_HIGH_FREQUENCY') && !has(low, 'FILTER_LOW_FREQUENCY'));

    const band = serializeConfig(phaseConfig({ audioFilterType: 'BAND' }));
    assert.ok(has(band, 'FILTER_LOW_FREQUENCY') && has(band, 'FILTER_HIGH_FREQUENCY'));
  });

  it('writes only the trigger settings the chosen recording mode reads', () => {
    // active_main.c switches on the mode and consults one arm's settings only.
    const amplitude = serializeConfig(phaseConfig({ audioRecordingMode: 'AMPLITUDE' }));
    assert.ok(has(amplitude, 'AUDIO_TRIGGER_THRESHOLD'));
    assert.ok(has(amplitude, 'AUDIO_MAX_CLIPS_NUMBER'));
    assert.ok(!has(amplitude, 'AUDIO_TRIGGER_INTERVAL'));

    const interval = serializeConfig(phaseConfig({ audioRecordingMode: 'INTERVAL' }));
    assert.ok(has(interval, 'AUDIO_TRIGGER_INTERVAL'));
    assert.ok(!has(interval, 'AUDIO_TRIGGER_THRESHOLD'));
    assert.ok(!has(interval, 'AUDIO_MAX_CLIPS_NUMBER'));

    const continuous = serializeConfig(phaseConfig({ audioRecordingMode: 'CONTINUOUS' }));
    for (const key of [
      'AUDIO_TRIGGER_THRESHOLD',
      'AUDIO_TRIGGER_INTERVAL',
      'AUDIO_MAX_CLIPS_NUMBER',
      'AUDIO_EXTEND_CLIP',
      'AUDIO_TRIGGER_SCHEDULE',
    ]) {
      assert.ok(!has(continuous, key), `CONTINUOUS should not write ${key}`);
    }
  });

  it('writes listening windows only in scheduled mode', () => {
    const windows = [{ startSecond: 3600, endSecond: 7200 }];
    const scheduled = serializeConfig(
      phaseConfig({ audioRecordingMode: 'SCHEDULED', audioTriggerTimes: windows }),
    );
    assert.ok(has(scheduled, 'AUDIO_TRIGGER_SCHEDULE'));

    const continuous = serializeConfig(
      phaseConfig({ audioRecordingMode: 'CONTINUOUS', audioTriggerTimes: windows }),
    );
    assert.ok(!has(continuous, 'AUDIO_TRIGGER_SCHEDULE'));
  });

  it('drops the motion settings when motion is not recorded', () => {
    const off = serializeConfig(phaseConfig({ imuRecordingMode: 'NONE' }));
    assert.ok(has(off, 'IMU_RECORDING_MODE'));
    for (const key of ['IMU_SAMPLING_RATE_HZ', 'IMU_DEGREES_OF_FREEDOM', 'IMU_TRIGGER_THRESHOLD']) {
      assert.ok(!has(off, key), `IMU off should not write ${key}`);
    }
  });

  it('writes the motion threshold only for motion-triggered recording', () => {
    const activity = serializeConfig(phaseConfig({ imuRecordingMode: 'ACTIVITY' }));
    assert.ok(has(activity, 'IMU_TRIGGER_THRESHOLD'));

    const synced = serializeConfig(phaseConfig({ imuRecordingMode: 'AUDIO' }));
    assert.ok(has(synced, 'IMU_SAMPLING_RATE_HZ'));
    assert.ok(!has(synced, 'IMU_TRIGGER_THRESHOLD'));
  });

  it('drops the band of interest when no silence threshold is set', () => {
    // active_main.c reads the band only inside `if (use_silence_filter)`.
    const off = serializeConfig(phaseConfig({ silenceThreshold: 0 }));
    assert.ok(has(off, 'SILENCE_THRESHOLD'));
    assert.ok(!has(off, 'MIN_FREQUENCY') && !has(off, 'MAX_FREQUENCY'));

    const on = serializeConfig(phaseConfig({ silenceThreshold: 0.2 }));
    assert.ok(has(on, 'MIN_FREQUENCY') && has(on, 'MAX_FREQUENCY'));
  });

  it('drops the Opus bitrate when recording WAV', () => {
    const wav = serializeConfig(phaseConfig({ useOpusEncoding: false }));
    assert.ok(has(wav, 'USE_OPUS') && !has(wav, 'OPUS_BITRATE'));

    const opus = serializeConfig(phaseConfig({ useOpusEncoding: true }));
    assert.ok(has(opus, 'OPUS_BITRATE'));
  });

  it('drops the LED duration when the LEDs are off', () => {
    const config = defaultConfig('UTC');
    config.deviceLabel = 'A3EM';
    const off = serializeConfig({ ...config, ledsEnabled: false });
    assert.ok(has(off, 'LEDS_ENABLED') && !has(off, 'LEDS_ACTIVE_SECONDS'));

    const on = serializeConfig({ ...config, ledsEnabled: true });
    assert.ok(has(on, 'LEDS_ACTIVE_SECONDS'));
  });

  it('drops the beacon start time when the beacon never runs', () => {
    // main.c gates on `vhf_enable_timestamp && now >= vhf_enable_timestamp`; the default is 0.
    const config = defaultConfig('UTC');
    config.deviceLabel = 'A3EM';
    const never = serializeConfig({ ...config, vhfMode: 'NEVER' });
    assert.ok(has(never, 'VHF_MODE') && !has(never, 'VHF_RADIO_START_TIME'));

    const atEnd = serializeConfig({ ...config, vhfMode: 'END' });
    assert.ok(has(atEnd, 'VHF_RADIO_START_TIME'));
  });

  it('keeps every setting the device always reads', () => {
    // These have no condition attached and must survive whatever else is switched off.
    const text = serializeConfig(
      phaseConfig({
        audioRecordingMode: 'CONTINUOUS',
        imuRecordingMode: 'NONE',
        audioFilterType: 'NONE',
        useOpusEncoding: false,
        silenceThreshold: 0,
      }),
    );
    for (const key of [
      'DEVICE_LABEL',
      'DEPLOYMENT_START_TIME',
      'DEPLOYMENT_END_TIME',
      'MIC_TYPE',
      'MIC_AMPLIFICATION',
      'BATTERY_LOW_MV',
      'MAGNET_FIELD_VALIDATION_MS',
      'AUDIO_RECORDING_MODE',
      'AUDIO_SAMPLING_RATE_HZ',
      'AUDIO_CLIP_LENGTH_SECONDS',
      'IMU_RECORDING_MODE',
      'FILTER_TYPE',
      'SILENCE_THRESHOLD',
      'USE_OPUS',
    ]) {
      assert.ok(has(text, key), `${key} must always be written`);
    }
  });

  it('still round-trips everything it writes', () => {
    const original = phaseConfig({
      audioRecordingMode: 'INTERVAL',
      imuRecordingMode: 'ACTIVITY',
      audioFilterType: 'BAND',
      useOpusEncoding: true,
      silenceThreshold: 0.3,
    });
    const reread = parseConfig(serializeConfig(original)).config;
    assert.equal(reread.phases[0]!.audioTriggerInterval, original.phases[0]!.audioTriggerInterval);
    assert.equal(reread.phases[0]!.imuTriggerThresholdMg, original.phases[0]!.imuTriggerThresholdMg);
    assert.equal(reread.phases[0]!.audioFilterLowHz, original.phases[0]!.audioFilterLowHz);
    assert.equal(reread.phases[0]!.opusBitrate, original.phases[0]!.opusBitrate);
    assert.equal(reread.batteryLowMv, original.batteryLowMv);
  });
});

describe('the microphone type is never left to the device', () => {
  /**
   * runtime_config.c:429 resets `microphone_type = MIC_ANALOG` before parsing, so an
   * absent MIC_TYPE does not mean "whatever the dashboard showed" — it means ANALOG.
   * Since a new deployment now starts DIGITAL, omitting the line would silently run the
   * deployment on the other microphone, and every recording would come from hardware the
   * user did not choose. It is written unconditionally and must stay that way.
   */
  it('writes MIC_TYPE for either microphone', () => {
    for (const micType of ['ANALOG', 'DIGITAL'] as const) {
      const text = serializeConfig({ ...defaultConfig(), deviceLabel: 'TEST', micType });
      assert.ok(has(text, 'MIC_TYPE'), `MIC_TYPE missing for ${micType}`);
      assert.match(text, new RegExp(`^MIC_TYPE = "${micType}"$`, 'm'));
    }
  });

  it('writes MIC_TYPE for every starter protocol', () => {
    for (const protocol of STARTER_PROTOCOLS) {
      const config = applyProtocol({ ...defaultConfig(), deviceLabel: 'TEST' }, protocol);
      const text = serializeConfig(config);
      assert.ok(has(text, 'MIC_TYPE'), `${protocol.name} wrote no MIC_TYPE`);
      assert.match(text, new RegExp(`^MIC_TYPE = "${config.micType}"$`, 'm'));
    }
  });

  it('round-trips the microphone rather than falling back', () => {
    for (const micType of ['ANALOG', 'DIGITAL'] as const) {
      const written = serializeConfig({ ...defaultConfig(), deviceLabel: 'TEST', micType });
      assert.equal(parseConfig(written).config?.micType, micType);
    }
  });
});
