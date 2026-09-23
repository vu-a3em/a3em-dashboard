import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeReadiness, type CardReadinessReport } from './card-readiness.js';
import { defaultConfig } from './defaults.js';
import { serializeConfig } from './serialize.js';

const CONFIG = serializeConfig({ ...defaultConfig(), deviceLabel: 'FIELD1' });
const OTHER = serializeConfig({ ...defaultConfig(), deviceLabel: 'OTHER' });

/** A card this computer has just prepared, as the helper reports it. */
function prepared(overrides: Partial<CardReadinessReport> = {}): CardReadinessReport {
  return {
    device: { id: 'disk4', node: '/dev/disk4', sizeBytes: 64e9, bus: 'USB', partitionScheme: 'mbr', writeProtected: false },
    volume: { id: 'disk4s1', label: 'FIELD1', filesystem: 'exfat', allocationUnitBytes: 32768, mountPoint: '/Volumes/FIELD1' },
    geometry: { partitionScheme: 'mbr', filesystem: 'exfat', bytesPerSector: 512, allocationUnitBytes: 32768, mountable: true },
    contents: { files: 0, directories: 0, bytes: 0 },
    config: { present: true, text: CONFIG, bytes: CONFIG.length },
    freeBytes: 63.9e9,
    layout: { reference: true, clusterBytes: 32768, regions: [{ name: 'boot region', status: 'in-use' }] },
    prepared: {
      preparedAt: '2026-09-23T12:00:00Z',
      clusterBytes: 32768,
      label: 'FIELD1',
      capacity: { genuine: true, verdict: 'genuine', claimedBytes: 64e9, verifiedBytes: 64e9 },
      latency: { verdict: 'ok', medianMs: 5, p99Ms: 12, maxMs: 20, mbPerSecond: 40 },
    },
    ...overrides,
  };
}

const expected = { configText: CONFIG, volumeLabel: 'FIELD1', allocationUnitBytes: 32768, requiredBytes: 20e9 };
const check = (report: CardReadinessReport, id: string, expectation = expected) =>
  judgeReadiness(report, expectation).checks.find((c) => c.id === id);

test('a card prepared here, holding this deployment, is ready', () => {
  const verdict = judgeReadiness(prepared(), expected);
  assert.equal(verdict.status, 'ready', JSON.stringify(verdict.checks.filter((c) => c.status !== 'pass')));
  assert.deepEqual(
    verdict.checks.map((c) => c.id),
    ['write-protect', 'layout', 'capacity', 'write-speed', 'format', 'empty', 'config', 'config-match', 'label', 'space'],
  );
});

test('a locked card is not ready', () => {
  const report = prepared({ device: { ...prepared().device, writeProtected: true } });
  assert.equal(judgeReadiness(report, expected).status, 'not-ready');
  assert.match(check(report, 'write-protect')!.detail, /LOCK/);
});

test('a counterfeit is not ready and says how much it really holds', () => {
  const report = prepared({
    prepared: { ...prepared().prepared!, capacity: { genuine: false, verdict: 'wraps', claimedBytes: 256e9, verifiedBytes: 16e9 } },
  });
  const capacity = check(report, 'capacity')!;
  assert.equal(capacity.status, 'fail');
  assert.match(capacity.detail, /256\.0 GB.*16\.0 GB/);
});

test('what this computer did not see is unknown, not passed', () => {
  const report = prepared({ prepared: null, layout: null, layoutSkipped: 'needs-admin' });
  const verdict = judgeReadiness(report, expected);
  assert.equal(verdict.status, 'attention');
  assert.equal(check(report, 'capacity')!.status, 'unknown');
  assert.equal(check(report, 'write-speed')!.status, 'unknown');
  assert.match(check(report, 'layout')!.detail, /administrator/);
});

test('a card that differs from the reference names what differs', () => {
  const report = prepared({
    layout: { reference: false, regions: [{ name: 'file allocation table', status: 'differs' }, { name: 'up-case table', status: 'match' }] },
  });
  assert.equal(check(report, 'layout')!.status, 'fail');
  assert.match(check(report, 'layout')!.detail, /file allocation table/);
});

test('a missing configuration fails with what the recorder will do', () => {
  const report = prepared({ config: { present: false, bytes: 0 } });
  assert.equal(check(report, 'config')!.status, 'fail');
  assert.match(check(report, 'config')!.detail, /restarts every 15 seconds/);
  assert.equal(check(report, 'config-match'), undefined);
});

test('another deployment’s configuration does not pass as this one', () => {
  const report = prepared({ config: { present: true, text: OTHER, bytes: OTHER.length } });
  assert.equal(check(report, 'config')!.status, 'pass');
  assert.equal(check(report, 'config-match')!.status, 'fail');
  assert.equal(check(prepared({ config: { present: true, text: CONFIG.replace(/\n/g, '\r\n'), bytes: CONFIG.length } }), 'config-match')!.status, 'pass');
});

test('old recordings are a warning and count toward space', () => {
  const report = prepared({ contents: { files: 1200, directories: 40, bytes: 50e9, examples: ['FIELD1/Activation_0001'] }, freeBytes: 13e9 });
  assert.equal(check(report, 'empty')!.status, 'warn');
  assert.match(check(report, 'empty')!.detail, /1,200 files/);
  assert.equal(check(report, 'space')!.status, 'fail');
});

test('a deployment no card this size could hold is the plan’s limit, not the card’s fault', () => {
  const space = check(prepared(), 'space', { ...expected, requiredBytes: 90e9 })!;
  assert.equal(space.status, 'warn');
  assert.match(space.detail, /larger card/);
});

test('a GPT card fails the format check with the firmware’s reason', () => {
  const report = prepared({ geometry: { ...prepared().geometry!, partitionScheme: 'gpt' } });
  assert.equal(check(report, 'format')!.status, 'fail');
  assert.match(check(report, 'format')!.detail, /erase everything/);
});

test('a slow card is a warning, not a refusal', () => {
  const report = prepared({ prepared: { ...prepared().prepared!, latency: { verdict: 'stalls', medianMs: 8, p99Ms: 900, maxMs: 2400, mbPerSecond: 12 } } });
  assert.equal(check(report, 'write-speed')!.status, 'warn');
  assert.match(check(report, 'write-speed')!.detail, /2\.4 s/);
});
