import { applyCorrection, formatZonedDisplay, type ClockCorrection } from '@a3em/config-schema';

/**
 * A time from the card, as a person should read it.
 *
 * Two corrections, both easy to forget and each wrong on its own:
 *
 *  - the device's clock was off by whatever the correction says, so the raw value is not
 *    when the thing happened;
 *  - and the result is an instant, which rendered by slicing an ISO string shows UTC —
 *    not the local time at the deployment site the reader is thinking in.
 *
 * Every device-derived timestamp on the review, listen and copy screens goes through
 * here so the two can never be applied to some values and not others.
 */
export function deviceTime(
  iso: string | null | undefined,
  correction: ClockCorrection | null,
  timezone: string,
): string {
  if (!iso) return '—';
  return formatZonedDisplay(correction ? applyCorrection(iso, correction) : iso, timezone);
}

/**
 * The same, for a value the correction has ALREADY been applied to.
 *
 * Coverage grids and clip lists correct their times when they are built, so passing them
 * through `deviceTime` would apply the offset twice.
 */
export function zonedTime(iso: string | null | undefined, timezone: string): string {
  return iso ? formatZonedDisplay(iso, timezone) : '—';
}

/**
 * Just the clock face of an already-corrected time, for a list already grouped by day.
 *
 * The date is the group heading, so repeating it on every row is noise — but the hour
 * still has to be the deployment's, not UTC.
 */
export function zonedClock(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}

/** The calendar date an instant falls on at the deployment site, as `YYYY-MM-DD`. */
export function localDateKey(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  return parts;
}
