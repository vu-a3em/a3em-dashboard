import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultConfig, defaultPhase } from './defaults.js';
import {
  summarizeAudio,
  summarizeDevice,
  summarizeFilter,
  summarizeMotion,
  summarizePhases,
  summarizeReadiness,
  summarizeSchedule,
  summarizeSilence,
} from './summaries.js';

/**
 * A collapsed pane shows only its summary, so a summary that says the wrong thing is
 * worse than none at all — it is read instead of opening the pane, not before it.
 */
describe('pane summaries', () => {
  it('names the device by its label, microphone and gain', () => {
    const config = defaultConfig('UTC');
    config.deviceLabel = 'BEAR-04';
    config.micType = 'DIGITAL';
    config.micAmplificationDb = 1.5;
    config.batteryLowMv = 3250;
    assert.equal(summarizeDevice(config), 'BEAR-04 · digital mic at 1.5 dB · cutoff 3.25 V');
  });

  it('leaves the cutoff out when the device records to exhaustion', () => {
    // Zero is not a cutoff of nothing, it is no cutoff at all, and "0.00 V" reads as the
    // former. The pane's help text is where that distinction belongs.
    const config = defaultConfig('UTC');
    config.deviceLabel = 'BEAR-04';
    config.batteryLowMv = 0;
    assert.doesNotMatch(summarizeDevice(config), /cutoff/);
  });

  it('says so rather than showing an empty label', () => {
    const config = defaultConfig('UTC');
    config.deviceLabel = '   ';
    assert.match(summarizeDevice(config), /^No label · /);
  });

  it('reduces the dates to a length', () => {
    const config = defaultConfig('America/Chicago');
    config.startTime = '2026-01-01T00:00:00.000Z';
    config.endTime = '2026-01-15T00:00:00.000Z';
    assert.equal(summarizeSchedule(config), '14 days · America/Chicago');
  });

  it('counts phases only when the deployment uses them', () => {
    const config = defaultConfig('UTC');
    assert.equal(summarizePhases(config), 'Single phase');
    config.isPhased = true;
    config.phases = [defaultPhase(), defaultPhase(), defaultPhase()];
    assert.equal(summarizePhases(config), '3 phases');
  });

  it('gives the audio mode, rate and clip length, and flags Opus', () => {
    const phase = { ...defaultPhase(), audioRecordingMode: 'CONTINUOUS' as const, audioSampleRateHz: 16000, audioClipLengthSeconds: 10 };
    assert.equal(summarizeAudio(phase), 'Continuous · 16 kHz · 10 s clips');
    assert.equal(summarizeAudio({ ...phase, useOpusEncoding: true }), 'Continuous · 16 kHz · 10 s clips · Opus');
  });

  it('drops the motion rate when motion recording is off', () => {
    const phase = defaultPhase();
    assert.equal(summarizeMotion({ ...phase, imuRecordingMode: 'NONE' }), 'Disabled');
    assert.equal(
      summarizeMotion({ ...phase, imuRecordingMode: 'AUDIO', imuSampleRateHz: 50 }),
      'Synchronized with audio · 50 Hz',
    );
  });

  it('names only the corners the filter type actually uses', () => {
    const phase = { ...defaultPhase(), audioFilterLowHz: 350, audioFilterHighHz: 7800 };
    assert.equal(summarizeFilter({ ...phase, audioFilterType: 'NONE' }), 'No filtering');
    assert.equal(summarizeFilter({ ...phase, audioFilterType: 'HIGH' }), 'High-pass 350 Hz');
    assert.equal(summarizeFilter({ ...phase, audioFilterType: 'LOW' }), 'Low-pass 7.8 kHz');
    assert.equal(summarizeFilter({ ...phase, audioFilterType: 'BAND' }), 'Band 350 Hz – 7.8 kHz');
  });

  it('leaves the silence band out while the threshold is zero', () => {
    // The pane hides the band there, so naming it would describe a control that is not
    // on screen and a setting the device never reads.
    const phase = { ...defaultPhase(), minFrequencyHz: 300, maxFrequencyHz: 7800 };
    assert.equal(summarizeSilence({ ...phase, silenceThreshold: 0 }), 'Off');
    assert.equal(summarizeSilence({ ...phase, silenceThreshold: 0.2 }), '20% · 300 Hz – 7.8 kHz');
  });

  it('puts errors before warnings and says when there are neither', () => {
    assert.equal(summarizeReadiness({ errors: 0, warnings: 0 }), 'Ready to write');
    assert.equal(summarizeReadiness({ errors: 0, warnings: 1 }), '1 warning');
    assert.equal(summarizeReadiness({ errors: 2, warnings: 0 }), '2 errors');
    assert.equal(summarizeReadiness({ errors: 1, warnings: 3 }), '1 error · 3 warnings');
  });
});
