import type { SolarAnchor } from './firmware-constants.js';
import { utcOffsetSecondsAt } from './timezone.js';

/**
 * Sunrise, sunset and civil twilight for a position and date.
 *
 * A MIRROR of `a3em-firmware/src/app/solar.c`, which is where the authoritative version now
 * lives. The device recomputes its own schedule every local day, so a three-month deployment
 * tracks the season instead of drifting an hour away from the dawn it was configured for.
 *
 * This copy exists so the dashboard can say, before the card is written, exactly what the
 * device will do — which windows it will record, and where it will find no sunrise to anchor
 * to at all. Both implementations work in double precision and share every constant, and a
 * cross-check compiles the C and compares it against this across hundreds of positions and
 * dates. If the two ever disagree, the dashboard is lying about the device, so they are kept
 * line-for-line alike even where more idiomatic TypeScript was available.
 *
 * The algorithm is NOAA's, the one behind their public solar calculator. It is accurate to
 * about a minute in the mid-latitudes, which is far finer than a recording window needs,
 * and it degrades honestly at high latitude: above the Arctic circle in summer there IS no
 * sunrise, and the anchor reports itself unavailable rather than returning a fabricated
 * time. That case is not hypothetical here — caribou deployments sit well inside it.
 */

/** Solar zenith at apparent sunrise/sunset: 90 degrees plus refraction and the solar radius. */
const ZENITH_SUNRISE_DEG = 90.833;
/** Civil twilight: the sun 6 degrees below the horizon, when the chorus is already underway. */
const ZENITH_CIVIL_DEG = 96;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/** Latitude and longitude in signed degrees, north and east positive. */
export interface Position {
  latitude: number;
  longitude: number;
}

export function isValidPosition(position: Position): boolean {
  return (
    Number.isFinite(position.latitude) &&
    Number.isFinite(position.longitude) &&
    Math.abs(position.latitude) <= 90 &&
    Math.abs(position.longitude) <= 180
  );
}

/** The anchors in the order `solar.c` indexes them, which is the order they are iterated in. */
const ANCHOR_ORDER = ['DAWN', 'SUNRISE', 'SUNSET', 'DUSK'] as const satisfies readonly SolarAnchor[];

export interface SolarDay {
  /** Whether the sun reaches that altitude at all on this date at this position. */
  available: Record<SolarAnchor, boolean>;
  /** Seconds past local midnight, already folded into [0, 86400). */
  secondsOfDay: Record<SolarAnchor, number>;
  /**
   * The same instants UNFOLDED — relative to local midnight but free to run below zero or past
   * 86 400 — so the anchors stay in chronological order. A window from one anchor to another
   * can only be recognized as running past midnight while its two ends are in this form.
   */
  secondsFromMidnight: Record<SolarAnchor, number>;
  polarDay: boolean;
  polarNight: boolean;
}

/**
 * What the DEVICE will compute, given the same inputs the device has.
 *
 * Takes a fixed UTC offset rather than a zone name because that is all the firmware gets:
 * `DEVICE_TIMEZONE` is written as offsets, and `config_get_utc_offset_seconds()` returns one
 * number. Predicting the device means accepting the same limitation, daylight saving
 * included — a deployment that crosses a DST boundary runs on the offset it was given, and
 * this reports that honestly instead of quietly being more correct than the hardware.
 *
 * Line-for-line equivalent to `solar_compute()`. Changes here belong in both files.
 */
export function solarDay(
  utcTimestampSeconds: number,
  position: Position,
  utcOffsetSeconds: number,
): SolarDay {
  const empty: SolarDay = {
    available: { DAWN: false, SUNRISE: false, SUNSET: false, DUSK: false },
    secondsOfDay: { DAWN: 0, SUNRISE: 0, SUNSET: 0, DUSK: 0 },
    secondsFromMidnight: { DAWN: 0, SUNRISE: 0, SUNSET: 0, DUSK: 0 },
    polarDay: false,
    polarNight: false,
  };
  if (!isValidPosition(position) || !Number.isFinite(utcTimestampSeconds)) return empty;

  // The LOCAL day this instant falls in, because the schedule the device reads is in local
  // seconds-of-day. Floor division, not truncation: `Math.trunc` puts a negative local
  // timestamp on the wrong day.
  const localTimestamp = utcTimestampSeconds + utcOffsetSeconds;
  const localDay = Math.floor(localTimestamp / 86400);
  const localMidnightUtc = localDay * 86400 - utcOffsetSeconds;

  // NOAA's series is anchored to UTC midnight, so work from the UTC day containing local noon.
  const utcDay = Math.floor((localMidnightUtc + 43200) / 86400);
  const julianDay = utcDay + 2_440_587.5;

  const result: SolarDay = {
    available: { ...empty.available },
    secondsOfDay: { ...empty.secondsOfDay },
    secondsFromMidnight: { ...empty.secondsFromMidnight },
    polarDay: false,
    polarNight: false,
  };

  for (const anchor of ANCHOR_ORDER) {
    const minutes = eventMinutesUtc(julianDay, position, ANCHOR_ZENITH[anchor], ANCHOR_RISING[anchor]);
    if (minutes === null) continue;

    const eventUtc = utcDay * 86400 + Math.floor(minutes * 60 + 0.5);
    const unfolded = eventUtc + utcOffsetSeconds - localDay * 86400;
    result.secondsFromMidnight[anchor] = unfolded;
    let secondsOfDay = unfolded % 86400;
    if (secondsOfDay < 0) secondsOfDay += 86400;

    result.secondsOfDay[anchor] = secondsOfDay;
    result.available[anchor] = true;
  }

  if (!result.available.SUNRISE && !result.available.SUNSET) {
    const noonAltitude = 90 - Math.abs(position.latitude - solarDeclinationDeg(julianCentury(julianDay + 0.5)));
    result.polarDay = noonAltitude > 90 - ZENITH_SUNRISE_DEG;
    result.polarNight = !result.polarDay;
  }

  return result;
}

/** `solarDay` for an ISO instant and an IANA zone, resolving the offset the device would be given. */
export function solarDayAt(instant: string | Date, position: Position, timezone: string): SolarDay {
  const iso = typeof instant === 'string' ? instant : instant.toISOString();
  const seconds = Date.parse(iso) / 1000;
  if (!Number.isFinite(seconds)) {
    return solarDay(Number.NaN, position, 0);
  }
  return solarDay(seconds, position, utcOffsetSecondsAt(timezone, iso));
}

const ANCHOR_ZENITH: Record<SolarAnchor, number> = {
  DAWN: ZENITH_CIVIL_DEG,
  SUNRISE: ZENITH_SUNRISE_DEG,
  SUNSET: ZENITH_SUNRISE_DEG,
  DUSK: ZENITH_CIVIL_DEG,
};
const ANCHOR_RISING: Record<SolarAnchor, boolean> = {
  DAWN: true,
  SUNRISE: true,
  SUNSET: false,
  DUSK: false,
};

// ---------------------------------------------------------------------------
// NOAA's solar position series. Transcribed from their published calculator.
// ---------------------------------------------------------------------------

const julianCentury = (julianDay: number) => (julianDay - 2_451_545) / 36_525;

function solarDeclinationDeg(t: number): number {
  return toDegrees(Math.asin(Math.sin(toRadians(obliquityCorrectedDeg(t))) * Math.sin(toRadians(apparentLongitudeDeg(t)))));
}

function geomMeanLongSunDeg(t: number): number {
  const l = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  return l < 0 ? l + 360 : l;
}

const geomMeanAnomalySunDeg = (t: number) => 357.52911 + t * (35999.05029 - 0.0001537 * t);

const eccentricityEarthOrbit = (t: number) => 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

function sunEqOfCenterDeg(t: number): number {
  const m = toRadians(geomMeanAnomalySunDeg(t));
  return (
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289
  );
}

function apparentLongitudeDeg(t: number): number {
  const trueLong = geomMeanLongSunDeg(t) + sunEqOfCenterDeg(t);
  return trueLong - 0.00569 - 0.00478 * Math.sin(toRadians(125.04 - 1934.136 * t));
}

function obliquityCorrectedDeg(t: number): number {
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  const e0 = 23 + (26 + seconds / 60) / 60;
  return e0 + 0.00256 * Math.cos(toRadians(125.04 - 1934.136 * t));
}

/** Minutes by which true solar time runs ahead of mean solar time. */
function equationOfTimeMinutes(t: number): number {
  const epsilon = toRadians(obliquityCorrectedDeg(t));
  const l0 = toRadians(geomMeanLongSunDeg(t));
  const m = toRadians(geomMeanAnomalySunDeg(t));
  const e = eccentricityEarthOrbit(t);
  const y = Math.tan(epsilon / 2) ** 2;

  return (
    4 *
    toDegrees(
      y * Math.sin(2 * l0) -
        2 * e * Math.sin(m) +
        4 * e * y * Math.sin(m) * Math.cos(2 * l0) -
        0.5 * y * y * Math.sin(4 * l0) -
        1.25 * e * e * Math.sin(2 * m),
    )
  );
}

/**
 * The hour angle at which the sun reaches `zenithDeg`, in degrees, or null where it never does.
 *
 * The null is the polar case and the whole reason this returns a nullable: `Math.acos` of
 * anything outside [-1, 1] is NaN, and a NaN propagating into a recording schedule would
 * surface as an unreadable config rather than as "this latitude has no sunrise today".
 */
function hourAngleDeg(latitudeDeg: number, declinationDeg: number, zenithDeg: number): number | null {
  const lat = toRadians(latitudeDeg);
  const dec = toRadians(declinationDeg);
  const cosH = Math.cos(toRadians(zenithDeg)) / (Math.cos(lat) * Math.cos(dec)) - Math.tan(lat) * Math.tan(dec);
  if (cosH > 1 || cosH < -1) return null;
  return toDegrees(Math.acos(cosH));
}

/**
 * Minutes after 00:00 UTC at which the event occurs.
 *
 * Solved twice. The solar position depends on the time of the event, which is what is being
 * solved for, so the first pass uses the position at midnight and the second re-evaluates it
 * at the time the first pass produced. One refinement takes the error from minutes to well
 * under a second, and a third pass changes nothing a recording window could notice.
 */
function eventMinutesUtc(
  julianDay: number,
  position: Position,
  zenithDeg: number,
  rising: boolean,
): number | null {
  let minutes: number | null = null;

  for (let pass = 0; pass < 2; ++pass) {
    const t = julianCentury(julianDay + (minutes === null ? 0.5 : minutes / 1440));
    const hourAngle = hourAngleDeg(position.latitude, solarDeclinationDeg(t), zenithDeg);
    if (hourAngle === null) return null;
    const signed = rising ? hourAngle : -hourAngle;
    minutes = 720 - 4 * (position.longitude + signed) - equationOfTimeMinutes(t);
  }

  return minutes;
}
