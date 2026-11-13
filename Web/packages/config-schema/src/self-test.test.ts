import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSelfTestResults, powerCheckVerdict, summarizeSelfTest } from './self-test.js';

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
  'POWER_SOURCE = "BATTERY"',
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

  it('reads the battery when the device ran from it', () => {
    const results = parseSelfTestResults(passing)!;
    assert.equal(results.power.source, 'BATTERY');
    assert.equal(results.power.batteryMv, 3538);
  });

  it('has no battery reading on external power', () => {
    // The battery is not measured then, and the 0 written in its place is not a voltage.
    const external = passing
      .replace('POWER_SOURCE = "BATTERY"', 'POWER_SOURCE = "EXTERNAL"')
      .replace('BATTERY_MV = "3538"', 'BATTERY_MV = "0"');
    const results = parseSelfTestResults(external)!;
    assert.equal(results.power.source, 'EXTERNAL');
    assert.equal(results.power.batteryMv, null);
  });

  it('returns null for a file that is not a results file', () => {
    assert.equal(parseSelfTestResults('DEVICE_LABEL = "BEAR-04"\n'), null);
  });
});

describe('the power and clock verdict', () => {
  const failedOn = (code: number, text = passing) =>
    text.replace('OVERALL = "PASS"', 'OVERALL = "FAIL"').replace('FAILED_SUBSYSTEM = "0"', `FAILED_SUBSYSTEM = "${code}"`);
  const verdict = (text: string) => powerCheckVerdict(parseSelfTestResults(text)!);
  const external = passing
    .replace('POWER_SOURCE = "BATTERY"', 'POWER_SOURCE = "EXTERNAL"')
    .replace('BATTERY_MV = "3538"', 'BATTERY_MV = "0"');

  it('passes when the whole test passed, on either supply', () => {
    assert.deepEqual(verdict(passing), { result: 'PASS', problems: [] });
    assert.deepEqual(verdict(external), { result: 'PASS', problems: [] });
  });

  it('fails when power is the subsystem named, and says which reading', () => {
    const low = failedOn(4, passing.replace('BATTERY_MV = "3538"', 'BATTERY_MV = "2300"'));
    const result = verdict(low);
    assert.equal(result.result, 'FAIL');
    assert.deepEqual(result.problems, ['the battery read 2.30 V, outside the 2.5–5 V the test accepts']);
  });

  it('puts a power failure with both readings in range down to the clock', () => {
    assert.deepEqual(verdict(failedOn(4)), { result: 'FAIL', problems: ['the clock did not advance during the test'] });
  });

  it('does not claim a pass the file never recorded', () => {
    // A microphone failure is named first, so the power verdict is not in the file.
    assert.deepEqual(verdict(failedOn(1)), { result: null, problems: [] });
  });

  it('still proves a failure behind an earlier one from the readings', () => {
    const unmeasured = failedOn(1, passing.replace('BATTERY_MV = "3538"', 'BATTERY_MV = "0"'));
    assert.deepEqual(verdict(unmeasured), { result: 'FAIL', problems: ['the battery could not be measured'] });
    const hot = failedOn(1, passing.replace('TEMPERATURE_C = "22.68"', 'TEMPERATURE_C = "91.20"'));
    assert.equal(verdict(hot).result, 'FAIL');
  });

  it('does not judge the battery on external power', () => {
    assert.deepEqual(verdict(failedOn(1, external)), { result: null, problems: [] });
  });
});
