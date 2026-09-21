import { useState } from 'react';
import {
  MAX_AUDIO_TRIGGER_TIMES,
  SOLAR_ANCHORS,
  isValidPosition,
  solarDayAt,
  type SolarAnchor,
  type SolarWindow,
  type TriggerWindow,
} from '@a3em/config-schema';

/**
 * The daily recording schedule for a phase.
 *
 * Modelled on the AudioMoth configuration app, which acoustic ecologists already know:
 * a 24-hour strip showing the periods in place, start, and end fields with an add
 * control beneath, and the resulting list. The vocabulary is theirs too — "recording
 * period" rather than an invented alternative.
 *
 * Two deliberate departures. AudioMoth requires selecting a row and pressing "Remove
 * selected period", so correcting a mistyped time means removing and re-adding it. Here
 * the rows are editable in place and each carries its own remove, which needs no selection
 * concept to explain and makes a small correction a small action.
 *
 * And the add control creates a period rather than collecting one. A separate pair of draft
 * fields above the button meant a period was typed in one place, then moved somewhere else
 * to be edited again — two ways to edit the same thing, with only the second one actually
 * on the schedule. Adding first and editing in place leaves one.
 *
 * Periods repeat every day and are stored as seconds past local midnight, which is what
 * the firmware reads.
 */
export function RecordingPeriods({
  windows,
  onChange,
  invalid,
  timezone,
  label = 'Recording periods',
  help,
  emptyMessage = 'No recording periods yet — the device would record nothing.',
}: Readonly<{
  windows: TriggerWindow[];
  onChange: (windows: TriggerWindow[]) => void;
  invalid: boolean;
  timezone: string;
  /** Overridden under a solar schedule, where these windows are the fallback rather than the schedule. */
  label?: string;
  help?: string;
  /**
   * What an empty list means, which is not the same thing under the two schedule types.
   *
   * Under a clock schedule an empty list IS the schedule, so the device records nothing at
   * all. Under a solar schedule the device has a schedule of its own and these are only the
   * fallback, so saying "the device would record nothing" would be plainly false for every
   * day the sun cooperates — which, outside the Arctic, is all of them.
   */
  emptyMessage?: string;
}>) {
  const atCapacity = windows.length >= MAX_AUDIO_TRIGGER_TIMES;
  const ordered = [...windows].sort((a, b) => a.startSecond - b.startSecond);
  const totalActive = windows.reduce((sum, w) => sum + Math.max(0, w.endSecond - w.startSecond), 0);

  const setWindow = (index: number, patch: Partial<TriggerWindow>) =>
    onChange(windows.map((window, i) => (i === index ? { ...window, ...patch } : window)));

  /*
    A new period starts after the last one ends, not at a fixed time.

    Appending a second 07:00-12:00 would land on top of the first and show an overlap error
    for a row the user had not typed anything into yet, which reads as the tool being broken
    rather than as a period needing adjustment.
  */
  const add = () => {
    const latestEnd = windows.reduce((latest, window) => Math.max(latest, window.endSecond), 0);
    const startSecond = Math.min(latestEnd || 7 * 3600, 22 * 3600);
    onChange([...windows, { startSecond, endSecond: Math.min(startSecond + 2 * 3600, 86400) }]);
  };

  return (
    <div className="field">
      <label>{label}</label>
      <p className="help" style={{ marginTop: 0, marginBottom: 10 }}>
        {help ?? `Repeats daily in ${timezone.replace(/_/g, ' ')} local time. At most ${MAX_AUDIO_TRIGGER_TIMES}.`}
      </p>

      {/* The day at a glance — where the periods actually fall, and what they leave out */}
      <div className="day-strip" role="img" aria-label={describeSchedule(ordered)}>
        {[6, 12, 18].map((hour) => (
          <div key={hour} className="day-divider" style={{ left: `${(hour / 24) * 100}%` }} />
        ))}
        {ordered.map((window) => (
          <div
            key={`${window.startSecond}-${window.endSecond}`}
            className="day-period"
            style={{
              left: `${(window.startSecond / 86400) * 100}%`,
              width: `${Math.max(0.4, ((window.endSecond - window.startSecond) / 86400) * 100)}%`,
            }}
            title={`${toTimeOfDay(window.startSecond)} to ${toTimeOfDay(window.endSecond)}`}
          />
        ))}
      </div>
      <div className="day-scale">
        {['00:00', '06:00', '12:00', '18:00', '24:00'].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      {windows.length === 0 ? (
        <div className={`issue ${invalid ? 'error' : 'warning'}`} style={{ marginBottom: 12 }}>
          <span className="marker">{invalid ? '✕' : '!'}</span>
          <span>{emptyMessage}</span>
        </div>
      ) : null}

      {/*
        Rendered in the order they were added, NOT sorted.

        Three faults met here. The list was drawn from a sorted copy while edits indexed
        into the unsorted array, so typing in the first row changed a different one. The
        key was built from the row's own values, so it changed with every keystroke and
        React remounted the input — losing the caret, and colliding with another row's key
        when two momentarily matched, which is where the phantom rows came from. And a
        half-typed time parsed to 0, re-sorting the row to the top mid-edit.

        Sorting belongs to the day strip above and to validation, neither of which the user
        is typing into. A list that reorders under the caret cannot be edited.
      */}
      {windows.length ? (
        <div className="period-list">
          {windows.map((window, index) => {
            return (
              <div className="period-row" key={index}>
                <input
                  type="time"
                  aria-label="Period start"
                  value={toTimeOfDay(window.startSecond)}
                  onChange={(e) =>
                    // An empty value is what a time input reports mid-edit; taking it as
                    // 00:00 rewrote the row the moment the field was cleared.
                    e.target.value && setWindow(index, { startSecond: fromTimeOfDay(e.target.value) })
                  }
                />
                <span className="muted">to</span>
                <input
                  type="time"
                  aria-label="Period end"
                  value={toTimeOfDay(window.endSecond)}
                  onChange={(e) =>
                    e.target.value && setWindow(index, { endSecond: fromTimeOfDay(e.target.value) })
                  }
                />
                <span className="muted mono">{formatDuration(window.endSecond - window.startSecond)}</span>
                <button
                  className="btn"
                  style={{ marginLeft: 'auto', padding: '4px 10px' }}
                  onClick={() => onChange(windows.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {/*
        Below the list, because that is where the new row appears. Adding from above it
        meant the thing you just created showed up somewhere you were not looking.
      */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <button className="btn primary" onClick={add} disabled={atCapacity}>
          Add recording period
        </button>
        {windows.length ? (
          <>
            <button className="btn" onClick={() => onChange([])}>
              Clear all periods
            </button>
            <span className="chip">{formatDuration(totalActive)} recording per day</span>
          </>
        ) : null}
        {atCapacity ? (
          <span className="muted" style={{ fontSize: 12 }}>
            The device holds {MAX_AUDIO_TRIGGER_TIMES}.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function describeSchedule(windows: TriggerWindow[]): string {
  if (!windows.length) return 'A 24-hour day with no recording periods set';
  return `A 24-hour day with recording during ${windows
    .map((w) => `${toTimeOfDay(w.startSecond)} to ${toTimeOfDay(w.endSecond)}`)
    .join(', ')}`;
}

/** Seconds past midnight to the `HH:MM` a time input expects. */
export function toTimeOfDay(seconds: number): string {
  const clamped = Math.max(0, Math.min(86_399, seconds));
  return `${String(Math.floor(clamped / 3600)).padStart(2, '0')}:${String(
    Math.floor((clamped % 3600) / 60),
  ).padStart(2, '0')}`;
}

export function fromTimeOfDay(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return 0;
  return hours * 3600 + minutes * 60;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [hours && `${hours}h`, minutes && `${minutes}m`].filter(Boolean).join(' ') || '0m';
}

/**
 * The sun-anchored schedule, which the DEVICE resolves rather than this app.
 *
 * Nothing here computes a recording time. It edits anchors and offsets, shows the position
 * the device will compute from, and previews what that computation gives on one chosen day —
 * clearly labelled as a preview, because the device works the schedule out afresh every
 * local day and the numbers shown will be different by the end of a long deployment. That
 * difference is the entire reason the calculation moved onto the device, so presenting these
 * as the schedule would misrepresent the feature.
 */
export function SolarRecordingPeriods({
  windows,
  onChange,
  latitude,
  longitude,
  onPositionChange,
  timezone,
  startTime,
  endTime,
  invalidLatitude,
  invalidLongitude,
}: Readonly<{
  windows: SolarWindow[];
  onChange: (windows: SolarWindow[]) => void;
  latitude: number | null;
  longitude: number | null;
  onPositionChange: (position: { latitude: number | null; longitude: number | null }) => void;
  timezone: string;
  startTime: string;
  endTime: string;
  /** Judged per field. One flag for both marked a valid latitude invalid because the longitude was blank. */
  invalidLatitude: boolean;
  invalidLongitude: boolean;
}>) {
  // Held as text, not numbers: a controlled number input cannot represent "-" or "36." on the
  // way to a real coordinate, so a negative latitude was impossible to type.
  const [latText, setLatText] = useState(latitude === null ? '' : String(latitude));
  const [lonText, setLonText] = useState(longitude === null ? '' : String(longitude));

  const commitPosition = (lat: string, lon: string) => {
    const blank = lat.trim() === '' && lon.trim() === '';
    onPositionChange({
      latitude: blank ? null : Number(lat),
      longitude: blank ? null : Number(lon),
    });
  };

  const position = { latitude: Number(latText), longitude: Number(lonText) };
  const havePosition = latText.trim() !== '' && lonText.trim() !== '' && isValidPosition(position);

  /*
    Each box is judged on its OWN contents.

    `havePosition` needs both coordinates, so using it per field marked a perfectly good
    latitude as invalid for as long as the longitude was still blank — and then swapped which
    box was red as soon as the second one was typed. That the position is incomplete is a
    statement about the pair, and it belongs in the validation list, not in a red border on
    one arbitrary half of it.

    An untouched empty box is never red either: nothing has been got wrong yet.
  */
  const outOfRange = (text: string, limit: number) => {
    if (text.trim() === '') return false;
    const value = Number(text);
    return !Number.isFinite(value) || Math.abs(value) > limit;
  };
  const latBad = outOfRange(latText, 90) || (invalidLatitude && latText.trim() !== '');
  const lonBad = outOfRange(lonText, 180) || (invalidLongitude && lonText.trim() !== '');

  /*
    Previewed at the deployment MIDPOINT.

    Not the first day: the schedule changes across the deployment, and the midpoint is the
    single day that best represents the whole of it. Showing day one would make a spring
    deployment look an hour earlier than it will mostly run.
  */
  const midpoint = new Date(
    Date.parse(startTime) + (Date.parse(endTime) - Date.parse(startTime)) / 2,
  ).toISOString();
  const preview = havePosition ? solarDayAt(midpoint, position, timezone) : null;

  const atCapacity = windows.length >= MAX_AUDIO_TRIGGER_TIMES;
  const setWindow = (index: number, patch: Partial<SolarWindow>) =>
    onChange(windows.map((window, i) => (i === index ? { ...window, ...patch } : window)));

  const previewWindow = (window: SolarWindow): string | null => {
    if (!preview) return null;
    if (!preview.available[window.startAnchor] || !preview.available[window.endAnchor]) return null;
    const from = wrap(preview.secondsOfDay[window.startAnchor] + window.startOffsetSeconds);
    const to = wrap(preview.secondsOfDay[window.endAnchor] + window.endOffsetSeconds);
    // The device drops a window that runs past midnight, because the schedule comparison is a
    // single seconds-of-day value. Saying so is better than previewing a window it will skip.
    if (to <= from) return 'skipped — runs past midnight';
    return `${toTimeOfDay(from)} to ${toTimeOfDay(to)}`;
  };

  return (
    <div className="field">
      <label>Solar recording periods</label>
      <p className="help" style={{ marginTop: 0, marginBottom: 10 }}>
        The device determines these from its own clock and the position below, once every day, so they
        follow the season instead of drifting away from it. Offsets are minutes after the anchor, so
        use a negative number for minutes before it. At most {MAX_AUDIO_TRIGGER_TIMES}.
      </p>

      <div className="row">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="site-lat">Latitude</label>
          <input
            id="site-lat"
            type="text"
            inputMode="decimal"
            placeholder="-1.2921"
            value={latText}
            aria-invalid={latBad}
            onChange={(event) => {
              setLatText(event.target.value);
              commitPosition(event.target.value, lonText);
            }}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="site-lon">Longitude</label>
          <input
            id="site-lon"
            type="text"
            inputMode="decimal"
            placeholder="36.8219"
            value={lonText}
            aria-invalid={lonBad}
            onChange={(event) => {
              setLonText(event.target.value);
              commitPosition(latText, event.target.value);
            }}
          />
        </div>
      </div>

      {windows.length === 0 ? (
        <div className="banner warn" style={{ marginTop: 12 }}>
          <span>No solar periods yet — the device would fall back to the fixed periods below.</span>
        </div>
      ) : null}

      {windows.length ? (
        <div className="period-list" style={{ marginTop: 12 }}>
          {windows.map((window, index) => (
            /*
              One row, read left to right as a sentence: "30 min after Civil dawn, to 90 min
              after Sunrise". Every offset is "after", so a period before its anchor is a
              negative number rather than a second unit of measurement to learn. The earlier
              layout put a bare "min, to" between the two halves, which read as a label for
              the field after it rather than the one before.

              Keyed by position, not contents: a key built from the values changes on every
              keystroke, which remounts the input and loses the caret.
            */
            <div className="period-row" key={index} style={{ flexWrap: 'wrap' }}>
              <input
                type="number"
                aria-label="Period start offset in minutes after its anchor"
                className="period-offset"
                step={5}
                value={Math.round(window.startOffsetSeconds / 60)}
                onChange={(event) => setWindow(index, { startOffsetSeconds: Number(event.target.value) * 60 })}
              />
              <span className="muted">min after</span>
              <select
                aria-label="Period start anchor"
                value={window.startAnchor}
                onChange={(event) => setWindow(index, { startAnchor: event.target.value as SolarAnchor })}
              >
                {Object.entries(SOLAR_ANCHORS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="muted">to</span>
              <input
                type="number"
                aria-label="Period end offset in minutes after its anchor"
                className="period-offset"
                step={5}
                value={Math.round(window.endOffsetSeconds / 60)}
                onChange={(event) => setWindow(index, { endOffsetSeconds: Number(event.target.value) * 60 })}
              />
              <span className="muted">min after</span>
              <select
                aria-label="Period end anchor"
                value={window.endAnchor}
                onChange={(event) => setWindow(index, { endAnchor: event.target.value as SolarAnchor })}
              >
                {Object.entries(SOLAR_ANCHORS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                className="btn"
                style={{ marginLeft: 'auto', padding: '4px 10px' }}
                onClick={() => onChange(windows.filter((_, i) => i !== index))}
              >
                Remove
              </button>
              {previewWindow(window) ? (
                <span className="muted mono" style={{ flexBasis: '100%', fontSize: 12 }}>
                  mid-deployment: {previewWindow(window)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
        <button
          className="btn primary"
          disabled={atCapacity}
          onClick={() =>
            onChange([
              ...windows,
              { startAnchor: 'DAWN', startOffsetSeconds: 0, endAnchor: 'SUNRISE', endOffsetSeconds: 5400 },
            ])
          }
        >
          Add solar period
        </button>
        {atCapacity ? (
          <span className="muted" style={{ fontSize: 12 }}>
            The device holds {MAX_AUDIO_TRIGGER_TIMES}.
          </span>
        ) : null}
      </div>

      {/*
        Say what the sun does here, because it decides whether any of this runs at all. The
        polar cases are not edge cases for this project: caribou deployments sit above the
        Arctic circle, where the device will use the fallback windows for weeks at a time.
      */}
      {preview?.polarDay ? (
        <p className="help" style={{ color: 'var(--warn)' }}>
          The sun does not set at this position in the middle of the deployment, so there is no
          sunrise or sunset to anchor to. The device will use the fallback periods on those days.
        </p>
      ) : preview?.polarNight ? (
        <p className="help" style={{ color: 'var(--warn)' }}>
          The sun does not rise at this position in the middle of the deployment. Windows anchored to
          civil dawn or dusk may still resolve; ones anchored to sunrise or sunset will not, and the
          device will use the fallback periods for those.
        </p>
      ) : null}
    </div>
  );
}

/** Folds an offset back onto a single day, the way `solar_compute()` does before scheduling. */
function wrap(seconds: number): number {
  const wrapped = seconds % 86400;
  return wrapped < 0 ? wrapped + 86400 : wrapped;
}
