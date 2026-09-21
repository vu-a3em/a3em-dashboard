import { zonedTime } from '../lib/cardTime';
import type { CoverageGrid, CoverageHour } from '@a3em/config-schema';
import { Pane } from './Pane';

/**
 * When the deployment recorded, hour by hour, against when it was meant to.
 *
 * A gap in the middle of three weeks is invisible in a directory listing and unmissable
 * here. The colouring carries the one distinction that matters: an empty hour the
 * schedule never asked for is not a fault, and an empty hour it did ask for is the thing
 * you came to this screen to find.
 */
export function CoverageHeatmap({ grid, timezone }: Readonly<{ grid: CoverageGrid; timezone: string }>) {
  if (!grid.dates.length) {
    return (
      <Pane id="coverage" title="Recording coverage">
        <p className="hint">Nothing on this card carries a timestamp, so there is no coverage to show.</p>
      </Pane>
    );
  }

  // Shading runs against the busiest hour, so a card of one-minute clips and a card of
  // five-minute clips both read sensibly rather than one being uniformly pale.
  const busiest = Math.max(1, ...grid.hours.flat().map((cell) => cell.clips));
  // The grid's own gap list rather than a rule of my own: the package decides which hours
  // count as gaps so the picture and any count of it cannot disagree.
  const missed = grid.gaps.length;

  return (
    <Pane
      id="coverage"
      title="Recording coverage"
      // A gap the schedule asked for is the finding this pane exists to surface, so it
      // belongs in the header where a shut pane still shows it.
      note={
        <>
          {grid.dates.length} days
          {missed ? <span className="crit"> · {missed} hours missed</span> : null}
        </>
      }
    >
      <p className="hint">
        Every hour of the deployment. Darker cells held more recordings; red is an hour the
        configuration asked for and nothing arrived. Hover over a cell for its exact count and size.
      </p>

      {grid.expectationsUnknown ? (
        <div className="issue warning">
          <span className="marker">!</span>
          <span>
            This card carries no configuration, so there is nothing to say what should have been
            recorded. Only what was actually recorded is shown.
          </span>
        </div>
      ) : null}

      {grid.stoppedEarly ? (
        // Stated once, as the single event it is. Deliberately not called a fault: an end
        // date years out, so the device runs until its battery dies, is an ordinary way
        // to work. The reason it stopped is on the device info above.
        <div className="banner warn" style={{ marginTop: 0, marginBottom: 14 }}>
          <strong>Recording ended {formatSpan(grid.stoppedEarly.shortBySeconds)} before the configured end</strong>
          The last recording was {zonedTime(grid.lastRecordingAt, timezone)}, and the
          configuration ran to {zonedTime(grid.stoppedEarly.configuredEnd, timezone)}. If that end
          date was set far out so the device would run until its battery gave out, this is expected.
        </div>
      ) : null}

      {grid.omittedDays ? (
        <p className="help">
          {grid.omittedDays.toLocaleString()} further days are not drawn — the span between the first and
          last recording is too long to show hour by hour.
        </p>
      ) : null}

      <div className="grid stats" style={{ marginBottom: 14 }}>
        <Stat
          label="Missing hours"
          value={grid.expectationsUnknown ? '—' : grid.gaps.length.toLocaleString()}
          tone={grid.gaps.length ? 'crit' : 'ok'}
        />
        <Stat
          label="Longest gap"
          value={grid.expectationsUnknown ? '—' : `${grid.longestGapHours} h`}
          tone={grid.longestGapHours >= 24 ? 'crit' : undefined}
        />
      </div>

      <div className="scroll-x">
        <table className="heatmap">
          <thead>
            <tr>
              <th />
              {Array.from({ length: 24 }, (_, hour) => (
                <th key={hour}>{hour % 3 === 0 ? hour : ''}</th>
              ))}
              <th className="heatmap-total">clips</th>
            </tr>
          </thead>
          <tbody>
            {grid.dates.map((date, index) => (
              <tr key={date}>
                <th className="heatmap-date">{date.slice(5)}</th>
                {grid.hours[index].map((cell) => (
                  <td key={cell.hour}>
                    <span
                      className={`heat ${cellClass(cell)}`}
                      style={cell.clips ? { opacity: 0.25 + 0.75 * (cell.clips / busiest) } : undefined}
                      title={describe(cell)}
                    />
                  </td>
                ))}
                <td className="heatmap-total">
                  {grid.hours[index].reduce((sum, cell) => sum + cell.clips, 0).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="heat-legend">
        <span>
          <i className="heat recorded" /> recorded
        </span>
        <span>
          <i className="heat gap" /> expected, missing
        </span>
        <span>
          <i className="heat idle" /> not scheduled
        </span>
        <span>
          <i className="heat ended" /> after recording stopped
        </span>
        <span>
          <i className="heat unknown" /> outside the deployment
        </span>
      </div>

      {grid.gaps.length ? (
        <p className="help">
          The first missing hour was {zonedTime(grid.gaps[0].startsAt, timezone)} local. Times follow
          the clock correction set above.
        </p>
      ) : null}
    </Pane>
  );
}

function cellClass(cell: CoverageHour): string {
  if (cell.clips > 0) return 'recorded';
  // Taken straight from the grid rather than re-derived, so what is drawn red and what
  // is counted as missing are guaranteed to be the same set.
  if (cell.isGap) return 'gap';
  if (cell.afterEnd) return 'ended';
  // An amplitude-triggered hour with nothing in it is not evidence of anything.
  if (cell.expectation === 'idle' || cell.expectation === 'unpredictable') return 'idle';
  return 'unknown';
}

function describe(cell: CoverageHour): string {
  const when = `${cell.date} ${String(cell.hour).padStart(2, '0')}:00`;
  if (cell.clips > 0) {
    return `${when} — ${cell.clips} recording${cell.clips === 1 ? '' : 's'}, ${(cell.bytes / 1024 ** 2).toFixed(0)} MB`;
  }
  switch (cell.expectation) {
    case 'scheduled':
      return cell.afterEnd ? `${when} — after the last recording` : `${when} — expected recordings, none found`;
    case 'idle':
      return `${when} — not scheduled to record`;
    case 'unpredictable':
      return `${when} — amplitude triggered, so nothing can be expected either way`;
    default:
      return `${when} — outside the deployment`;
  }
}

function formatSpan(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 365) return `${(days / 365).toFixed(1)} years`;
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  return `${Math.max(1, Math.round(seconds / 3600))} hours`;
}

function Stat({ label, value, tone }: Readonly<{ label: string; value: string; tone?: 'ok' | 'crit' }>) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
    </div>
  );
}
