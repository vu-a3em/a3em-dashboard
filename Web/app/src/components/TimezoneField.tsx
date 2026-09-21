import { useMemo } from 'react';
import { isValidTimezone, supportedTimezones } from '@a3em/config-schema';

/**
 * Timezone entry with type-ahead.
 *
 * A plain select renders all ~400 IANA zones as a flat list, which is unusable for
 * finding one. A datalist gives native filtering while still accepting any valid zone.
 */
export function TimezoneField({
  value,
  onChange,
}: Readonly<{ value: string; onChange: (timezone: string) => void }>) {
  const zones = useMemo(() => supportedTimezones(), []);
  const valid = isValidTimezone(value);

  return (
    <div className="field">
      <label htmlFor="tz">Timezone</label>
      <input
        id="tz"
        list="timezone-options"
        value={value}
        aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Start typing a region or city"
      />
      <datalist id="timezone-options">
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      <p className="help">
        {valid
          ? "Resolves the UTC offset at the deployment site."
          : 'Not a recognized timezone. Type a region and city, such as Africa/Nairobi.'}
      </p>
    </div>
  );
}
