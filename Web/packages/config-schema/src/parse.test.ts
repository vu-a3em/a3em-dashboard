import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from './parse.js';
import { DEVICE_LABEL_MAX_LEN, MAX_CFG_LINE_LENGTH } from './firmware-constants.js';

describe('the configuration line-length limit', () => {
  it('rejects a line that fills the device buffer exactly', () => {
    // The firmware reads into char[80] and searches THAT buffer for the newline. A line of
    // 80 characters plus its newline is 81 bytes, the newline never lands in the buffer,
    // the search returns -1, and parsing stops — truncating the deployment silently.
    const line = `DEVICE_LABEL = "${'x'.repeat(80 - 17)}"`;
    assert.equal(line.length, 80);
    const issues = parseConfig(`${line}\n`).warnings;
    assert.ok(issues.some((warning) => warning.includes('80 bytes')), issues.join(' | '));
  });

  it('accepts a line one byte short of the buffer', () => {
    const line = `DEVICE_LABEL = "${'x'.repeat(79 - 17)}"`;
    assert.equal(line.length, 79);
    assert.ok(!parseConfig(`${line}\n`).warnings.some((w) => w.includes('bytes (limit')));
  });

  it('keeps the longest allowed label inside the line limit', () => {
    const line = `DEVICE_LABEL = "${'x'.repeat(DEVICE_LABEL_MAX_LEN)}"`;
    assert.ok(line.length < MAX_CFG_LINE_LENGTH, `${line.length} must be under ${MAX_CFG_LINE_LENGTH}`);
  });
});
