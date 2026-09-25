import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultConfig } from './defaults.js';
import { serializeConfig } from './serialize.js';
import { parseConfig } from './parse.js';
import { validateConfig } from './validate.js';
import {
  BATTERY_CUTOFF_ADVISED_MIN_MV,
  BATTERY_CUTOFF_MAX_MV,
  BATTERY_CUTOFF_MIN_MV,
  BATTERY_DEFAULT_LOW_MV,
} from './firmware-constants.js';

// A label is given because the bare default has none, which is a blocking error of its own
// and would mask what these tests are actually asking about.
const withCutoff = (batteryLowMv: number) => ({ ...defaultConfig(), deviceLabel: 'A3EM', batteryLowMv });
const issuesFor = (batteryLowMv: number) =>
  validateConfig(withCutoff(batteryLowMv)).filter((issue) => issue.path === 'batteryLowMv');

describe('the low-battery cutoff', () => {
  it('defaults to 0, disabled, and raises nothing about it', () => {
    assert.equal(defaultConfig().batteryLowMv, 0);
    assert.deepEqual(issuesFor(0), []);
    assert.deepEqual(issuesFor(BATTERY_DEFAULT_LOW_MV), []);
  });

  it('reads a card that leaves the cutoff out as the firmware’s own default, which is what the card runs', () => {
    const text = serializeConfig(withCutoff(3400)).replace(/^BATTERY_LOW_MV = .*\n/m, '');
    assert.equal(parseConfig(text).config.batteryLowMv, BATTERY_DEFAULT_LOW_MV);
  });

  it('still writes a disabled cutoff to the card as 0', () => {
    // FIRMWARE: battery.c returns false outright on a zero threshold, so the value has to
    // reach the device rather than being omitted and falling back to the built-in default.
    const text = serializeConfig(withCutoff(0));
    assert.match(text, /^BATTERY_LOW_MV = "0"$/m);
    assert.equal(parseConfig(text).config.batteryLowMv, 0);
  });

  it('round-trips an ordinary cutoff through the card format', () => {
    const text = serializeConfig(withCutoff(3400));
    assert.match(text, /^BATTERY_LOW_MV = "3400"$/m);
    assert.equal(parseConfig(text).config.batteryLowMv, 3400);
  });

  it('rejects a cutoff too low to ever fire, and offers the floor', () => {
    const issues = issuesFor(BATTERY_CUTOFF_MIN_MV - 100);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'error');
    assert.match(issues[0]!.message, /never fire/);
    assert.deepEqual(issues[0]!.fix?.patch, { batteryLowMv: BATTERY_CUTOFF_MIN_MV });
  });

  it('rejects a cutoff above a full cell, which would stop the deployment immediately', () => {
    const issues = issuesFor(BATTERY_CUTOFF_MAX_MV + 100);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'error');
    assert.deepEqual(issues[0]!.fix?.patch, { batteryLowMv: BATTERY_DEFAULT_LOW_MV });
  });

  it('warns without blocking on a legal but tight cutoff', () => {
    const issues = issuesFor(BATTERY_CUTOFF_ADVISED_MIN_MV - 100);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.severity, 'warning');
    assert.match(issues[0]!.message, /margin/);
  });

  it('rejects a negative or non-finite cutoff', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const issues = issuesFor(bad);
      assert.equal(issues.length, 1, `${bad} should raise exactly one issue`);
      assert.equal(issues[0]!.severity, 'error');
    }
  });

  it('never blocks writing the card for a disabled cutoff', () => {
    const blocking = validateConfig(withCutoff(0)).filter((issue) => issue.severity === 'error');
    assert.deepEqual(blocking, []);
  });
});
