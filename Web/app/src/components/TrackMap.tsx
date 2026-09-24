import type { ClockCorrection } from '@a3em/config-schema';
import { deviceTime } from '../lib/cardTime';
import { projectTrack, scaleBar, type Track } from '@a3em/config-schema';
import { Pane } from './Pane';

/**
 * Where the device was, plotted from the positions in its log.
 *
 * No basemap and no mapping library, on purpose. This has to work at a field station
 * with no connectivity, and a map that renders as gray squares exactly when it matters
 * is worse than one that never promised tiles. A plot with a scale bar answers what
 * these positions are actually good for: did the device move, how far, and when.
 */
export function TrackMap({
  track,
  gpsConfigured,
  correction,
  timezone,
}: Readonly<{ track: Track; gpsConfigured: boolean; correction: ClockCorrection | null; timezone: string }>) {
  if (!track.fixes.length || !track.bounds) {
    return (
      <Pane id="position" title="Position" note="No fixes">
        <p className="hint">
          {gpsConfigured
            ? 'This deployment had GPS enabled, but no log line carries a position. The device never got a fix.'
            : 'No positions were recorded. GPS was not enabled for this deployment.'}
        </p>
      </Pane>
    );
  }

  const points = projectTrack(track);
  const bar = scaleBar(track);
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x * 100} ${point.y * 100}`).join(' ');

  return (
    <Pane
      id="position"
      title="Position"
      note={`${track.fixes.length} ${track.fixes.length === 1 ? 'fix' : 'fixes'} · ${
        track.stationary ? 'stationary' : formatDistance(track.displacementMeters)
      }`}
    >
      <p className="hint">
        {track.stationary
          ? 'The device stayed put. The spread below is receiver error, not movement — note the scale.'
          : `The device moved ${formatDistance(track.displacementMeters)} between its first and last fix.`}
      </p>

      <div className="track-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Recorded positions">
          {points.length > 1 ? <path d={path} className="track-path" /> : null}
          {points.map((point, index) => (
            <circle
              key={track.fixes[index].timestamp}
              cx={point.x * 100}
              cy={point.y * 100}
              r={index === 0 || index === points.length - 1 ? 1.6 : 0.7}
              className={index === 0 ? 'track-start' : index === points.length - 1 ? 'track-end' : 'track-fix'}
            >
              <title>
                {deviceTime(track.fixes[index].timestamp, correction, timezone)} —{' '}
                {track.fixes[index].latitude.toFixed(5)}, {track.fixes[index].longitude.toFixed(5)}
              </title>
            </circle>
          ))}
        </svg>

        {bar ? (
          <div className="track-scale">
            <span className="track-scale-bar" style={{ width: `${bar.fraction * 100}%` }} />
            <span>{formatDistance(bar.meters)}</span>
          </div>
        ) : null}
      </div>

      <div className="grid stats" style={{ marginTop: 14 }}>
        <Stat label="Fixes" value={track.fixes.length.toLocaleString()} />
        <Stat label="Displacement" value={formatDistance(track.displacementMeters)} />
        <Stat label="Path length" value={formatDistance(track.pathMeters)} />
        <Stat
          label="Center"
          value={`${track.bounds.centerLatitude.toFixed(4)}, ${track.bounds.centerLongitude.toFixed(4)}`}
        />
      </div>

      <p className="help">
        Larger dots mark the first and last fix. Positions are as the device recorded them; the clock
        correction above does not change where it was, only when.
      </p>
    </Pane>
  );
}

function formatDistance(meters: number): string {
  if (meters < 1) return '< 1 m';
  if (meters < 1000) return `${meters.toFixed(0)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

function Stat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
