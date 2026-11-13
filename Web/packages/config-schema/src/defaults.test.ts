import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_DEPLOYMENT_YEARS, defaultConfig, moveDeploymentStart } from './defaults.js';
import { toZonedInput } from './timezone.js';

const CHICAGO = 'America/Chicago';
const local = (iso: string, timezone = CHICAGO) => toZonedInput(iso, timezone);

describe('a new deployment', () => {
  it('starts at the coming local midnight and ends five years later on the same local date', () => {
    const config = defaultConfig(CHICAGO, new Date('2026-11-13T18:00:00.000Z'));
    assert.equal(DEFAULT_DEPLOYMENT_YEARS, 5);
    assert.equal(local(config.startTime), '2026-11-14T00:00');
    assert.equal(local(config.endTime), '2031-11-14T00:00');
  });

  it('keeps the beacon on the end it defaults to', () => {
    const config = defaultConfig(CHICAGO, new Date('2026-11-13T18:00:00.000Z'));
    assert.equal(config.vhfStartTime, config.endTime);
  });

  it('ends on 28 February when it starts on a 29th the end year does not have', () => {
    const config = defaultConfig('UTC', new Date('2028-02-28T12:00:00.000Z'));
    assert.equal(config.startTime, '2028-02-29T00:00:00.000Z');
    assert.equal(config.endTime, '2033-02-28T00:00:00.000Z');
  });

  it('still ends five years out when the zone cannot be read', () => {
    const config = defaultConfig('Not/AZone', new Date('2026-11-13T18:00:00.000Z'));
    assert.equal(config.startTime, '2026-11-14T00:00:00.000Z');
    assert.equal(config.endTime, '2031-11-14T00:00:00.000Z');
  });
});

describe('moving the start of a deployment', () => {
  const config = { timezone: CHICAGO, endTime: '2026-11-28T06:00:00.000Z' }; // 28 Nov 2026, 00:00 local

  it('leaves an end that is still after the new start alone', () => {
    const moved = moveDeploymentStart(config, '2026-11-20T06:00:00.000Z');
    assert.deepEqual(moved, { startTime: '2026-11-20T06:00:00.000Z', endTime: config.endTime });
  });

  it('moves a passed end to the same local date and time, five years after the start', () => {
    const moved = moveDeploymentStart(config, '2026-12-01T06:00:00.000Z');
    assert.equal(local(moved.endTime), '2031-11-28T00:00');
  });

  it('moves an end the start now equals, since that deployment would run for no time at all', () => {
    assert.equal(local(moveDeploymentStart(config, config.endTime).endTime), '2031-11-28T00:00');
  });

  it("counts the five years from the start's year, not the end's", () => {
    const moved = moveDeploymentStart(config, '2030-01-05T06:00:00.000Z');
    assert.equal(local(moved.endTime), '2035-11-28T00:00');
  });

  it("reads the start's year on the deployment's clock", () => {
    // 03:00 UTC on 1 January is still New Year's Eve in Chicago.
    const moved = moveDeploymentStart(
      { timezone: CHICAGO, endTime: '2026-12-15T06:00:00.000Z' },
      '2027-01-01T03:00:00.000Z',
    );
    assert.equal(local(moved.endTime), '2031-12-15T00:00');
  });

  it('keeps the local time of day across a daylight-saving difference', () => {
    // 1 March is on standard time; the July start is on daylight time.
    const moved = moveDeploymentStart(
      { timezone: CHICAGO, endTime: '2026-03-01T15:00:00.000Z' },
      '2027-07-01T05:00:00.000Z',
    );
    assert.equal(local(moved.endTime), '2032-03-01T09:00');
  });
});
