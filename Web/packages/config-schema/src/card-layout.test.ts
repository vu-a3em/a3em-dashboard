import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyFile,
  applyCorrection,
  correctionFromActivation,
  correctionFromClockSyncs,
  correctionFromDeactivation,
  correctionOptions,
  manualCorrection,
  describeCorrection,
  parseFileTimestamp,
  planRename,
  readCardLayout,
  renderTimestamp,
  activationFromPath,} from './card-layout.js';

/** Paths exactly as the pre-2026.08.1 firmware wrote them (from the reference card). */
const LEGACY_ENTRIES = [
  { path: 'SAM_elephant_10/Activation_0001/2026-02-06/08/2026-02-06 09-00-24.wav', sizeBytes: 960044 },
  { path: 'SAM_elephant_10/Activation_0001/2026-02-06/08/2026-02-06 09-00-24.imu', sizeBytes: 36012 },
  { path: 'SAM_elephant_10/Activation_0001/2026-02-06/08/2026-02-06 09-01-24.wav', sizeBytes: 960044 },
  { path: 'a3em.log', sizeBytes: 5742142 },
  { path: '_a3em.cfg', sizeBytes: 1107 },
  { path: '.DS_Store', sizeBytes: 10244 },
];

/** The same recordings as 2026.08.1 writes them. */
const EPOCH_ENTRIES = [
  { path: 'SAM_elephant_10/Activation_0001/1770336000/1770350400/1770368424.wav', sizeBytes: 960044 },
  { path: 'SAM_elephant_10/Activation_0001/1770336000/1770350400/1770368424.imu', sizeBytes: 36012 },
  { path: 'SAM_elephant_10/Activation_0001/1770336000/1770350400/1770368484.wav', sizeBytes: 960044 },
  { path: 'SAM_elephant_10/Activation_0001/1770336000/1770350400/a3em.log', sizeBytes: 4096 },
  { path: '_a3em.dev', sizeBytes: 256 },
];

describe('timestamp parsing across both schemes', () => {
  it('reads an epoch name', () => {
    assert.equal(parseFileTimestamp('1770368424'), '2026-02-06T09:00:24.000Z');
  });

  it('reads a rendered name', () => {
    assert.equal(parseFileTimestamp('2026-02-06 09-00-24'), '2026-02-06T09:00:24.000Z');
  });

  it('agrees between the two for the same instant', () => {
    // The naming change must not shift any time by so much as a second.
    assert.equal(parseFileTimestamp('1770368424'), parseFileTimestamp('2026-02-06 09-00-24'));
  });

  it('does not mistake a sequence number for an epoch', () => {
    assert.equal(parseFileTimestamp('0000000001'), null);
    assert.equal(parseFileTimestamp('000042'), null);
  });
});

describe('card layout', () => {
  it('recognizes the legacy scheme', () => {
    const layout = readCardLayout(LEGACY_ENTRIES);
    assert.equal(layout.epochNaming, false);
    assert.equal(layout.deviceLabel, 'SAM_elephant_10');
    assert.deepEqual(layout.activations, [1]);
    assert.equal(layout.audioCount, 2);
    assert.equal(layout.imuCount, 1);
  });

  it('recognizes the epoch scheme', () => {
    const layout = readCardLayout(EPOCH_ENTRIES);
    assert.equal(layout.epochNaming, true);
    assert.equal(layout.deviceLabel, 'SAM_elephant_10');
    assert.equal(layout.firstDeviceTime, '2026-02-06T09:00:24.000Z');
    assert.equal(layout.lastDeviceTime, '2026-02-06T09:01:24.000Z');
  });

  it('classifies the card-root artifacts', () => {
    const layout = readCardLayout([...LEGACY_ENTRIES, ...EPOCH_ENTRIES]);
    const kinds = new Map(layout.files.map((f) => [f.name, f.kind]));
    assert.equal(kinds.get('_a3em.cfg'), 'config');
    assert.equal(kinds.get('_a3em.dev'), 'device-info');
    assert.equal(kinds.get('a3em.log'), 'log');
  });

  it('recognizes the numbered fallback logs', () => {
    const layout = readCardLayout([{ path: 'x/Activation_0001/1/2/a3em.3.log', sizeBytes: 10 }]);
    assert.equal(layout.files[0].kind, 'log');
  });

  it('ignores dotfiles', () => {
    assert.ok(!readCardLayout(LEGACY_ENTRIES).files.some((f) => f.name === '.DS_Store'));
  });
});

describe('clock correction', () => {
  /**
   * The device sets its RTC to the CONFIGURED start when the magnet activates it, so
   * the error is fixed from that moment. Knowing when it was ACTIVATED pins it;
   * knowing when it was COLLECTED does not, unless it was still running then.
   */
  it('derives the offset from activation time', () => {
    // Configured to start at 09:00; actually activated at 11:30, so the clock runs
    // 2h30m behind reality for the whole deployment.
    const correction = correctionFromActivation('2026-02-06T09:00:00.000Z', '2026-02-06T11:30:00.000Z');
    assert.equal(correction.offsetSeconds, 9000);
    assert.equal(correction.method, 'activation');
  });

  it('shifts a device time onto the real timeline', () => {
    const correction = correctionFromActivation('2026-02-06T09:00:00.000Z', '2026-02-06T11:30:00.000Z');
    assert.equal(applyCorrection('2026-02-06T09:00:24.000Z', correction), '2026-02-06T11:30:24.000Z');
  });

  it('derives the offset from deactivation time', () => {
    const correction = correctionFromDeactivation('2026-02-08T05:19:54.000Z', '2026-02-08T07:49:54.000Z');
    assert.equal(correction.offsetSeconds, 9000);
    assert.equal(correction.method, 'deactivation');
  });

  it('leaves times untouched when there is no correction', () => {
    assert.equal(applyCorrection('2026-02-06T09:00:24.000Z', null), '2026-02-06T09:00:24.000Z');
  });

  it('describes the direction the clock was wrong in', () => {
    assert.match(describeCorrection(manualCorrection(10800)), /behind by 3h/);
    assert.match(describeCorrection(manualCorrection(-90)), /ahead by 1m/);
  });
});

describe('which correction methods a card actually supports', () => {
  const base = {
    configuredStartTime: '2026-02-06T09:00:00.000Z',
    setsRtcAtActivation: true,
    lastDeviceTime: '2026-02-08T05:19:54.000Z',
    gpsAvailable: false,
  };
  const find = (options: ReturnType<typeof correctionOptions>, method: string) =>
    options.find((option) => option.method === method)!;

  it('offers deactivation only when the device was deactivated by magnet', () => {
    // Still running when reached, so its last recorded time is that moment.
    const magnet = correctionOptions({ ...base, stopReason: 'MAGNET-OFF' });
    assert.equal(find(magnet, 'deactivation').available, true);
  });

  it('refuses deactivation when the device stopped on its own', () => {
    // THE BUG THIS REPLACED. A device that ended on schedule may have sat idle for
    // weeks; collection time then measures the idle gap, not the clock error.
    for (const reason of ['PHASE-DONE', 'BATTERY-LOW', 'RTC-STOPPED', 'SD-FAILURE']) {
      const options = correctionOptions({ ...base, stopReason: reason });
      assert.equal(find(options, 'deactivation').available, false, `${reason} should rule out deactivation`);
      assert.match(find(options, 'deactivation').rationale, /sat idle|unknown/);
    }
  });

  it('refuses deactivation when the stop reason is unknown', () => {
    // A legacy card carries no _a3em.dev, so we cannot tell whether it was running.
    const options = correctionOptions({ ...base, stopReason: null });
    assert.equal(find(options, 'deactivation').available, false);
  });

  it('offers activation whenever the device seeds its clock at activation', () => {
    const options = correctionOptions({ ...base, stopReason: 'DEPLOYMENT_ENDED' });
    assert.equal(find(options, 'activation').available, true);
  });

  it('refuses activation when the device does not seed its clock', () => {
    // Without SET_RTC_AT_MAGNET_DETECT the RTC keeps whatever it already held, so the
    // moment of activation says nothing about the error.
    const options = correctionOptions({ ...base, setsRtcAtActivation: false, stopReason: 'MAGNET-OFF' });
    assert.equal(find(options, 'activation').available, false);
  });

  it('always leaves a manual route open', () => {
    const options = correctionOptions({ ...base, setsRtcAtActivation: false, stopReason: null });
    assert.equal(find(options, 'manual').available, true);
  });

  it('explains why GPS is unavailable rather than hiding it', () => {
    // A unit with no receiver, versus one that has a receiver but recorded no fix,
    // are different situations and should read differently.
    assert.match(find(correctionOptions({ ...base, stopReason: 'MAGNET-OFF' }), 'gps').rationale, /no GPS receiver/);
    assert.match(
      find(correctionOptions({ ...base, stopReason: 'MAGNET-OFF', gpsAvailable: true }), 'gps').rationale,
      /no clock correction/,
    );
  });
});

describe('GPS clock correction', () => {
  /**
   * The device knows true UTC from a fix, so the correction it applied IS the error.
   * It is necessarily piecewise: recordings before the fix carry the activation error,
   * and everything after is already true UTC.
   */
  const syncs = [
    {
      // Clock read 09:00 when it was really 11:30 — activated 2h30m late.
      beforeDeviceTime: '2026-02-06T09:00:00.000Z',
      afterTrueTime: '2026-02-06T11:30:00.000Z',
      source: 'GPS',
    },
  ];

  it('takes the offset from the correction the device applied', () => {
    const correction = correctionFromClockSyncs(syncs)!;
    assert.equal(correction.offsetSeconds, 9000);
    assert.equal(correction.method, 'gps');
  });

  it('shifts recordings made before the fix', () => {
    const correction = correctionFromClockSyncs(syncs)!;
    assert.equal(applyCorrection('2026-02-06T08:30:00.000Z', correction), '2026-02-06T11:00:00.000Z');
  });

  it('leaves recordings after the fix untouched', () => {
    // THE POINT OF THE PIECEWISE MODEL. Applying one offset across the deployment
    // would push everything after the fix 2h30m into the future.
    const correction = correctionFromClockSyncs(syncs)!;
    assert.equal(applyCorrection('2026-02-06T12:00:00.000Z', correction), '2026-02-06T12:00:00.000Z');
    assert.equal(applyCorrection('2026-02-08T05:19:54.000Z', correction), '2026-02-08T05:19:54.000Z');
  });

  it('treats the fix instant itself as already corrected', () => {
    const correction = correctionFromClockSyncs(syncs)!;
    assert.equal(applyCorrection('2026-02-06T11:30:00.000Z', correction), '2026-02-06T11:30:00.000Z');
  });

  it('reports later drift as the accuracy bound', () => {
    const withDrift = correctionFromClockSyncs([
      ...syncs,
      { beforeDeviceTime: '2026-02-07T11:30:00.000Z', afterTrueTime: '2026-02-07T11:30:04.000Z', source: 'GPS' },
    ])!;
    assert.equal(withDrift.accuracySeconds, 4);
  });

  it('returns nothing when the device recorded no correction', () => {
    assert.equal(correctionFromClockSyncs([]), null);
  });

  it('becomes the available method once the card carries syncs', () => {
    const options = correctionOptions({
      configuredStartTime: '2026-02-06T09:00:00.000Z',
      setsRtcAtActivation: true,
      stopReason: 'DEPLOYMENT_ENDED',
      lastDeviceTime: '2026-02-08T05:19:54.000Z',
      gpsAvailable: true,
      clockSyncs: syncs,
    });
    assert.equal(options.find((o) => o.method === 'gps')!.available, true);
  });

  it('explains a GPS unit that never obtained a fix', () => {
    const options = correctionOptions({
      configuredStartTime: '2026-02-06T09:00:00.000Z',
      setsRtcAtActivation: true,
      stopReason: 'MAGNET-OFF',
      lastDeviceTime: '2026-02-08T05:19:54.000Z',
      gpsAvailable: true,
      clockSyncs: [],
    });
    const gps = options.find((o) => o.method === 'gps')!;
    assert.equal(gps.available, false);
    assert.match(gps.rationale, /no fix was obtained|already correct/);
  });
});

describe('rename planning', () => {
  const correction = correctionFromActivation('2026-02-06T09:00:00.000Z', '2026-02-06T12:00:00.000Z');

  it('renders corrected human-readable names', () => {
    const plan = planRename(readCardLayout(EPOCH_ENTRIES), correction);
    const wav = plan.entries.find((e) => e.from.endsWith('1770368424.wav'))!;
    assert.equal(wav.to, 'SAM_elephant_10/Activation_0001/2026-02-06/12/2026-02-06 12-00-24.wav');
    assert.equal(wav.correctedTime, '2026-02-06T12:00:24.000Z');
  });

  it('renames the IMU file alongside its audio', () => {
    // The desktop tool renamed only .wav, silently desynchronizing motion data.
    const plan = planRename(readCardLayout(EPOCH_ENTRIES), correction);
    assert.ok(plan.entries.some((e) => e.to.endsWith('.imu')));
  });

  it('places files in the corrected day and hour bucket', () => {
    const plan = planRename(readCardLayout(EPOCH_ENTRIES), correction);
    assert.ok(plan.directories.includes('SAM_elephant_10/Activation_0001/2026-02-06/12'));
  });

  it('leaves logs and config alone', () => {
    const plan = planRename(readCardLayout(EPOCH_ENTRIES), correction);
    assert.ok(!plan.entries.some((e) => e.from.endsWith('.log') || e.from.endsWith('.cfg')));
  });

  it('reports collisions rather than letting a rename overwrite data', () => {
    // Two clips one second apart collapse onto one name only if the correction is
    // nonsense, but the plan must surface it rather than destroy a file.
    const layout = readCardLayout([
      { path: 'L/Activation_0001/1770336000/1770350400/1770368424.wav', sizeBytes: 1 },
      { path: 'L/Activation_0001/1770336000/1770350400/2026-02-06 09-00-24.wav', sizeBytes: 1 },
    ]);
    assert.equal(planRename(layout, manualCorrection(0)).collisions.length, 1);
  });

  it('records anything it skips instead of dropping it', () => {
    const layout = readCardLayout([{ path: 'stray.wav', sizeBytes: 1 }]);
    const plan = planRename(layout, correction);
    assert.equal(plan.entries.length, 0);
    assert.equal(plan.skipped.length, 1);
  });
});

describe('renderTimestamp', () => {
  it('matches the format the desktop tool used', () => {
    assert.equal(renderTimestamp('2026-02-06T09:00:24.000Z'), '2026-02-06 09-00-24');
  });
});

describe('separating activations', () => {
  // Times cannot do this. A device configured to set its clock at activation starts every
  // run at the same configured time, so activation 2's timestamps land on top of
  // activation 1's. The directory the device wrote into is the only separator.
  it('reads the activation out of a path', () => {
    assert.equal(activationFromPath('SAM_01/Activation_0003/1770368400/1770368461.wav'), 3);
    assert.equal(activationFromPath('SAM_01/Activation_0012/1770368400/a3em.log'), 12);
  });

  it('returns nothing for a path outside any activation', () => {
    assert.equal(activationFromPath('_a3em.cfg'), null);
    assert.equal(activationFromPath('SAM_01/1770368400/x.wav'), null);
  });

  it('is not fooled by a similar-looking segment', () => {
    assert.equal(activationFromPath('Activation_notanumber/x.wav'), null);
    assert.equal(activationFromPath('My_Activation_0002/x.wav'), null);
  });
});

describe('the self-test capture', () => {
  it('is not counted as a deployment recording', () => {
    // It is a WAV at the card root that the firmware writes during its microphone check.
    // Counting it inflated every clip total by one and gave the clip browser an "Undated"
    // day holding a file the deployment never scheduled.
    const layout = readCardLayout([
      { path: '_a3em.test.wav', sizeBytes: 640044 },
      { path: 'SAM/Activation_0001/1788048000/1788048000/1787871640.wav', sizeBytes: 1000 },
    ]);
    assert.equal(layout.audioCount, 1);
    assert.equal(layout.files.find((f) => f.name === '_a3em.test.wav')?.kind, 'self-test-clip');
  });

  it('still classifies ordinary recordings as audio', () => {
    assert.equal(classifyFile('1787871640.wav'), 'audio');
    assert.equal(classifyFile('1787871640.opus'), 'audio');
    assert.equal(classifyFile('_a3em.test.wav'), 'self-test-clip');
  });
});
