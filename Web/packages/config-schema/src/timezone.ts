/**
 * Timezone helpers built on the platform's own IANA database via Intl, so the
 * package carries no timezone dependency and never drifts from the browser's
 * rules.
 */

/**
 * UTC offset in seconds for `timezone` at the given instant.
 *
 * Resolved AT THE INSTANT, not at "now". The desktop tool used the offset at the
 * moment of writing, which shifts every scheduled recording window by an hour
 * when a config is authored on one side of a DST boundary and deployed on the
 * other.
 */
export function utcOffsetSecondsAt(timezone: string, isoInstant: string): number {
  const instant = new Date(isoInstant);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`Invalid ISO 8601 timestamp: ${isoInstant}`);
  }
  const asZoned = Date.UTC(
    ...(dateParts(timezone, instant) as [number, number, number, number, number, number]),
  );
  // Intl reports whole seconds only; round to the nearest minute to absorb the
  // sub-minute historical offsets some zones carry (e.g. LMT before 1900).
  return Math.round((asZoned - instant.getTime()) / 1000 / 60) * 60;
}

/** Converts a local wall-clock time in `timezone` to an ISO instant. */
export function zonedWallClockToIso(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes converge for every real zone: the first correction can land on the
  // wrong side of a DST transition, the second settles it.
  let instant = naive - guessOffsetMs(timezone, naive);
  instant = naive - guessOffsetMs(timezone, instant);
  return new Date(instant).toISOString();
}

/** Seconds past local midnight for an instant, used for AUDIO_TRIGGER_SCHEDULE. */
export function secondsPastLocalMidnight(timezone: string, isoInstant: string): number {
  const [, , , hour, minute, second] = dateParts(timezone, new Date(isoInstant));
  return hour * 3600 + minute * 60 + second;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** IANA zone list when the runtime exposes it, else a small practical fallback. */
export function supportedTimezones(): string[] {
  const anyIntl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  if (typeof anyIntl.supportedValuesOf === 'function') {
    return anyIntl.supportedValuesOf('timeZone');
  }
  return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
}

function guessOffsetMs(timezone: string, instantMs: number): number {
  const d = new Date(instantMs);
  return (
    Date.UTC(...(dateParts(timezone, d) as [number, number, number, number, number, number])) -
    instantMs
  );
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateParts(timezone: string, date: Date): number[] {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  // Intl renders midnight as hour 24 in some engines.
  const hour = parts.hour === 24 ? 0 : parts.hour;
  return [parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second];
}

/**
 * The wall-clock reading a `<input type="datetime-local">` should show for an instant,
 * in the DEPLOYMENT's zone rather than the browser's.
 *
 * An ecologist in Nashville configuring a device bound for Kenya types the local time the
 * device will experience. Reading and writing those fields through the browser's own zone
 * silently shifted every deployment by the difference between the two — the config asked
 * for 03:00 Nairobi and the device was told 12:00 Nairobi.
 */
export function toZonedInput(isoInstant: string, timezone: string): string {
  const instant = new Date(isoInstant);
  if (Number.isNaN(instant.getTime())) throw new Error(`Invalid ISO 8601 timestamp: ${isoInstant}`);
  const [year, month, day, hour, minute] = dateParts(timezone, instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

/** The instant a wall-clock reading names in a given zone. Inverse of `toZonedInput`. */
export function fromZonedInput(value: string, timezone: string): string {
  const naive = Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`);
  if (Number.isNaN(naive)) throw new Error(`Invalid local date-time: ${value}`);
  // The offset depends on the instant and the instant depends on the offset, so the first
  // pass is an estimate. Re-reading the offset AT that estimate settles it, which matters
  // either side of a DST change where the two differ by an hour.
  const estimated = utcOffsetSecondsAt(timezone, new Date(naive).toISOString());
  const firstPass = naive - estimated * 1000;
  const settled = utcOffsetSecondsAt(timezone, new Date(firstPass).toISOString());
  return new Date(settled === estimated ? firstPass : naive - settled * 1000).toISOString();
}

/**
 * An instant rendered the way the `datetime-local` fields beside it read.
 *
 * The viewer's locale decides the ordering and whether it is 12- or 24-hour, exactly as
 * the browser decides for the input; the DEPLOYMENT's zone decides the wall clock. Showing
 * a reference time as a raw UTC ISO string next to an input read in deployment-local time
 * invited exactly the wrong comparison — enter a time four hours before the one displayed
 * and the correction came out as one hour, the difference being the zone offset.
 */
export function formatZonedDisplay(isoInstant: string, timezone: string): string {
  const instant = new Date(isoInstant);
  if (Number.isNaN(instant.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
}
