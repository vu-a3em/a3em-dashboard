import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeReadiness, planPreparation, type CardReadinessReport } from './card-readiness.js';
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
  assert.equal(capacity.title, 'Capacity is counterfeit');
  assert.match(capacity.detail, /256\.0 GB.*16\.0 GB/);
});

test('what this computer did not see is unknown, not passed', () => {
  const report = prepared({ layout: null, layoutSkipped: 'needs-admin' });
  const verdict = judgeReadiness(report, expected);
  assert.equal(verdict.status, 'attention');
  assert.equal(check(report, 'layout')!.status, 'unknown');
  assert.equal(check(report, 'layout')!.title, 'Layout not checked');
  assert.match(check(report, 'layout')!.detail, /administrator/);
});

test('a layout that could not be read says why', () => {
  const report = prepared({ layout: null, layoutSkipped: 'platform-error', layoutError: 'The administrator step did not finish. (execution error (1))' });
  const layout = check(report, 'layout')!;
  assert.equal(layout.status, 'unknown');
  assert.match(layout.detail, /did not finish\. \(execution error \(1\)\)/);
  assert.match(layout.detail, /report it/);
});

test('an older helper’s reason, recorded only among its problems, is still shown', () => {
  const report = prepared({
    layout: null,
    layoutSkipped: 'permission-denied',
    problems: ["The card's layout could not be read: The helper was not allowed to open the card."],
  });
  assert.match(check(report, 'layout')!.detail, /could not be read: The helper was not allowed to open the card\. Check the card again/);
  assert.match(check(prepared({ layout: null, layoutSkipped: 'unexpected' }), 'layout')!.detail, /no reason was given/);
});

test('capacity and write speed never tested here are a note, not unknown checks', () => {
  const verdict = judgeReadiness(prepared({ prepared: null }), expected);
  assert.equal(verdict.status, 'ready', JSON.stringify(verdict.checks.filter((c) => c.status !== 'pass')));
  assert.equal(verdict.checks.find((c) => c.id === 'capacity'), undefined);
  assert.equal(verdict.checks.find((c) => c.id === 'write-speed'), undefined);
  assert.equal(verdict.notes.length, 1);
  assert.equal(
    verdict.notes[0],
    'Capacity and write speed were not checked. Testing them overwrites the whole card, so they will not be verified until a card is prepared on this computer.',
  );
});

test('a card prepared here without the capacity test says so', () => {
  const verdict = judgeReadiness(prepared({ prepared: { ...prepared().prepared!, capacity: undefined } }), expected);
  assert.equal(verdict.checks.find((c) => c.id === 'capacity'), undefined);
  assert.equal(verdict.checks.find((c) => c.id === 'write-speed')!.status, 'pass');
  assert.deepEqual(verdict.notes, ['This card was prepared on this computer without testing its capacity.']);
});

test('titles say what was found, so they never contradict the detail', () => {
  const used = prepared({ contents: { files: 4949, directories: 3, bytes: 4.9e9, truncated: true } });
  assert.equal(check(used, 'empty')!.title, 'Card has files on it');
  assert.match(check(used, 'empty')!.detail, /^It holds at least 4,949 files \(4\.9 GB\) from before\./);
  assert.equal(check(prepared(), 'empty')!.title, 'Card is empty');
  assert.equal(check(prepared({ config: { present: false, bytes: 0 } }), 'config')!.title, 'No configuration file');
  assert.equal(check(prepared({ device: { ...prepared().device, writeProtected: true } }), 'write-protect')!.title, 'Card is locked');
  assert.equal(check(prepared({ config: { present: false, bytes: 0 } }), 'empty')!.detail, 'Nothing is on it.');
  const folders = prepared({ contents: { files: 0, directories: 2, bytes: 0 } });
  assert.match(check(folders, 'empty')!.detail, /^It holds 2 folders from before\./);
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
  assert.equal(check(report, 'write-speed')!.title, 'Writes stall');
  assert.match(check(report, 'write-speed')!.detail, /2\.4 s/);
});

test('a ready card needs nothing prepared', () => {
  assert.deepEqual(planPreparation(judgeReadiness(prepared(), expected)), { kind: 'none' });
});

test('a card missing only its configuration gets its settings, and nothing is erased', () => {
  const missing = planPreparation(judgeReadiness(prepared({ config: { present: false, bytes: 0 } }), expected));
  assert.deepEqual(missing, { kind: 'settings', fixes: ['No configuration file'], cannotFix: [] });
  const other = planPreparation(judgeReadiness(prepared({ config: { present: true, text: OTHER, bytes: OTHER.length } }), expected));
  assert.equal(other.kind, 'settings');
});

test('what only erasing fixes means erasing, and it says everything erasing fixes', () => {
  const report = prepared({
    layout: { reference: false, problem: 'The card has no MBR partition table.' },
    contents: { files: 3, directories: 1, bytes: 1e9 },
    config: { present: false, bytes: 0 },
    volume: { ...prepared().volume!, label: 'CivicAlert' },
  });
  assert.deepEqual(planPreparation(judgeReadiness(report, { ...expected, requiredBytes: 90e9 })), {
    kind: 'erase',
    // Not only what made erasing necessary: the configuration comes with it.
    fixes: ['Layout differs from the reference', 'Card has files on it', 'No configuration file'],
    cannotFix: ['Card too small for the whole deployment'],
  });
});

test('a card named otherwise is noted, and is as ready as one named for its unit', () => {
  const renamed = judgeReadiness(prepared({ volume: { ...prepared().volume!, label: 'sdfa_01' } }), expected);
  assert.equal(renamed.status, judgeReadiness(prepared(), expected).status);
  assert.equal(renamed.checks.some((item) => item.id === 'label'), false);
  assert.match(renamed.notes.join(' '), /named sdfa_01 rather than FIELD1\. The recorder does not read the name/);
  assert.equal(check(prepared(), 'label')!.title, 'Card name matches');
});

test('no name is expected where the unit has none a card can carry', () => {
  const verdict = judgeReadiness(prepared({ volume: { ...prepared().volume!, label: 'sdfa_01' } }), { ...expected, volumeLabel: null });
  assert.equal(verdict.checks.some((item) => item.id === 'label'), false);
  assert.doesNotMatch(verdict.notes.join(' '), /named/);
});

test('a card too small, a slow card, or a different name does not call for erasing', () => {
  const report = prepared({
    volume: { ...prepared().volume!, label: 'CivicAlert' },
    prepared: { ...prepared().prepared!, latency: { verdict: 'slow', medianMs: 8, p99Ms: 300, maxMs: 400, mbPerSecond: 12 } },
  });
  assert.deepEqual(planPreparation(judgeReadiness(report, { ...expected, requiredBytes: 90e9 })), { kind: 'none' });
});

test('a locked or counterfeit card cannot be prepared', () => {
  const locked = planPreparation(judgeReadiness(prepared({ device: { ...prepared().device, writeProtected: true } }), expected));
  assert.equal(locked.kind, 'blocked');
  const fake = prepared({ prepared: { ...prepared().prepared!, capacity: { genuine: false, verdict: 'wraps', claimedBytes: 256e9, verifiedBytes: 16e9 } } });
  assert.equal(planPreparation(judgeReadiness(fake, expected)).kind, 'blocked');
});

test('a layout that could not be read is not a reason to erase', () => {
  const report = prepared({ layout: null, layoutSkipped: 'permission-denied', config: { present: false, bytes: 0 } });
  assert.equal(planPreparation(judgeReadiness(report, expected)).kind, 'settings');
});

test('a few small files are not described as nothing', () => {
  const report = prepared({ contents: { files: 1, directories: 1, bytes: 300_000 } });
  assert.match(check(report, 'empty')!.detail, /^It holds 1 file \(300 kB\) from before\./);
});
