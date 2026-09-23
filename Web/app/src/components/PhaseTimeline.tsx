import {
  MAX_DEPLOYMENT_PHASES,
  formatZonedDisplay,
  localMidnight,
  summarisePhases,
  type DeploymentConfig,
  type PhaseConfig,
} from '@a3em/config-schema';
import { Pane } from './Pane';
import { ZonedDateTimeInput } from './ZonedDateTimeInput';

/**
 * Deployment phases, drawn against the deployment span.
 *
 * The desktop tool presented a phase as five text fields repeated, which left whether
 * they tiled the deployment without gaps or overlaps as something to work out mentally
 * and discover at save time. Here the arrangement is visible: a gap shows as a break in
 * the bar and an overlap as a collision, before anything is written.
 *
 * Phases are an A3EM concept with no equivalent in other loggers, so nothing here is
 * waiting on the AudioMoth review.
 */
export function PhaseTimeline({
  config,
  selectedIndex,
  onSelect,
  onChange,
}: Readonly<{
  config: DeploymentConfig;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onChange: (config: DeploymentConfig) => void;
}>) {
  const start = Date.parse(config.startTime);
  const end = Date.parse(config.endTime);
  const span = Math.max(1, end - start);

  const setPhased = (isPhased: boolean) => {
    if (!isPhased) {
      // Collapse to one phase covering the whole deployment. The firmware infers
      // phasing from whether phase times are present, so they are dropped entirely.
      onChange({
        ...config,
        isPhased: false,
        phases: [{ ...config.phases[0], startTime: undefined, endTime: undefined }],
      });
      onSelect(0);
      return;
    }
    onChange({
      ...config,
      isPhased: true,
      phases: [{ ...config.phases[0], startTime: config.startTime, endTime: config.endTime }],
    });
  };

  const addPhase = () => {
    // Split the last phase in half rather than appending past the deployment end,
    // which would fail validation the moment it appeared.
    const phases = [...config.phases];
    const last = phases[phases.length - 1];
    const lastStart = Date.parse(last.startTime ?? config.startTime);
    const lastEnd = Date.parse(last.endTime ?? config.endTime);
    const midpoint = splitPoint(lastStart, lastEnd, config.timezone);

    phases[phases.length - 1] = { ...last, endTime: midpoint };
    phases.push({
      ...last,
      name: `Phase ${phases.length + 1}`,
      startTime: midpoint,
      endTime: new Date(lastEnd).toISOString(),
    });
    onChange({ ...config, phases });
    onSelect(phases.length - 1);
  };

  /*
    Whether the phases still cover the deployment, end to end.

    They are absolute instants, so moving the deployment dates leaves them where they were —
    outside the new window, or short of it. Rather than leave the user to retype every
    boundary, the pane offers to stretch them onto the new dates in proportion.
  */
  const phaseStarts = config.phases.map((phase) => Date.parse(phase.startTime ?? config.startTime));
  const phaseEnds = config.phases.map((phase) => Date.parse(phase.endTime ?? config.endTime));
  const firstStart = Math.min(...phaseStarts);
  const lastEnd = Math.max(...phaseEnds);
  const offDates = config.isPhased && (firstStart !== start || lastEnd !== end) && lastEnd > firstStart;
  const fitToDates = () => {
    const scale = (end - start) / (lastEnd - firstStart);
    const place = (ms: number) => new Date(start + (ms - firstStart) * scale).toISOString();
    onChange({
      ...config,
      phases: config.phases.map((phase, i) => ({ ...phase, startTime: place(phaseStarts[i]), endTime: place(phaseEnds[i]) })),
    });
  };

  const removePhase = (index: number) => {
    const phases = config.phases.filter((_, i) => i !== index);
    onChange({ ...config, phases });
    onSelect(Math.max(0, Math.min(selectedIndex, phases.length - 1)));
  };

  const updatePhase = (index: number, patch: Partial<PhaseConfig>) =>
    onChange({
      ...config,
      phases: config.phases.map((phase, i) => (i === index ? { ...phase, ...patch } : phase)),
    });

  // Deployment local time, like the inputs below it. These were raw UTC, so the bar said
  // 11:00 over a field reading 06:00.
  const stamp = (iso: string) => formatZonedDisplay(iso, config.timezone);

  const position = (phase: PhaseConfig) => {
    const phaseStart = Date.parse(phase.startTime ?? config.startTime);
    const phaseEnd = Date.parse(phase.endTime ?? config.endTime);
    return {
      left: `${Math.max(0, Math.min(100, ((phaseStart - start) / span) * 100))}%`,
      width: `${Math.max(1, Math.min(100, ((phaseEnd - phaseStart) / span) * 100))}%`,
    };
  };

  return (
    <Pane id="deployment-phases" title="Deployment phases" note={summarisePhases(config)}>
      <p className="hint">Record differently during different parts of the deployment.</p>

      <div className="field inline" style={{ marginBottom: 16 }}>
        <input
          id="phased"
          type="checkbox"
          checked={config.isPhased}
          style={{ width: 'auto' }}
          onChange={(event) => setPhased(event.target.checked)}
        />
        <label htmlFor="phased">Use separate phases</label>
      </div>

      {config.isPhased ? (
        <>
          <div
            style={{
              position: 'relative',
              height: 42,
              background: 'var(--sunken)',
              border: '1px solid var(--line-2)',
              borderRadius: 5,
              overflow: 'hidden',
              marginBottom: 6,
            }}
          >
            {config.phases.map((phase, index) => (
              <button
                key={index}
                onClick={() => onSelect(index)}
                title={`${phase.name}: ${stamp(phase.startTime ?? config.startTime)} to ${stamp(phase.endTime ?? config.endTime)}`}
                style={{
                  position: 'absolute',
                  top: 3,
                  bottom: 3,
                  ...position(phase),
                  background: PHASE_COLORS[index % PHASE_COLORS.length],
                  border: index === selectedIndex ? '2px solid var(--ink)' : '1px solid rgba(0,0,0,0.18)',
                  borderRadius: 4,
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 650,
                  padding: '0 8px',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textAlign: 'left',
                }}
              >
                {phase.name}
              </button>
            ))}
          </div>
          {offDates ? (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              <strong>The phases no longer match the deployment dates</strong>
              <button className="btn small" style={{ marginTop: 8 }} onClick={fitToDates}>
                Fit the phases to the new dates
              </button>
            </div>
          ) : null}
          <div
            style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}
            className="mono muted"
          >
            <span>{stamp(config.startTime)}</span>
            <span>{stamp(config.endTime)}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {config.phases.map((phase, index) => (
              <div
                key={index}
                style={{
                  border: '1px solid var(--line)',
                  borderLeft: `3px solid ${PHASE_COLORS[index % PHASE_COLORS.length]}`,
                  borderRadius: 5,
                  padding: 12,
                  background: index === selectedIndex ? 'var(--surface-2)' : 'var(--surface)',
                }}
              >
                <div className="row phase-row">
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor={`phase-name-${index}`}>Phase Name</label>
                    <input
                      id={`phase-name-${index}`}
                      value={phase.name}
                      onChange={(event) => updatePhase(index, { name: event.target.value })}
                    />
                    <p className="help">{phaseLength(phaseStarts[index], phaseEnds[index])}</p>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor={`phase-start-${index}`}>Starts</label>
                    <ZonedDateTimeInput
                      id={`phase-start-${index}`}
                      value={phase.startTime ?? config.startTime}
                      timezone={config.timezone}
                      onChange={(startTime) => updatePhase(index, { startTime })}
                    />
                    <p className="help">Deployment local time.</p>
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label htmlFor={`phase-end-${index}`}>Ends</label>
                    <ZonedDateTimeInput
                      id={`phase-end-${index}`}
                      value={phase.endTime ?? config.endTime}
                      timezone={config.timezone}
                      onChange={(endTime) => updatePhase(index, { endTime })}
                    />
                    <p className="help">Deployment local time.</p>
                  </div>
                  {/*
                    In the row rather than on a line of its own: a phase is three fields and
                    a delete, and giving the delete its own row cost as much height again
                    for one button. The edit button that used to sit beside it is gone —
                    the band above the per-phase panes selects now.
                  */}
                  <div className="field phase-remove-cell" style={{ marginBottom: 0 }}>
                    {/* Empty, but occupies a real label box so the button lands on the
                        input line without anyone computing a label's height. */}
                    <label aria-hidden="true">&nbsp;</label>
                  <button
                    className="btn icon phase-remove"
                    onClick={() => removePhase(index)}
                    disabled={config.phases.length <= 1}
                    title={`Remove ${phase.name || `phase ${index + 1}`}`}
                    aria-label={`Remove ${phase.name || `phase ${index + 1}`}`}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M4 7h16M10 4h4M9 7v12M15 7v12M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
            <button className="btn" onClick={addPhase} disabled={config.phases.length >= MAX_DEPLOYMENT_PHASES}>
              Add phase
            </button>
            {config.phases.length >= MAX_DEPLOYMENT_PHASES ? (
              <span className="muted" style={{ fontSize: 12 }}>
                The device holds {MAX_DEPLOYMENT_PHASES}.
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </Pane>
  );
}

/**
 * Six hues that stay apart from one another, each dark enough for the white name on it.
 *
 * The previous set carried two near-identical greens, so phases one and four could not be
 * told apart on the bar.
 */
const PHASE_COLORS = ['#2f6f5e', '#a4562a', '#4f5d9c', '#8a6a12', '#7a3f78', '#1f5f7a'];

/**
 * Where a new phase divides the one it is split from: the local midnight nearest the middle.
 *
 * The exact midpoint produced boundaries like 09:52 that nobody would choose. A midnight is
 * what someone would type, and the split falls back to the midpoint only when the phase is
 * too short to hold one.
 */
function splitPoint(from: number, to: number, timezone: string): string {
  const middle = from + (to - from) / 2;
  const candidates: number[] = [];
  for (const days of [0, 1]) {
    try {
      candidates.push(Date.parse(localMidnight(timezone, new Date(middle), days)));
    } catch {
      /* A zone that cannot be read leaves the midpoint. */
    }
  }
  const inside = candidates.filter((ms) => ms > from && ms < to);
  const best = inside.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];
  return new Date(best ?? middle).toISOString();
}

function phaseLength(from: number, to: number): string {
  const days = (to - from) / 86_400_000;
  if (!Number.isFinite(days) || days <= 0) return 'No length';
  if (days < 1) return `${Math.round(days * 24)} hours`;
  const rounded = Math.round(days * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${rounded === 1 ? 'day' : 'days'}`;
}
