import {
  AUDIO_FILTER_TYPES,
  maxFrequencyCeilingHz,
  silenceBand,
  summariseFilter,
  summariseSilence,
  type PhaseConfig,
} from '@a3em/config-schema';
import { Pane } from './Pane';

/**
 * Band-limiting of the recorded audio.
 *
 * Genuinely a filter, unlike the frequencies of interest below it: this discards energy
 * from what gets written. The two are separate settings because they answer different
 * questions — which frequencies to record, and which to judge silence by — so they are
 * presented as separate cards rather than one shared band.
 */
export function AudioFilter({
  phase,
  effectiveSampleRateHz,
  onChange,
  invalidLow,
  phaseName,
}: Readonly<{
  phase: PhaseConfig;
  effectiveSampleRateHz: number;
  onChange: (patch: Partial<PhaseConfig>) => void;
  invalidLow: boolean;
  /** Named in the title when a deployment has phases, so the pane says what it edits. */
  phaseName: string | null;
}>) {
  /*
    The filter's own ceiling, NOT the silence band's.

    `audio_filter.c` clamps its corners to nyquist - 1; the extra 200 Hz of headroom in
    `maxFrequencyCeilingHz` exists for the silence filter's FFT bins and has nothing to do
    with these. Using that stricter number here capped the controls 199 Hz below what the
    device would honour, so a corner the validator accepts could not be entered.

    The two corners differ by one: a low-pass corner may sit ON the ceiling, a high-pass
    corner must stay below it, which is what the validator enforces.
  */
  const ceiling = Math.floor(effectiveSampleRateHz / 2) - 1;
  const highPassCeiling = ceiling - 1;
  const enabled = phase.audioFilterType !== 'NONE';
  const usesLow = phase.audioFilterType === 'HIGH' || phase.audioFilterType === 'BAND';
  const usesHigh = phase.audioFilterType === 'LOW' || phase.audioFilterType === 'BAND';
  const low = Math.max(usesLow ? 1 : 0, Math.min(phase.audioFilterLowHz, highPassCeiling));
  const high = Math.max(low, Math.min(phase.audioFilterHighHz || ceiling, ceiling));
  const toPercent = (hz: number) => (ceiling > 0 ? (hz / ceiling) * 100 : 0);

  // What the band actually passes, which is what the strip should show.
  const bandLeft = usesLow ? toPercent(low) : 0;
  const bandRight = usesHigh ? toPercent(high) : 100;

  return (
    <Pane
      id="audio-filter"
      title={`Audio filter${phaseName ? ` — ${phaseName}` : ''}`}
      note={summariseFilter(phase)}
    >
      <p className="hint">
        Removes audio outside the selected frequency band from the recordings themselves. The ceiling is the Nyquist limit less a 200 Hz guard band.
      </p>

        <div className="field">
          <label htmlFor="filter-type">Filter type</label>
          <select
            id="filter-type"
            value={phase.audioFilterType}
            onChange={(event) => {
              const audioFilterType = event.target.value as PhaseConfig['audioFilterType'];
              // A configuration read from a card, or a protocol saved before this default
              // changed, can arrive with a zero corner. Lift it on selection rather than
              // presenting an error about a value the user never chose.
              const needsLow = audioFilterType === 'HIGH' || audioFilterType === 'BAND';
              onChange({
                audioFilterType,
                ...(needsLow && phase.audioFilterLowHz <= 0 ? { audioFilterLowHz: 1 } : {}),
              });
            }}
          >
            {Object.entries(AUDIO_FILTER_TYPES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p className="help">{FILTER_HELP[phase.audioFilterType]}</p>
        </div>

        {enabled ? (
          <>
            <div className="band-slider">
              <div className="band-track" />
              <div
                className="band-fill"
                style={{ left: `${bandLeft}%`, width: `${Math.max(0, bandRight - bandLeft)}%` }}
              />
              {usesLow ? (
                <input
                  type="range"
                  aria-label="High-pass corner"
                  min={1}
                  max={highPassCeiling}
                  step={50}
                  value={low}
                  onChange={(event) =>
                    onChange({ audioFilterLowHz: usesHigh ? Math.min(Number(event.target.value), high - 50) : Number(event.target.value) })
                  }
                />
              ) : null}
              {usesHigh ? (
                <input
                  type="range"
                  aria-label="Low-pass corner"
                  min={0}
                  max={ceiling}
                  step={50}
                  value={high}
                  onChange={(event) =>
                    onChange({ audioFilterHighHz: usesLow ? Math.max(Number(event.target.value), low + 50) : Number(event.target.value) })
                  }
                />
              ) : null}
            </div>
            <div className="band-scale">
              <span>0 kHz</span>
              <span className="mono">
                {usesLow ? `${(low / 1000).toFixed(2)}` : '0'} – {usesHigh ? `${(high / 1000).toFixed(2)}` : (ceiling / 1000).toFixed(2)} kHz
              </span>
              <span>{(ceiling / 1000).toFixed(1)} kHz</span>
            </div>

            <div className="row" style={{ marginTop: 8 }}>
              {usesLow ? (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="filter-low">High-pass corner (Hz)</label>
                  <input
                    id="filter-low"
                    type="number"
                    min={1}
                    max={highPassCeiling}
                    value={low}
                    aria-invalid={invalidLow}
                    onChange={(event) => onChange({ audioFilterLowHz: Number(event.target.value) })}
                  />
                </div>
              ) : null}
              {usesHigh ? (
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="filter-high">Low-pass corner (Hz)</label>
                  <input
                    id="filter-high"
                    type="number"
                    min={1}
                    max={ceiling}
                    value={high}
                    onChange={(event) => onChange({ audioFilterHighHz: Number(event.target.value) })}
                  />
                </div>
              ) : null}
            </div>
            <p className="help">Rolls off at 12 dB per octave, 3 dB down at each corner.</p>
          </>
      ) : null}
    </Pane>
  );
}

const FILTER_HELP: Record<string, string> = {
  NONE: 'Recordings keep the full bandwidth the sample rate allows.',
  LOW: 'Keeps everything below the corner, removing high-frequency hiss.',
  BAND: 'Keeps only what falls between the two corners.',
  HIGH: 'Keeps everything above the corner, removing wind rumble.',
};

/**
 * Silence detection, and the frequency band it listens across.
 *
 * NOT a filter, despite resembling one. `MIN_FREQUENCY` and `MAX_FREQUENCY` only choose
 * which FFT bins `silence_filter_is_silence()` sums when deciding whether a clip is
 * worth keeping — they never alter what is stored. Band-limiting the audio itself is
 * the separate AudioFilter above.
 *
 * The band is inert while the threshold is zero, which is the default, so it stays
 * disabled until a threshold is set.
 */
export function SilenceDetection({
  phase,
  effectiveSampleRateHz,
  onChange,
  invalidMin,
  invalidMax,
  phaseName,
}: Readonly<{
  phase: PhaseConfig;
  effectiveSampleRateHz: number;
  onChange: (patch: Partial<PhaseConfig>) => void;
  invalidMin: boolean;
  invalidMax: boolean;
  phaseName: string | null;
}>) {
  const ceiling = maxFrequencyCeilingHz(effectiveSampleRateHz);
  const enabled = phase.silenceThreshold > 0;
  const min = Math.max(0, Math.min(phase.minFrequencyHz, ceiling));
  const max = Math.max(min, Math.min(phase.maxFrequencyHz || ceiling, ceiling));

  /*
    What the DEVICE will judge, which is not what was typed.

    The band chooses FFT bins, and bins are 7.8 Hz or 11.7 Hz wide depending on the sample
    rate, so both edges snap to a bin centre and can land either side of the figure typed
    in — at 48 kHz, 250 Hz judges from 246.1 Hz while 100 Hz judges from 105.5 Hz. It is
    shown because a buffer judged silent is never written at all, so a band that misses the
    signal costs recordings rather than precision, and the difference is invisible on the
    card afterwards.
  */
  const actual = silenceBand(effectiveSampleRateHz, min, max);

  const toPercent = (hz: number) => (ceiling > 0 ? (hz / ceiling) * 100 : 0);

  return (
    <Pane
      id="silence-detection"
      title={`Silence detection${phaseName ? ` — ${phaseName}` : ''}`}
      note={summariseSilence(phase)}
    >
      <p className="hint">
        Discards clips whose sound never rises above the threshold, saving on storage during quiet periods.
        This only decides what to keep, not what the recordings contain.
      </p>

      <div className="field">
        <label htmlFor="silence">Silence threshold</label>
        <input
          id="silence"
          type="range"
          min={0}
          max={100}
          value={Math.round(phase.silenceThreshold * 100)}
          onChange={(event) => onChange({ silenceThreshold: Number(event.target.value) / 100 })}
        />
        <p className="help">
          {enabled
            ? `Clips staying below ${Math.round(phase.silenceThreshold * 100)}% of full scale are discarded.`
            : 'Off — every clip is kept.'}
        </p>
      </div>

      {/*
        Hidden rather than dimmed while the threshold is zero.

        The band only chooses which FFT bins `silence_filter_is_silence()` sums, so with
        no threshold it changes nothing at all — greying it out still left a band, two
        sliders and two number fields on screen inviting adjustment of something inert.
        The threshold's own help text says the feature is off, which is the whole story.
      */}
      {enabled ? (
      <div className="field">
        <label>Frequencies of interest</label>
        {/* Under the title: it explains what the control below it does. */}
        <p className="help">
          {`Sound outside this band is ignored when judging silence. Capped at ${(
            ceiling / 1000
          ).toFixed(1)} kHz at this sample rate.`}
        </p>

        <div className="band-slider">
          <div className="band-track" />
          <div
            className="band-fill"
            style={{ left: `${toPercent(min)}%`, width: `${Math.max(0, toPercent(max) - toPercent(min))}%` }}
          />
          <input
            type="range"
            aria-label="Lowest frequency of interest"
            min={0}
            max={ceiling}
            step={50}
            value={min}
            onChange={(event) =>
              onChange({ minFrequencyHz: Math.min(Number(event.target.value), max - 50) })
            }
          />
          <input
            type="range"
            aria-label="Highest frequency of interest"
            min={0}
            max={ceiling}
            step={50}
            value={max}
            onChange={(event) =>
              onChange({ maxFrequencyHz: Math.max(Number(event.target.value), min + 50) })
            }
          />
        </div>

        <div className="band-scale">
          <span>0 kHz</span>
          <span className="mono">
            {(min / 1000).toFixed(2)} – {(max / 1000).toFixed(2)} kHz
          </span>
          <span>{(ceiling / 1000).toFixed(1)} kHz</span>
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="min-freq">Lowest (Hz)</label>
            <input
              id="min-freq"
              type="number"
              min={0}
              max={ceiling}
              value={min}
              aria-invalid={invalidMin}
              onChange={(event) => onChange({ minFrequencyHz: Number(event.target.value) })}
            />
            <p className="help">
              {actual.usable
                ? `Actual on-device: ${actual.actualMinHz.toFixed(1)} Hz (bin ${actual.minBin}).`
                : 'Range unusable — the device would keep every clip.'}
            </p>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="max-freq">Highest (Hz)</label>
            <input
              id="max-freq"
              type="number"
              min={0}
              max={ceiling}
              value={max}
              aria-invalid={invalidMax}
              onChange={(event) => onChange({ maxFrequencyHz: Number(event.target.value) })}
            />
            <p className="help">
              {actual.usable
                ? `Actual on-device: ${actual.actualMaxHz.toFixed(1)} Hz (bin ${actual.maxBin}).`
                : `${actual.binWidthHz.toFixed(2)} Hz bins at this sample rate.`}
            </p>
          </div>
        </div>

      </div>
      ) : null}
    </Pane>
  );
}
