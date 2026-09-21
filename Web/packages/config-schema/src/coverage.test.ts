import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCoverage, expectationFor, localDate } from './coverage.js';
import { defaultConfig, defaultPhase } from './defaults.js';
import type { DeploymentConfig } from './types.js';

const UTC = 'UTC';

function config(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    ...defaultConfig(UTC, new Date('2026-04-01T00:00:00.000Z')),
    startTime: '2026-04-01T00:00:00.000Z',
    endTime: '2026-04-03T00:00:00.000Z',
    ...overrides,
  };
}

/** One recording on the hour, for each hour listed. */
const at = (...instants: string[]) => instants.map((instant) => ({ at: instant, sizeBytes: 1_000_000 }));

describe('what should have been recorded', () => {
  it('expects recordings every hour of a continuous deployment', () => {
    const continuous = config({ phases: [{ ...defaultPhase(), audioRecordingMode: 'CONTINUOUS' }] });
    assert.equal(expectationFor('2026-04-01T03:00:00.000Z', continuous, UTC), 'scheduled');
    assert.equal(expectationFor('2026-04-01T17:00:00.000Z', continuous, UTC), 'scheduled');
  });

  it('expects recordings only inside the scheduled windows', () => {
    const dawn = config({
      phases: [
        {
          ...defaultPhase(),
          audioRecordingMode: 'SCHEDULED',
          // 05:00-07:00 local.
          audioTriggerTimes: [{ startSecond: 5 * 3600, endSecond: 7 * 3600 }],
        },
      ],
    });
    assert.equal(expectationFor('2026-04-01T05:00:00.000Z', dawn, UTC), 'scheduled');
    assert.equal(expectationFor('2026-04-01T06:00:00.000Z', dawn, UTC), 'scheduled');
    assert.equal(expectationFor('2026-04-01T03:00:00.000Z', dawn, UTC), 'idle');
    assert.equal(expectationFor('2026-04-01T20:00:00.000Z', dawn, UTC), 'idle');
  });

  it('reads windows against local midnight, not UTC', () => {
    // A dawn window is 05:00 where the device is. Judging it in UTC would call the real
    // dawn recordings unscheduled and flag the empty hours as lost mornings.
    const dawn = config({
      phases: [
        {
          ...defaultPhase(),
          audioRecordingMode: 'SCHEDULED',
          audioTriggerTimes: [{ startSecond: 5 * 3600, endSecond: 7 * 3600 }],
        },
      ],
    });
    // 05:00 in Chicago (UTC-5 in April) is 10:00 UTC.
    assert.equal(expectationFor('2026-04-01T10:00:00.000Z', dawn, 'America/Chicago'), 'scheduled');
    assert.equal(expectationFor('2026-04-01T05:00:00.000Z', dawn, 'America/Chicago'), 'idle');
  });

  it('refuses to predict amplitude-triggered recording', () => {
    // Whether a clip exists depends on what the microphone heard. Calling a quiet hour a
    // gap would raise an alarm about a device doing exactly what it was told.
    const triggered = config({ phases: [{ ...defaultPhase(), audioRecordingMode: 'AMPLITUDE' }] });
    assert.equal(expectationFor('2026-04-01T03:00:00.000Z', triggered, UTC), 'unpredictable');
  });

  it('says nothing about hours outside the deployment window', () => {
    const continuous = config({ phases: [{ ...defaultPhase(), audioRecordingMode: 'CONTINUOUS' }] });
    assert.equal(expectationFor('2026-03-30T03:00:00.000Z', continuous, UTC), 'unknown');
    assert.equal(expectationFor('2026-04-05T03:00:00.000Z', continuous, UTC), 'unknown');
  });

  it('says nothing at all without a configuration to judge against', () => {
    assert.equal(expectationFor('2026-04-01T03:00:00.000Z', null, UTC), 'unknown');
  });

  it('follows the phase in force at the time', () => {
    const phased = config({
      isPhased: true,
      phases: [
        {
          ...defaultPhase('Continuous'),
          audioRecordingMode: 'CONTINUOUS',
          startTime: '2026-04-01T00:00:00.000Z',
          endTime: '2026-04-02T00:00:00.000Z',
        },
        {
          ...defaultPhase('Windows'),
          audioRecordingMode: 'SCHEDULED',
          audioTriggerTimes: [{ startSecond: 5 * 3600, endSecond: 7 * 3600 }],
          startTime: '2026-04-02T00:00:00.000Z',
          endTime: '2026-04-03T00:00:00.000Z',
        },
      ],
    });
    assert.equal(expectationFor('2026-04-01T12:00:00.000Z', phased, UTC), 'scheduled');
    assert.equal(expectationFor('2026-04-02T12:00:00.000Z', phased, UTC), 'idle');
  });
});

describe('building the coverage grid', () => {
  const continuous = config({ phases: [{ ...defaultPhase(), audioRecordingMode: 'CONTINUOUS' }] });

  it('counts recordings into their local hour', () => {
    const grid = buildCoverage({
      recordings: at('2026-04-01T03:10:00.000Z', '2026-04-01T03:50:00.000Z', '2026-04-01T04:10:00.000Z'),
      config: continuous,
      timezone: UTC,
    });
    assert.equal(grid.hours[0][3].clips, 2);
    assert.equal(grid.hours[0][4].clips, 1);
    assert.equal(grid.totalClips, 3);
  });

  it('always produces 24 hours a day', () => {
    const grid = buildCoverage({ recordings: at('2026-04-01T03:00:00.000Z'), config: continuous, timezone: UTC });
    assert.ok(grid.hours.every((day) => day.length === 24));
  });

  it('finds the hours that should hold recordings and do not', () => {
    // The whole point: a silent stretch in the middle of a continuous deployment.
    const grid = buildCoverage({
      recordings: at('2026-04-01T00:30:00.000Z', '2026-04-01T05:30:00.000Z'),
      config: continuous,
      timezone: UTC,
    });
    assert.ok(grid.gaps.length > 0);
    assert.ok(grid.gaps.every((gap) => gap.clips === 0 && gap.expectation === 'scheduled'));
    // Hours 1-4 are empty and scheduled.
    assert.equal(grid.longestGapHours >= 4, true);
  });

  it('does not count an unscheduled hour as a gap', () => {
    const dawn = config({
      phases: [
        {
          ...defaultPhase(),
          audioRecordingMode: 'SCHEDULED',
          audioTriggerTimes: [{ startSecond: 5 * 3600, endSecond: 7 * 3600 }],
        },
      ],
    });
    const grid = buildCoverage({
      recordings: at('2026-04-01T05:30:00.000Z', '2026-04-01T06:30:00.000Z', '2026-04-02T05:30:00.000Z', '2026-04-02T06:30:00.000Z'),
      config: dawn,
      timezone: UTC,
    });
    assert.deepEqual(grid.gaps, [], 'a dawn schedule that recorded at dawn has no gaps');
  });

  describe('a deployment that stopped before its configured end', () => {
    // Found on a real card: the end date was set nearly three years out so the device
    // would run until its battery died, and it recorded for two days. Treating every
    // hour after that as a gap produced 23,919 of them and a thousand rows of red.
    const runUntilBatteryDies = config({ endTime: '2028-10-31T21:00:00.000Z' });
    const grid = buildCoverage({
      recordings: at('2026-04-01T00:30:00.000Z', '2026-04-01T01:30:00.000Z'),
      config: { ...runUntilBatteryDies, phases: [{ ...defaultPhase(), audioRecordingMode: 'CONTINUOUS' }] },
      timezone: UTC,
    });

    it('reports the stop once rather than as thousands of gaps', () => {
      assert.deepEqual(grid.gaps, []);
      assert.ok(grid.stoppedEarly);
      assert.equal(grid.stoppedEarly!.configuredEnd, '2028-10-31T21:00:00.000Z');
    });

    it('draws only the days that were recorded', () => {
      assert.equal(grid.dates.length, 1);
    });

    it('still names when recording began and ended', () => {
      assert.equal(grid.firstRecordingAt, '2026-04-01T00:30:00.000Z');
      assert.equal(grid.lastRecordingAt, '2026-04-01T01:30:00.000Z');
    });
  });

  it('still finds an interruption in the middle, which is the real fault', () => {
    // The distinction the change turns on: silence before the end is a gap worth
    // investigating, silence after it is just the end.
    const grid = buildCoverage({
      recordings: at('2026-04-01T00:30:00.000Z', '2026-04-01T06:30:00.000Z'),
      config: continuous,
      timezone: UTC,
    });
    assert.ok(grid.gaps.length >= 4);
    assert.ok(grid.gaps.every((gap) => Date.parse(gap.startsAt) < Date.parse(grid.lastRecordingAt!)));
  });

  it('says nothing about stopping early when it ran to the end', () => {
    const grid = buildCoverage({
      recordings: at('2026-04-02T23:30:00.000Z'),
      config: continuous,
      timezone: UTC,
    });
    assert.equal(grid.stoppedEarly, null);
  });

  it('refuses to draw an implausibly long span', () => {
    const grid = buildCoverage({
      recordings: at('2020-01-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
      config: null,
      timezone: UTC,
    });
    assert.ok(grid.dates.length <= 366);
    assert.ok(grid.omittedDays > 0, 'the omission must be reported, not silent');
  });

  it('reports that it cannot judge a card with no configuration', () => {
    const grid = buildCoverage({ recordings: at('2026-04-01T03:00:00.000Z'), config: null, timezone: UTC });
    assert.equal(grid.expectationsUnknown, true);
    assert.deepEqual(grid.gaps, []);
    assert.equal(grid.totalClips, 1);
  });

  it('handles a card with no recordings at all', () => {
    const grid = buildCoverage({ recordings: [], config: continuous, timezone: UTC });
    assert.deepEqual(grid.dates, []);
    assert.equal(grid.totalClips, 0);
  });

  it('ignores recordings whose time could not be established', () => {
    const grid = buildCoverage({
      recordings: [{ at: null, sizeBytes: 100 }, ...at('2026-04-01T03:00:00.000Z')],
      config: continuous,
      timezone: UTC,
    });
    assert.equal(grid.totalClips, 1);
  });
});

describe('local dates', () => {
  it('uses the deployment timezone, not the machine one', () => {
    // 01:00 UTC is still the previous evening in Chicago. Getting this wrong shifts a
    // whole night of recordings onto the wrong row.
    assert.equal(localDate('2026-04-02T01:00:00.000Z', 'America/Chicago'), '2026-04-01');
    assert.equal(localDate('2026-04-02T01:00:00.000Z', 'UTC'), '2026-04-02');
  });
});

describe('the grid and the count agreeing', () => {
  // They are computed from the same flag on purpose. Deriving the colour separately let
  // a real card paint fifteen red hours while reporting no gaps at all.
  it('marks exactly the cells the gap list contains', () => {
    const grid = buildCoverage({
      recordings: at('2026-04-01T00:30:00.000Z', '2026-04-01T05:30:00.000Z'),
      config: config({ phases: [{ ...defaultPhase(), audioRecordingMode: 'CONTINUOUS' }] }),
      timezone: UTC,
    });
    const marked = grid.hours.flat().filter((cell) => cell.isGap);
    assert.equal(marked.length, grid.gaps.length);
  });

  it('marks nothing after the last recording as a gap', () => {
    const grid = buildCoverage({
      recordings: at('2026-04-01T00:30:00.000Z'),
      config: config({ phases: [{ ...defaultPhase(), audioRecordingMode: 'CONTINUOUS' }] }),
      timezone: UTC,
    });
    const trailing = grid.hours.flat().filter((cell) => cell.afterEnd);
    assert.ok(trailing.length > 0, 'there should be hours after the last recording');
    assert.ok(trailing.every((cell) => !cell.isGap));
  });
});
