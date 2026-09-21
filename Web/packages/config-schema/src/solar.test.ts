import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isValidPosition, solarDay, solarDayAt } from './solar.js';

const at = (iso: string) => Date.parse(iso) / 1000;
/** "HH:MM" from seconds past local midnight, which is how published sunrise tables read. */
const hm = (seconds: number) =>
  `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;

describe('sunrise and sunset against published times', () => {
  /*
    Checked against the times NOAA's own calculator gives for these positions and dates, and
    separately against the FIRMWARE: `a3em-firmware/src/app/solar.c` is compiled on the host
    and compared with this implementation across several hundred random positions and dates.
    That cross-check is what makes it safe for the dashboard to claim it knows what the device
    will do; these cases are the human-readable half of it.
  */
  const cases = [
    { name: 'London, midsummer', iso: '2024-06-21T12:00:00Z', latitude: 51.5074, longitude: -0.1278, offset: 3600, sunrise: '04:43', sunset: '21:21' },
    { name: 'London, midwinter', iso: '2024-12-21T12:00:00Z', latitude: 51.5074, longitude: -0.1278, offset: 0, sunrise: '08:04', sunset: '15:53' },
    { name: 'Nairobi, equinox', iso: '2024-09-19T12:00:00Z', latitude: -1.2921, longitude: 36.8219, offset: 10800, sunrise: '06:23', sunset: '18:29' },
    { name: 'Colorado, midsummer', iso: '2026-06-01T12:00:00Z', latitude: 40.5, longitude: -105.1, offset: -21600, sunrise: '05:32', sunset: '20:24' },
  ];

  for (const site of cases) {
    it(`matches at ${site.name}`, () => {
      const day = solarDay(at(site.iso), { latitude: site.latitude, longitude: site.longitude }, site.offset);
      assert.equal(hm(day.secondsOfDay.SUNRISE), site.sunrise);
      assert.equal(hm(day.secondsOfDay.SUNSET), site.sunset);
    });
  }

  it('puts civil twilight either side of the sun itself', () => {
    const day = solarDay(at('2024-06-21T12:00:00Z'), { latitude: 51.5074, longitude: -0.1278 }, 3600);
    assert.ok(day.secondsOfDay.DAWN < day.secondsOfDay.SUNRISE);
    assert.ok(day.secondsOfDay.DUSK > day.secondsOfDay.SUNSET);
  });

  it('tracks the season, which is the whole reason the device recomputes', () => {
    // The drift a fixed schedule would suffer. Over 2.5 hours at this latitude, which is why
    // resolving once at configuration time was not good enough.
    const position = { latitude: 51.5074, longitude: -0.1278 };
    const june = solarDay(at('2026-06-21T12:00:00Z'), position, 0);
    const december = solarDay(at('2026-12-21T12:00:00Z'), position, 0);
    const drift = (december.secondsOfDay.SUNRISE - june.secondsOfDay.SUNRISE) / 3600;
    assert.ok(drift > 2.5, `midwinter sunrise is only ${drift} h later than midsummer`);
  });
});

describe('latitudes where the sun does not rise or set', () => {
  // Not hypothetical: the caribou deployments sit above the Arctic circle.
  const tromso = { latitude: 69.6492, longitude: 18.9553 };

  it('reports a polar day rather than inventing a sunrise', () => {
    const day = solarDay(at('2024-06-21T12:00:00Z'), tromso, 7200);
    assert.equal(day.available.SUNRISE, false);
    assert.equal(day.available.SUNSET, false);
    assert.equal(day.polarDay, true);
    assert.equal(day.polarNight, false);
  });

  it('tells a polar night apart from a polar day', () => {
    const day = solarDay(at('2024-12-21T12:00:00Z'), tromso, 3600);
    assert.equal(day.available.SUNRISE, false);
    assert.equal(day.polarNight, true);
    assert.equal(day.polarDay, false);
    // The sun still climbs to within 6 degrees of the horizon here in late December, so civil
    // twilight happens even though sunrise does not. A schedule must not assume that "no
    // sunrise" means "no light" — the firmware skips windows anchor by anchor for this reason.
    assert.equal(day.available.DAWN, true);
    assert.equal(day.available.DUSK, true);
  });
});

describe('agreeing with the device on what a day looks like', () => {
  it('folds every anchor onto the local day', () => {
    // `solar_compute()` wraps into [0, 86400) before the schedule ever sees a value, so a
    // window resolved here can be compared against one resolved on the device.
    for (const longitude of [-179, -90, 0, 90, 179]) {
      for (const offset of [-43200, -18000, 0, 19800, 46800]) {
        const day = solarDay(at('2026-04-15T12:00:00Z'), { latitude: 20, longitude }, offset);
        for (const anchor of ['DAWN', 'SUNRISE', 'SUNSET', 'DUSK'] as const) {
          if (!day.available[anchor]) continue;
          const seconds = day.secondsOfDay[anchor];
          assert.ok(seconds >= 0 && seconds < 86400, `${longitude}/${offset} ${anchor} = ${seconds}`);
        }
      }
    }
  });

  it('resolves a zone name to the fixed offset the device would be given', () => {
    const position = { latitude: -1.2921, longitude: 36.8219 };
    const viaZone = solarDayAt('2024-09-19T12:00:00Z', position, 'Africa/Nairobi');
    const viaOffset = solarDay(at('2024-09-19T12:00:00Z'), position, 10800);
    assert.deepEqual(viaZone, viaOffset);
  });
});

describe('rejecting positions that are not positions', () => {
  it('refuses out-of-range and non-finite coordinates', () => {
    assert.equal(isValidPosition({ latitude: 91, longitude: 0 }), false);
    assert.equal(isValidPosition({ latitude: 0, longitude: 181 }), false);
    assert.equal(isValidPosition({ latitude: Number.NaN, longitude: 0 }), false);
    assert.equal(isValidPosition({ latitude: 0, longitude: 0 }), true);
  });

  it('returns nothing available rather than NaNs for a bad position', () => {
    // A NaN reaching a schedule would surface as a device recording at nonsensical times
    // rather than as one reporting it cannot anchor to the sun.
    const day = solarDay(at('2024-06-21T12:00:00Z'), { latitude: Number.NaN, longitude: 0 }, 0);
    assert.equal(day.available.SUNRISE, false);
    assert.equal(day.available.DUSK, false);
  });
});
