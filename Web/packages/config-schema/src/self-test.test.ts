import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSelfTestResults, summarizeSelfTest } from './self-test.js';

/** Exactly what the firmware's write_results() emits, key for key. */
const passing = [
  'FW_VERSION = "2026.08.1+71f599f"',
  'DEVICE_LABEL = "BEAR-04"',
  'TEST_TIMESTAMP = "1770368400"',
  'ACTIVATION_NUMBER = "3"',
  'OVERALL = "PASS"',
  'FAILED_SUBSYSTEM = "0"',
  'MIC_TYPE = "ANALOG"',
  'MIC_RESULT = "PASS"',
  'MIC_RMS = "412"',
  'MIC_PEAK = "2140"',
  'MIC_MIN = "-2140"',
  'MIC_MAX = "1980"',
  'MIC_MEAN = "1"',
  'MIC_SAMPLES = "320000"',
  'MIC_DC_OFFSET = "32320"',
  'MIC_CONSTANT_OUTPUT = "False"',
  'SD_RESULT = "PASS"',
  'SD_BYTES_VERIFIED = "4096"',
  'SD_FREE_MB = "118000"',
  'IMU_RESULT = "PASS"',
  'IMU_MAGNITUDE_MG = "981"',
  'BATTERY_MV = "3538"',
  'TEMPERATURE_C = "22.68"',
  'RTC_VALID = "True"',
  '',
].join('\n');

describe('parseSelfTestResults', () => {
  it('reads a passing result', () => {
    const results = parseSelfTestResults(passing)!;
    assert.equal(results.passed, true);
    assert.equal(results.failedSubsystem, 'NONE');
    assert.equal(results.testedAt, '2026-02-06T09:00:00.000Z');
    assert.equal(results.microphone.dcOffset, 32320);
    assert.equal(results.imu.magnitudeMg, 981);
    assert.equal(results.power.rtcValid, true);
  });

  it('names the failed subsystem from its code', () => {
    // The code doubles as the red-LED blink count, so the two must agree.
    const failed = passing
      .replace('OVERALL = "PASS"', 'OVERALL = "FAIL"')
      .replace('FAILED_SUBSYSTEM = "0"', 'FAILED_SUBSYSTEM = "1"')
      .replace('MIC_RESULT = "PASS"', 'MIC_RESULT = "FAIL"');
    const results = parseSelfTestResults(failed)!;
    assert.equal(results.passed, false);
    assert.equal(results.failedSubsystem, 'MICROPHONE');
    assert.match(summarizeSelfTest(results), /microphone wiring/);
  });

  it('distinguishes a silent pass from a plain pass', () => {
    // The electrical path worked but nothing was heard: expected on a quiet bench,
    // suspicious somewhere that should have ambient sound.
    const silent = passing.replace('MIC_RESULT = "PASS"', 'MIC_RESULT = "PASS_SILENT"');
    const results = parseSelfTestResults(silent)!;
    assert.equal(results.passed, true);
    assert.match(summarizeSelfTest(results), /heard nothing/);
  });

  it('flags a constant output, which means a dead signal path', () => {
    const dead = passing.replace('MIC_CONSTANT_OUTPUT = "False"', 'MIC_CONSTANT_OUTPUT = "True"');
    assert.equal(parseSelfTestResults(dead)!.microphone.constantOutput, true);
  });

  it('returns null for a file that is not a results file', () => {
    assert.equal(parseSelfTestResults('DEVICE_LABEL = "BEAR-04"\n'), null);
  });
});
