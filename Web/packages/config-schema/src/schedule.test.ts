import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultConfig, defaultPhase } from './defaults.js';
import { parseConfig } from './parse.js';
import {
  dstChangesAffectingSchedule,
  firmwareEntryCount,
  offsetChanges,
  solarPeriodReports,
  firmwareTriggerTimes,
  mergeMidnightPeriods,
  periodEndFromClock,
  scheduleOnDay,
} from './schedule.js';
import { serializeConfig } from './serialize.js';
import { expectationFor } from './coverage.js';
import type { DeploymentConfig, PhaseConfig } from './types.js';

const h = (hours: number, minutes = 0) => hours * 3600 + minutes * 60;

function scheduled(overrides: Partial<PhaseConfig>): DeploymentConfig {
  return {
    ...defaultConfig('UTC', new Date('2026-04-01T00:00:00.000Z')),
    deviceLabel: 'OWL-01',
    startTime: '2026-04-01T00:00:00.000Z',
    endTime: '2026-04-15T00:00:00.000Z',
    phases: [{ ...defaultPhase(), audioRecordingMode: 'SCHEDULED', ...overrides }],
  };
}

const entries = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('AUDIO_TRIGGER_SCHEDULE ='))
    .map((line) => line.split('"')[1]);

describe('overnight recording periods', () => {
  it('reads an end at or before the start as the next day', () => {
    assert.equal(periodEndFromClock(h(21), h(3)), h(27));
    // "22:00 to 00:00" means until midnight, not an empty period.
    assert.equal(periodEndFromClock(h(22), 0), h(24));
    assert.equal(periodEndFromClock(h(6), h(8)), h(8));
    // Equal is left equal for validation to catch, rather than becoming 24 hours.
    assert.equal(periodEndFromClock(h(6), h(6)), h(6));
  });

  it('is written as the two entries either side of midnight', () => {
    const text = serializeConfig(scheduled({ audioTriggerTimes: [{ startSecond: h(21), endSecond: h(27) }] }));
    assert.deepEqual(entries(text), [`0-${h(3)}`, `${h(21)}-86400`]);
  });

  it('reads the pair back as the one period it was entered as', () => {
    const config = scheduled({ audioTriggerTimes: [{ startSecond: h(21), endSecond: h(27) }] });
    const parsed = parseConfig(serializeConfig(config)).config;
    assert.deepEqual(parsed.phases[0].audioTriggerTimes, [{ startSecond: h(21), endSecond: h(27) }]);
  });

  it('counts two entries against the device limit for each overnight period', () => {
    assert.equal(firmwareEntryCount([{ startSecond: h(21), endSecond: h(27) }, { startSecond: h(8), endSecond: h(9) }]), 3);
  });

  it('leaves ordinary periods alone when merging', () => {
    const periods = [{ startSecond: h(5), endSecond: h(7) }, { startSecond: h(18), endSecond: h(20) }];
    assert.deepEqual(mergeMidnightPeriods(periods), periods);
  });
});

describe('the order periods are written in', () => {
  it('sorts them, because the firmware stops at the first entry that has not ended', () => {
    // Entered evening first. Written in that order, a device at 07:00 would sleep until 18:00.
    const text = serializeConfig(
      scheduled({ audioTriggerTimes: [{ startSecond: h(18), endSecond: h(20) }, { startSecond: h(6), endSecond: h(8) }] }),
    );
    assert.deepEqual(entries(text), [`${h(6)}-${h(8)}`, `${h(18)}-${h(20)}`]);
  });

  it('sorts split halves in with everything else', () => {
    assert.deepEqual(
      firmwareTriggerTimes([{ startSecond: h(22), endSecond: h(26) }, { startSecond: h(12), endSecond: h(13) }]),
      [
        { startSecond: 0, endSecond: h(2) },
        { startSecond: h(12), endSecond: h(13) },
        { startSecond: h(22), endSecond: h(24) },
      ],
    );
  });
});

describe('what the device records on a given day', () => {
  const nashville = { latitude: 36.16, longitude: -86.78 };
  const dawn = {
    audioScheduleType: 'SOLAR' as const,
    audioSolarWindows: [{ startAnchor: 'DAWN' as const, startOffsetSeconds: 0, endAnchor: 'SUNRISE' as const, endOffsetSeconds: 5400 }],
    audioTriggerTimes: [{ startSecond: h(5), endSecond: h(7) }],
  };

  it('records continuously when a clock schedule has no periods', () => {
    const day = scheduleOnDay({ ...defaultPhase(), audioRecordingMode: 'SCHEDULED' }, nashville, Date.parse('2026-06-01T12:00:00Z') / 1000, -5 * 3600);
    assert.equal(day.continuous, true);
  });

  it('resolves solar periods against the day, and uses the fallback without a position', () => {
    const phase = { ...defaultPhase(), audioRecordingMode: 'SCHEDULED' as const, ...dawn };
    const noon = Date.parse('2026-06-01T17:00:00Z') / 1000;
    const resolved = scheduleOnDay(phase, nashville, noon, -5 * 3600);
    assert.equal(resolved.usedFallback, false);
    assert.equal(resolved.periods.length, 1);
    const fallback = scheduleOnDay(phase, { latitude: null, longitude: null }, noon, -5 * 3600);
    assert.equal(fallback.usedFallback, true);
    assert.deepEqual(fallback.periods, dawn.audioTriggerTimes);
  });

  it('records continuously on a polar day with no fallback', () => {
    const phase = { ...defaultPhase(), audioRecordingMode: 'SCHEDULED' as const, ...dawn, audioTriggerTimes: [] };
    const midsummer = Date.parse('2026-06-21T12:00:00Z') / 1000;
    const day = scheduleOnDay(phase, { latitude: 78.2, longitude: 15.6 }, midsummer, 3600);
    assert.equal(day.continuous, true);
  });

  it('expects recordings in the coverage grid on both sides of midnight', () => {
    const config = scheduled({ audioTriggerTimes: [{ startSecond: h(21), endSecond: h(27) }] });
    assert.equal(expectationFor('2026-04-02T02:00:00.000Z', config, 'UTC'), 'scheduled');
    assert.equal(expectationFor('2026-04-02T22:00:00.000Z', config, 'UTC'), 'scheduled');
    assert.equal(expectationFor('2026-04-02T12:00:00.000Z', config, 'UTC'), 'idle');
  });

  it('expects the solar periods in the coverage grid, not the fallback', () => {
    const config: DeploymentConfig = { ...scheduled(dawn), ...nashville, timezone: 'America/Chicago' };
    // Civil dawn in Nashville in early April is around 06:10 CDT, 11:10 UTC.
    assert.equal(expectationFor('2026-04-05T11:00:00.000Z', config, 'America/Chicago'), 'scheduled');
    // 05:00 CDT is inside the fallback period but well before dawn.
    assert.equal(expectationFor('2026-04-05T10:00:00.000Z', config, 'America/Chicago'), 'idle');
  });
});

describe('daylight saving', () => {
  // Chicago falls back from CDT to CST at 02:00 local on 1 November 2026.
  const autumn = (overrides: Partial<DeploymentConfig> = {}): DeploymentConfig => ({
    ...defaultConfig('America/Chicago', new Date('2026-09-01T00:00:00.000Z')),
    deviceLabel: 'OWL-01',
    timezone: 'America/Chicago',
    startTime: '2026-10-01T05:00:00.000Z',
    endTime: '2026-11-15T06:00:00.000Z',
    phases: [{ ...defaultPhase(), audioRecordingMode: 'SCHEDULED', audioTriggerTimes: [{ startSecond: h(6), endSecond: h(8) }] }],
    ...overrides,
  });

  it('finds the change, to the minute', () => {
    const changes = offsetChanges('America/Chicago', Date.parse('2026-10-01T05:00:00Z'), Date.parse('2026-11-15T06:00:00Z'));
    assert.equal(changes.length, 1);
    assert.equal(new Date(changes[0].at).toISOString(), '2026-11-01T07:00:00.000Z');
    assert.equal(changes[0].offsetBeforeSeconds, -5 * 3600);
    assert.equal(changes[0].offsetAfterSeconds, -6 * 3600);
  });

  it('only offers the adjustment when a clock-time period would move', () => {
    assert.equal(dstChangesAffectingSchedule(autumn()).length, 1);
    const continuous = autumn({ phases: [{ ...defaultPhase(), audioRecordingMode: 'CONTINUOUS' }] });
    assert.equal(dstChangesAffectingSchedule(continuous).length, 0);
    const summer = autumn({ endTime: '2026-10-20T05:00:00.000Z' });
    assert.equal(dstChangesAffectingSchedule(summer).length, 0);
  });

  it('writes one phase per side of the change, the later one shifted onto the device clock', () => {
    const text = serializeConfig(autumn());
    assert.match(text, /DST_ADJUSTED = "True"/);
    assert.match(text, /PHASED_DEPLOYMENT = "True"/);
    // 06:00 CST is 07:00 on a device still running on CDT.
    assert.deepEqual(entries(text), [`${h(6)}-${h(8)}`, `${h(7)}-${h(9)}`]);
  });

  it('reads the pieces back as the one unphased deployment that was entered', () => {
    const parsed = parseConfig(serializeConfig(autumn())).config;
    assert.equal(parsed.isPhased, false);
    assert.equal(parsed.phases.length, 1);
    assert.deepEqual(parsed.phases[0].audioTriggerTimes, [{ startSecond: h(6), endSecond: h(8) }]);
    assert.equal(parsed.adjustForDst, true);
  });

  it('leaves the schedule on one offset when the adjustment is off', () => {
    const text = serializeConfig(autumn({ adjustForDst: false }));
    assert.doesNotMatch(text, /DST_ADJUSTED/);
    assert.deepEqual(entries(text), [`${h(6)}-${h(8)}`]);
    // And a card like that is reviewed as having run unadjusted.
    assert.equal(parseConfig(text).config.adjustForDst, false);
  });

  it('shifts a period across midnight when the change pushes it there', () => {
    const text = serializeConfig(autumn({ phases: [{ ...defaultPhase(), audioRecordingMode: 'SCHEDULED', audioTriggerTimes: [{ startSecond: h(22, 30), endSecond: h(23, 30) }] }] }));
    // The CDT phase first, then the CST phase, whose period now straddles midnight.
    assert.deepEqual(entries(text), [`${h(22, 30)}-${h(23, 30)}`, `0-${h(0, 30)}`, `${h(23, 30)}-86400`]);
    const parsed = parseConfig(text).config;
    assert.deepEqual(parsed.phases[0].audioTriggerTimes, [{ startSecond: h(22, 30), endSecond: h(23, 30) }]);
  });
});

describe('solar periods across midnight and back to front', () => {
  const far = { latitude: 64.8, longitude: -147.7, timezone: 'America/Anchorage', startTime: '2026-06-01T08:00:00.000Z' };

  it('keeps a period that runs past midnight, as one period past 86 400', () => {
    // Dusk in Nashville is around 20:30 in June, so six hours after it is the next morning.
    const phase = {
      ...defaultPhase(),
      audioRecordingMode: 'SCHEDULED' as const,
      audioScheduleType: 'SOLAR' as const,
      audioSolarWindows: [{ startAnchor: 'DUSK' as const, startOffsetSeconds: 0, endAnchor: 'DUSK' as const, endOffsetSeconds: 6 * 3600 }],
    };
    const nashville = { latitude: 36.16, longitude: -86.78 };
    const day = scheduleOnDay(phase, nashville, Date.parse('2026-06-10T17:00:00Z') / 1000, -5 * 3600);
    assert.equal(day.reversed, 0);
    assert.equal(day.periods.length, 1);
    assert.ok(day.periods[0].endSecond > 86400, `period ${JSON.stringify(day.periods[0])}`);
    assert.equal(day.periods[0].endSecond - day.periods[0].startSecond, 6 * 3600);
  });

  it('counts a period that ends before it starts instead of dropping it quietly', () => {
    const phase = {
      ...defaultPhase(),
      audioRecordingMode: 'SCHEDULED' as const,
      audioScheduleType: 'SOLAR' as const,
      audioSolarWindows: [{ startAnchor: 'SUNSET' as const, startOffsetSeconds: 0, endAnchor: 'SUNSET' as const, endOffsetSeconds: -3600 }],
    };
    const day = scheduleOnDay(phase, far, Date.parse('2026-06-10T20:00:00Z') / 1000, -8 * 3600);
    assert.equal(day.reversed, 1);
    const reports = solarPeriodReports(phase, far, Date.parse('2026-06-01T08:00:00Z'), Date.parse('2026-06-30T08:00:00Z'));
    assert.equal(reports[0].reversedDays, reports[0].daysChecked);
  });
});
