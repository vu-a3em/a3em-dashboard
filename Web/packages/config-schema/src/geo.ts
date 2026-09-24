/**
 * Where a device was, from the positions its log recorded.
 *
 * Deliberately no basemap and no mapping library. Configuration and review have to work
 * at a field station with no connectivity, and a map that renders as gray squares when
 * it matters most is worse than one that never promised tiles. What a plain plot with a
 * scale bar answers — did the device move, how far, and when — is most of what these
 * positions are good for anyway.
 *
 * A caution that applies to everything here: no A3EM log containing a real GPS fix has
 * been available. The parser nulls the `[0, 0, 0]` a GPS-less device writes, so this
 * code has only ever been exercised against synthetic positions.
 */

export interface Fix {
  timestamp: string;
  latitude: number;
  longitude: number;
  altitudeM: number | null;
}

export interface TrackBounds {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
  centerLatitude: number;
  centerLongitude: number;
  /** Width and height of the bounding box on the ground. */
  widthMeters: number;
  heightMeters: number;
}

export interface Track {
  fixes: Fix[];
  bounds: TrackBounds | null;
  /** Straight-line distance between the first and last fix. */
  displacementMeters: number;
  /** Distance along the path, which exceeds displacement whenever it doubles back. */
  pathMeters: number;
  /**
   * True when every fix sits within `stationaryRadiusMeters` of the center.
   *
   * Worth stating rather than leaving to the eye: a stationary device's scatter is GPS
   * error, and drawing it zoomed to its own extent makes a few meters of noise look
   * like a journey.
   */
  stationary: boolean;
}

export const EARTH_RADIUS_METERS = 6_371_008.8;

/** Below this much spread, the movement shown is receiver error rather than travel. */
export const STATIONARY_RADIUS_METERS = 30;

/** Great-circle distance between two positions, in meters. */
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const phi1 = toRadians(a.latitude);
  const phi2 = toRadians(b.latitude);
  const deltaPhi = toRadians(b.latitude - a.latitude);
  const deltaLambda = toRadians(b.longitude - a.longitude);

  const h =
    Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Assembles a track from telemetry, dropping anything without a position.
 *
 * A device without GPS logs `[0, 0, 0]` on every line, which the log parser turns into
 * nulls. Those are absences, not a position off the coast of Africa.
 */
export function buildTrack(
  samples: Array<{ timestamp: string; latitude: number | null; longitude: number | null; altitudeM: number | null }>,
): Track {
  const fixes: Fix[] = [];
  for (const sample of samples) {
    if (sample.latitude === null || sample.longitude === null) continue;
    if (!Number.isFinite(sample.latitude) || !Number.isFinite(sample.longitude)) continue;
    // Outside these a value is corrupt rather than remote.
    if (Math.abs(sample.latitude) > 90 || Math.abs(sample.longitude) > 180) continue;
    fixes.push({
      timestamp: sample.timestamp,
      latitude: sample.latitude,
      longitude: sample.longitude,
      altitudeM: sample.altitudeM,
    });
  }
  fixes.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (fixes.length === 0) {
    return { fixes, bounds: null, displacementMeters: 0, pathMeters: 0, stationary: true };
  }

  const latitudes = fixes.map((fix) => fix.latitude);
  const longitudes = fixes.map((fix) => fix.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const centerLatitude = (minLatitude + maxLatitude) / 2;
  const centerLongitude = (minLongitude + maxLongitude) / 2;

  let pathMeters = 0;
  for (let i = 1; i < fixes.length; i++) pathMeters += distanceMeters(fixes[i - 1], fixes[i]);

  const furthest = Math.max(
    ...fixes.map((fix) => distanceMeters(fix, { latitude: centerLatitude, longitude: centerLongitude })),
  );

  return {
    fixes,
    bounds: {
      minLatitude,
      maxLatitude,
      minLongitude,
      maxLongitude,
      centerLatitude,
      centerLongitude,
      widthMeters: distanceMeters(
        { latitude: centerLatitude, longitude: minLongitude },
        { latitude: centerLatitude, longitude: maxLongitude },
      ),
      heightMeters: distanceMeters(
        { latitude: minLatitude, longitude: centerLongitude },
        { latitude: maxLatitude, longitude: centerLongitude },
      ),
    },
    displacementMeters: distanceMeters(fixes[0], fixes[fixes.length - 1]),
    pathMeters,
    stationary: furthest <= STATIONARY_RADIUS_METERS,
  };
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

/**
 * Projects fixes into a unit square, north up and east right.
 *
 * Longitude is scaled by the cosine of the center latitude so a meter east and a meter
 * north occupy the same distance on screen. Without that, a track at high latitude comes
 * out stretched sideways and a straight walk looks like a diagonal.
 *
 * Equirectangular, which is wrong over continental distances and irrelevantly so over the
 * hundreds of meters a deployment spans.
 */
export function projectTrack(track: Track, padding = 0.06): ProjectedPoint[] {
  if (!track.bounds || track.fixes.length === 0) return [];
  const { centerLatitude, minLatitude, maxLatitude, minLongitude, maxLongitude } = track.bounds;

  const scale = Math.cos(toRadians(centerLatitude));
  const spanY = Math.max(1e-9, maxLatitude - minLatitude);
  const spanX = Math.max(1e-9, (maxLongitude - minLongitude) * scale);
  // One span for both axes keeps the aspect ratio honest; the shorter one sits centered.
  const span = Math.max(spanX, spanY);
  const usable = 1 - padding * 2;

  return track.fixes.map((fix) => ({
    x: padding + ((fix.longitude - minLongitude) * scale - spanX / 2 + span / 2) / span * usable,
    // Screen y grows downward while latitude grows north, so this inverts.
    y: padding + (1 - ((fix.latitude - minLatitude) - spanY / 2 + span / 2) / span) * usable,
  }));
}

/** A round distance suitable for a scale bar, and how wide it is as a fraction of the plot. */
export function scaleBar(track: Track, padding = 0.06): { meters: number; fraction: number } | null {
  if (!track.bounds) return null;
  const span = Math.max(track.bounds.widthMeters, track.bounds.heightMeters);
  if (span <= 0) return null;

  // Aim for roughly a quarter of the plot, rounded to something a person reads easily.
  const target = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const meters = [1, 2, 5, 10].map((step) => step * magnitude).find((value) => value >= target) ?? magnitude * 10;
  return { meters, fraction: (meters / span) * (1 - padding * 2) };
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
