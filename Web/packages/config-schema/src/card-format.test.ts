import assert from 'node:assert/strict';
import test from 'node:test';
import {
  judgeCardFormat,
  validateFormatRequest,
  DEVICE_FORMAT_ALLOCATION_UNIT_BYTES,
  type CardGeometry,
} from './card-format.js';
import { SD_CARD_ALLOCATION_UNIT_BYTES } from './firmware-constants.js';

function geometry(overrides: Partial<CardGeometry> = {}): CardGeometry {
  return {
    partitionScheme: 'mbr',
    filesystem: 'exfat',
    bytesPerSector: 512,
    allocationUnitBytes: 32768,
    mountable: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The finding this whole feature exists for
// ---------------------------------------------------------------------------

test('a GPT card is reported as destroyed on insertion, not merely unsupported', () => {
  // FF_LBA64 = 0 compiles out FatFs's GPT branch, so the firmware sees no filesystem —
  // and storage_init() reacts to FR_NO_FILESYSTEM by calling f_mkfs. The card is not
  // rejected; it is erased. Nothing else the operator has shows this.
  const report = judgeCardFormat(geometry({ partitionScheme: 'gpt' }));
  assert.equal(report.usable, false);
  assert.equal(report.destructiveOnInsert, true);
  assert.equal(report.issues[0]?.code, 'gpt-will-be-erased');
  assert.match(report.issues[0]!.message, /erase everything on it/);
});

test('a card formatted with another filesystem is also destroyed on insertion', () => {
  const report = judgeCardFormat(geometry({ filesystem: 'ntfs' }));
  assert.equal(report.destructiveOnInsert, true);
  assert.ok(report.issues.some((issue) => issue.code === 'not-exfat'));
});

test('an MBR exFAT card is usable', () => {
  const report = judgeCardFormat(geometry());
  assert.equal(report.usable, true);
  assert.equal(report.destructiveOnInsert, false);
  assert.deepEqual(report.issues, []);
});

test('a blank card is a warning, not a hazard — the device formats it and carries on', () => {
  const report = judgeCardFormat(
    geometry({ partitionScheme: 'none', filesystem: null, allocationUnitBytes: null, mountable: false }),
  );
  assert.equal(report.destructiveOnInsert, false);
  assert.equal(report.issues[0]?.code, 'no-filesystem');
  assert.equal(report.usable, true);
});

test('a non-512-byte sector size cannot be reformatted away and says so', () => {
  const report = judgeCardFormat(geometry({ bytesPerSector: 4096 }));
  const issue = report.issues.find((candidate) => candidate.code === 'wrong-sector-size');
  assert.ok(issue);
  assert.match(issue!.remedy!, /different card/);
});

test('an unmountable card is flagged for recovery and kept out of a device', () => {
  const report = judgeCardFormat(geometry({ mountable: false, filesystem: null }));
  assert.equal(report.destructiveOnInsert, true);
  const issue = report.issues.find((candidate) => candidate.code === 'unmountable');
  assert.ok(issue);
  assert.match(issue!.remedy!, /Image the card/);
});

// ---------------------------------------------------------------------------
// Allocation unit advisory
// ---------------------------------------------------------------------------

test('no allocation advisory is given when no deployment is in hand', () => {
  const report = judgeCardFormat(geometry({ allocationUnitBytes: 4096 }));
  assert.equal(report.issues.length, 0);
});

test('an allocation unit within one doubling is left alone', () => {
  // Same tolerance allocation-unit.ts applies: reformatting erases the card, so the
  // advice has to be worth that.
  assert.deepEqual(judgeCardFormat(geometry({ allocationUnitBytes: 32768 }), 65536).issues, []);
  assert.deepEqual(judgeCardFormat(geometry({ allocationUnitBytes: 131072 }), 65536).issues, []);
});

test('an allocation unit more than one doubling away is an advisory, never an error', () => {
  const report = judgeCardFormat(geometry({ allocationUnitBytes: 4096 }), 65536);
  assert.equal(report.usable, true);
  assert.equal(report.issues[0]?.severity, 'advisory');
  assert.match(report.issues[0]!.message, /4 kB/);
  assert.match(report.issues[0]!.message, /64 kB/);
});

test('the device default tracks the firmware constant rather than a copy of it', () => {
  assert.equal(DEVICE_FORMAT_ALLOCATION_UNIT_BYTES, SD_CARD_ALLOCATION_UNIT_BYTES);
});

// ---------------------------------------------------------------------------
// Format request validation
// ---------------------------------------------------------------------------

test('a valid format request has no complaints', () => {
  assert.deepEqual(
    validateFormatRequest({ device: 'disk4', allocationUnitBytes: 65536, label: 'A3EM_01' }),
    [],
  );
});

test('an allocation unit outside the offered set is rejected', () => {
  const errors = validateFormatRequest({ device: 'disk4', allocationUnitBytes: 1234, label: 'A3EM' });
  assert.equal(errors.length, 1);
});

test('a label longer than exFAT allows is rejected rather than truncated', () => {
  // Truncating silently would produce a card labeled something the operator did not
  // choose, which in a batch of six is how two cards end up with the same name.
  const errors = validateFormatRequest({
    device: 'disk4',
    allocationUnitBytes: 65536,
    label: 'ABCDEFGHIJKL',
  });
  assert.equal(errors.length, 1);
});

test('a label with shell metacharacters is rejected', () => {
  for (const label of ['A3EM; rm -rf /', 'A3EM$(id)', 'A3EM`id`', "A3EM'x", 'A3EM/01']) {
    assert.ok(
      validateFormatRequest({ device: 'disk4', allocationUnitBytes: 65536, label }).length > 0,
      `${label} should be rejected`,
    );
  }
});

test('an empty label is rejected', () => {
  assert.ok(
    validateFormatRequest({ device: 'disk4', allocationUnitBytes: 65536, label: '   ' }).length > 0,
  );
});
