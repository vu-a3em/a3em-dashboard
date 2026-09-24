import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTrack, distanceMeters, projectTrack, scaleBar, STATIONARY_RADIUS_METERS } from './geo.js';

const sample = (timestamp: string, latitude: number | null, longitude: number | null, altitudeM: number | null = 100) => ({
  timestamp,
  latitude,
  longitude,
  altitudeM,
});

describe('distance between positions', () => {
  it('matches a known separation', () => {
    // One degree of latitude is about 111.2 km anywhere on the globe.
    const meters = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    assert.ok(Math.abs(meters - 111_195) < 100, `got ${meters}`);
  });

  it('narrows with latitude for a degree of longitude', () => {
    const atEquator = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
    const atSixty = distanceMeters({ latitude: 60, longitude: 0 }, { latitude: 60, longitude: 1 });
    assert.ok(Math.abs(atSixty / atEquator - 0.5) < 0.01, 'a degree of longitude halves by 60 degrees');
  });

  it('is zero for the same point', () => {
    assert.equal(distanceMeters({ latitude: 4.36, longitude: 18.55 }, { latitude: 4.36, longitude: 18.55 }), 0);
  });
});

describe('building a track', () => {
  it('drops positions the device never had', () => {
    // A GPS-less device logs [0, 0, 0] on every line; the parser nulls it. Those are
    // absences, not a position in the Atlantic.
    const track = buildTrack([
      sample('2026-04-01T00:00:00.000Z', null, null),
      sample('2026-04-01T01:00:00.000Z', 4.361, 18.555),
      sample('2026-04-01T02:00:00.000Z', null, null),
    ]);
    assert.equal(track.fixes.length, 1);
  });

  it('produces nothing at all for a card with no fixes', () => {
    const track = buildTrack([sample('2026-04-01T00:00:00.000Z', null, null)]);
    assert.equal(track.fixes.length, 0);
    assert.equal(track.bounds, null);
    assert.equal(track.stationary, true);
  });

  it('rejects impossible coordinates rather than plotting them', () => {
    const track = buildTrack([
      sample('2026-04-01T00:00:00.000Z', 91, 0),
      sample('2026-04-01T01:00:00.000Z', 0, 181),
      sample('2026-04-01T02:00:00.000Z', Number.NaN, 5),
      sample('2026-04-01T03:00:00.000Z', 4.361, 18.555),
    ]);
    assert.equal(track.fixes.length, 1);
  });

  it('orders fixes in time regardless of the order logged', () => {
    const track = buildTrack([
      sample('2026-04-01T05:00:00.000Z', 4.362, 18.555),
      sample('2026-04-01T01:00:00.000Z', 4.361, 18.555),
    ]);
    assert.equal(track.fixes[0].timestamp, '2026-04-01T01:00:00.000Z');
  });

  it('measures displacement and path length separately', () => {
    // Out and back: the device traveled, but ended where it started. Reporting only
    // one number would either hide the journey or invent a move that did not happen.
    const track = buildTrack([
      sample('2026-04-01T00:00:00.000Z', 4.36, 18.55),
      sample('2026-04-01T01:00:00.000Z', 4.37, 18.55),
      sample('2026-04-01T02:00:00.000Z', 4.36, 18.55),
    ]);
    assert.ok(track.displacementMeters < 1);
    assert.ok(track.pathMeters > 2000);
  });

  describe('telling a stationary device from a moving one', () => {
    it('calls receiver scatter stationary', () => {
      // A few meters of jitter around one point is GPS error. Zoomed to its own extent
      // it looks like a journey, so it has to be named for what it is.
      const track = buildTrack([
        sample('2026-04-01T00:00:00.000Z', 4.36, 18.55),
        sample('2026-04-01T01:00:00.000Z', 4.36004, 18.55003),
        sample('2026-04-01T02:00:00.000Z', 4.35997, 18.54998),
      ]);
      assert.equal(track.stationary, true);
    });

    it('calls a real move moving', () => {
      const track = buildTrack([
        sample('2026-04-01T00:00:00.000Z', 4.36, 18.55),
        sample('2026-04-01T01:00:00.000Z', 4.38, 18.57),
      ]);
      assert.equal(track.stationary, false);
      assert.ok(track.displacementMeters > STATIONARY_RADIUS_METERS);
    });
  });
});

describe('projecting a track for drawing', () => {
  const track = buildTrack([
    sample('2026-04-01T00:00:00.000Z', 4.36, 18.55),
    sample('2026-04-01T01:00:00.000Z', 4.37, 18.56),
  ]);

  it('keeps every point inside the plot', () => {
    for (const point of projectTrack(track)) {
      assert.ok(point.x >= 0 && point.x <= 1, `x ${point.x}`);
      assert.ok(point.y >= 0 && point.y <= 1, `y ${point.y}`);
    }
  });

  it('puts north at the top', () => {
    const [south, north] = projectTrack(track);
    assert.ok(north.y < south.y, 'the higher latitude should sit higher on screen');
  });

  it('keeps a meter north and a meter east the same size on screen', () => {
    // Without scaling longitude by the cosine of latitude, a track at high latitude comes
    // out stretched sideways and a straight walk looks like a diagonal.
    const square = buildTrack([
      sample('2026-04-01T00:00:00.000Z', 60, 0),
      // At 60 degrees a degree of longitude is half a degree of latitude on the ground,
      // so this pair spans the same distance each way.
      sample('2026-04-01T01:00:00.000Z', 60.01, 0.02),
    ]);
    const [a, b] = projectTrack(square);
    assert.ok(Math.abs(Math.abs(b.x - a.x) - Math.abs(b.y - a.y)) < 0.02);
  });

  it('returns nothing when there is nothing to draw', () => {
    assert.deepEqual(projectTrack(buildTrack([])), []);
  });

  it('survives every fix being identical', () => {
    const still = buildTrack([
      sample('2026-04-01T00:00:00.000Z', 4.36, 18.55),
      sample('2026-04-01T01:00:00.000Z', 4.36, 18.55),
    ]);
    for (const point of projectTrack(still)) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
  });
});

describe('the scale bar', () => {
  it('picks a round distance about a quarter of the plot', () => {
    const track = buildTrack([
      sample('2026-04-01T00:00:00.000Z', 4.36, 18.55),
      sample('2026-04-01T01:00:00.000Z', 4.37, 18.56),
    ]);
    const bar = scaleBar(track)!;
    assert.ok([1, 2, 5].includes(bar.meters / 10 ** Math.floor(Math.log10(bar.meters))));
    assert.ok(bar.fraction > 0 && bar.fraction < 1);
  });

  it('gives up when there is no extent to scale', () => {
    assert.equal(scaleBar(buildTrack([])), null);
  });
});
