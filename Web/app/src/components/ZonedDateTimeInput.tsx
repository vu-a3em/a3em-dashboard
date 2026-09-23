import { useState, type InputHTMLAttributes } from 'react';
import { fromZonedInput, toZonedInput } from '@a3em/config-schema';

/**
 * A `datetime-local` field that reads and writes an instant in the DEPLOYMENT's zone.
 *
 * Typed text is held here until it names a real date, and only then committed. Committing
 * every keystroke was what made the year impossible to type: the first digit of "2027" is a
 * complete value of year 0002, which went through the zone conversion — LMT offsets and all —
 * and came back as a different value, and the browser's segment editor then carried on from
 * wherever that left it, arriving at years like 3796.
 */
const EARLIEST_YEAR = 2000;
/** The device keeps time in a 32-bit time_t, so nothing after January 2038 can be scheduled. */
const LATEST_YEAR = 2038;

export function ZonedDateTimeInput({
  value,
  timezone,
  onChange,
  ...rest
}: Readonly<
  {
    /** ISO instant. */
    value: string;
    timezone: string;
    onChange: (iso: string) => void;
  } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>
>) {
  const shown = safeZonedInput(value, timezone);
  const [text, setText] = useState(shown);
  const [lastShown, setLastShown] = useState(shown);
  // Set when the field is left holding something that is not a usable date, so that it says
  // so rather than quietly going back to the old value.
  const [rejected, setRejected] = useState(false);
  // Follow the value when it changes from outside — a protocol applied, a card loaded.
  if (shown !== lastShown) {
    setLastShown(shown);
    setText(shown);
  }

  return (
    <input
      {...rest}
      type="datetime-local"
      min={`${EARLIEST_YEAR}-01-01T00:00`}
      max={`${LATEST_YEAR}-01-18T23:59`}
      value={text}
      aria-invalid={rejected || rest['aria-invalid']}
      title={rejected ? `Dates must fall between ${EARLIEST_YEAR} and 18 January ${LATEST_YEAR}.` : rest.title}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (isPlausible(next)) {
          setRejected(false);
          try {
            onChange(fromZonedInput(next, timezone));
          } catch {
            // A value the zone cannot place is left as typed until it becomes one.
          }
        }
      }}
      // Leaving the field with an unusable date keeps it on screen, marked, rather than
      // silently putting the old value back; an emptied field does get the old value back.
      onBlur={(event) => {
        if (text === '') setText(shown);
        else setRejected(!isPlausible(text));
        rest.onBlur?.(event);
      }}
    />
  );
}

function isPlausible(value: string): boolean {
  const match = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  return year >= EARLIEST_YEAR && year <= LATEST_YEAR;
}

function safeZonedInput(iso: string, timezone: string): string {
  try {
    return toZonedInput(iso, timezone);
  } catch {
    return '';
  }
}
