import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { localDateKey, zonedClock } from '../lib/cardTime';
import { computeSpectrogramAsync } from '../lib/spectrogram-async';
import {
  applyCorrection,
  buildPlayableWav,
  judgeClip,
  measureLevels,
  readSamples,
  readWavFormat,
  waveformEnvelope,
  energyCeilingHz,
  frequencyBin,
  suggestedFftSize,
  type ClipLevels,
  type ClipVerdict,
  type Spectrogram,
} from '@a3em/config-schema';
import type { CorrectionState } from '../App';
import type { useCard } from '../lib/useCard';
import { useClockCorrection } from '../lib/useClockCorrection';
import { RecoverHint } from '../components/RecoverHint';
import { isUndeployed, NotDeployed } from '../components/NotDeployed';
import { TabLink } from '../components/TabLink';

type Card = ReturnType<typeof useCard>;

/**
 * Listening to what a card actually recorded.
 *
 * The first thing anyone does with a returned card is open a few files and check that
 * something is on them — it is the top item in the retrieval routine the ecologist
 * responses describe, and until now it meant leaving this app for a file browser.
 *
 * Nothing is read until a clip is chosen. A full card holds thousands of recordings and
 * gigabytes of audio; scanning it to build this screen would make it useless on exactly
 * the cards that matter most.
 */
const UNDATED = 'Undated';

export function ClipBrowser({
  card,
  correction: correctionState,
  activation,
  recoverable,
  onRecover,
}: Readonly<{
  card: Card;
  correction: CorrectionState;
  /**
   * Which activation to list, or null for all of them.
   *
   * Shared with the review workspace rather than chosen again here: a device that sets
   * its clock at activation gives successive runs the same timestamps, so a day heading
   * would otherwise mix recordings from different runs under one date.
   */
  activation: number | null;
  /** Whether the card tools are here, to point a card that will not open at Recover card. */
  recoverable: boolean;
  onRecover: () => void;
}>) {
  const { correction } = useClockCorrection(card, correctionState);
  const timezone = card.existingConfig?.timezone ?? 'UTC';
  // What the device measured itself running at, preferring a settled telemetry reading
  // over the one-off report taken when the clock was configured.
  const measuredHz = useMemo(() => {
    const settled = [...(card.log?.telemetry ?? [])]
      .reverse()
      .find((sample) => sample.sampleRateSettled && sample.measuredSampleRateHz);
    return settled?.measuredSampleRateHz ?? card.log?.pdmClock?.measuredHz ?? null;
  }, [card.log]);

  /**
   * The rate the divider arithmetic predicted, from the clock-configuration log event.
   *
   * This is how a clip's label is identified for what it is. A header carrying exactly this
   * value was written before the device had measured itself, so it holds a PREDICTION —
   * which assumes the oscillator runs at exactly its nominal frequency and is therefore the
   * least accurate label a clip can have. Any other value is a real measurement.
   *
   * Comparing against this is direct evidence, where inferring it from when the measurement
   * settled would only be a guess about timing.
   */
  const nominalHz = card.log?.pdmClock?.nominalHz ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<LoadedClip | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Levels for clips already opened, so browsing several builds up a picture. */
  const [examined, setExamined] = useState<Record<string, ClipVerdict>>({});
  /** Header rate per opened clip, so a card holding mixed rates shows it in the list. */
  const [examinedRates, setExaminedRates] = useState<Record<string, number>>({});
  const audioUrl = useRef<string | null>(null);

  const clips = useMemo(() => {
    const files = card.contents?.layout.files ?? [];
    return files
      .filter(
        (file) =>
          file.kind === 'audio' &&
          file.sizeBytes > 0 &&
          (activation === null || file.activationNumber === activation),
      )
      .map((file) => ({
        path: file.path,
        name: file.name,
        sizeBytes: file.sizeBytes,
        // Device time corrected the same way every other view corrects it.
        at: file.deviceTime && correction ? applyCorrection(file.deviceTime, correction) : file.deviceTime,
      }))
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  }, [card.contents, correction, activation]);

  const days = useMemo(() => {
    const grouped = new Map<string, typeof clips>();
    for (const clip of clips) {
      // Grouped by the LOCAL date at the deployment site. Slicing the ISO string grouped by
      // UTC date, which files a 01:00 recording under the previous day everywhere east of
      // Greenwich and the next day everywhere west of it.
      const key = clip.at ? localDateKey(clip.at, timezone) : UNDATED;
      const list = grouped.get(key) ?? [];
      list.push(clip);
      grouped.set(key, list);
    }
    // Chronological, with the undated bucket last. Map order is the order clips were
    // found, which put the card-root self-test clip first and made "Undated — 1
    // recording" the default day — hiding every real recording behind the dropdown.
    return [...grouped.entries()]
      .map(([date, items]) => ({ date, items }))
      .sort((a, b) => {
        if (a.date === UNDATED) return 1;
        if (b.date === UNDATED) return -1;
        return a.date.localeCompare(b.date);
      });
    // `timezone` too: the buckets are local dates, so a zone arriving after the clips —
    // which is what happens when the card's configuration loads second — would otherwise
    // leave every day keyed in the old one.
  }, [clips, timezone]);

  const activeDay = days.find((entry) => entry.date === day) ?? days[0];

  useEffect(
    () => () => {
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    },
    [],
  );

  /**
   * Open the day's first recording without being asked.
   *
   * The pane sat empty behind a "pick one on the left" placeholder, which on a card
   * holding thousands of recordings is a screen of nothing on arrival. Opening the first
   * one costs a single read and makes the view useful the moment it renders. Skipped when
   * the current selection already belongs to this day, so switching days moves the
   * selection but re-picking the same day does not fight the user.
   */
  useEffect(() => {
    const first = activeDay?.items[0];
    if (!first) return;
    if (selected && activeDay.items.some((clip) => clip.path === selected)) return;
    void open(first.path);
    // Keyed on the day alone: re-running whenever `selected` changes would reopen the
    // first clip the moment someone picked a different one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDay?.date]);

  const open = async (path: string) => {
    setSelected(path);
    setError(null);
    setLoading(true);
    setLoaded(null);
    try {
      const entry = card.contents!.entries.find((candidate) => candidate.path === path);
      if (!entry) throw new Error('This recording is no longer on the card.');

      const bytes = new Uint8Array(await (await entry.handle.getFile()).arrayBuffer());
      /*
        Opus recordings, which the editor offers and the device writes as Ogg.

        Every one of them used to fail here as "not a readable WAV recording", because this
        only ever parsed WAV. The browser decodes Ogg Opus itself, so the samples come from
        its decoder and playback uses the file as it is.
      */
      const opus = isOgg(bytes);
      const decoded = opus ? await decodeOpus(bytes) : null;
      const format = decoded?.format ?? readWavFormat(bytes);
      if (!format) throw new Error('This file is not a readable WAV or Opus recording.');

      const samples = decoded?.samples ?? readSamples(bytes, format);
      const levels = measureLevels(samples);
      const verdict = judgeClip(levels);

      // A corrected copy in memory, never on the card, so legacy and interrupted clips
      // both play at their true length.
      const playable = opus ? null : buildPlayableWav(bytes);
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = opus
        ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/ogg; codecs=opus' }))
        : playable
          ? URL.createObjectURL(new Blob([playable as BlobPart], { type: 'audio/wav' }))
          : null;

      setLoaded({
        path,
        codec: opus ? 'opus' : 'wav',
        format,
        levels,
        verdict,
        samples,
        envelope: waveformEnvelope(samples, 900),
        url: audioUrl.current,
      });
      setExamined((previous) => ({ ...previous, [path]: verdict }));
      setExaminedRates((previous) => ({ ...previous, [path]: format.sampleRateHz }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };


  // The loading panel above already says a card is being read; a second pane saying
  // there is no card contradicts it.
  if (card.status === 'scanning') return null;
  if (card.status !== 'ready' || !card.contents) {
    return (
      <div className="card">
        <h2>No card connected</h2>
        <p className="hint">Connect a card to listen to what it recorded.</p>
        <RecoverHint available={recoverable} onRecover={onRecover} />
      </div>
    );
  }
  if (isUndeployed(card.contents.layout)) {
    return <NotDeployed name={card.name} layout={card.contents.layout} config={card.existingConfig} configText={card.contents.configText} nothing="nothing to listen to" />;
  }
  if (!clips.length) {
    return (
      <div className="card">
        <h2>No recordings on this card</h2>
        <p className="hint">Nothing here is an audio file with anything in it.</p>
      </div>
    );
  }

  return (
    <>
      {!correction ? (
        <div className="banner">
          <strong>Times below are according to the device's own clock</strong>
          Configure a clock correction on the <TabLink to="review" /> tab to correct these for the real deployment time.
        </div>
      ) : null}

      <div className="clip-layout">
        <div className="card clip-list">
          <h2>{clips.length.toLocaleString()} recordings</h2>
          <div className="field">
            <label htmlFor="clip-day">Day</label>
            <select id="clip-day" value={activeDay?.date} onChange={(event) => setDay(event.target.value)}>
              {days.map((entry) => (
                <option key={entry.date} value={entry.date}>
                  {entry.date} — {entry.items.length.toLocaleString()}{' '}
                  {entry.items.length === 1 ? 'recording' : 'recordings'}
                </option>
              ))}
            </select>
          </div>

          <div className="clip-scroll">
            {(activeDay?.items ?? []).map((clip) => {
              const verdict = examined[clip.path];
              return (
                <button
                  key={clip.path}
                  className={`clip-row${selected === clip.path ? ' current' : ''}`}
                  onClick={() => void open(clip.path)}
                >
                  <span className="mono">{clip.at ? zonedClock(clip.at, timezone) : clip.name}</span>
                  <span className="clip-size">
                    {examinedRates[clip.path]
                      ? `${(examinedRates[clip.path] / 1000).toFixed(examinedRates[clip.path] % 1000 ? 2 : 0)} kHz`
                      : `${(clip.sizeBytes / 1024 / 1024).toFixed(1)} MB`}
                  </span>
                  {verdict ? <span className={`dot ${verdict.health}`} aria-label={verdict.headline} /> : null}
                </button>
              );
            })}
          </div>
          <p className="help">
            {Object.keys(examined).length
              ? `${Object.keys(examined).length} opened so far.`
              : 'Recordings are only ever read, never changed.'}
          </p>
        </div>

        <div className="card clip-detail">
          {loading ? <p className="hint">Reading…</p> : null}
          {error ? (
            <div className="issue error">
              <span className="marker">✕</span>
              <span>{error}</span>
            </div>
          ) : null}
          {!loading && !error && !loaded ? (
            <>
              <h2>Choose a recording</h2>
              <p className="hint">
                Pick one on the left to see its waveform and levels, and to play it. Reading a recording
                never changes anything on the card.
              </p>
            </>
          ) : null}

          {loaded ? (
            <ClipDetail clip={loaded} measuredHz={measuredHz} nominalHz={nominalHz} />
          ) : null}
        </div>
      </div>
    </>
  );
}

interface LoadedClip {
  path: string;
  /** Opus levels come from a lossy decode, so bit depth and header checks do not apply. */
  codec: 'wav' | 'opus';
  format: NonNullable<ReturnType<typeof readWavFormat>>;
  levels: ClipLevels;
  verdict: ClipVerdict;
  envelope: ReturnType<typeof waveformEnvelope>;
  /** Kept so narrowing the frequency range can recompute at a finer window. */
  samples: Int16Array;
  url: string | null;
}

function ClipDetail({
  clip,
  measuredHz,
  nominalHz,
}: Readonly<{
  clip: LoadedClip;
  measuredHz: number | null;
  /** The predicted rate, for telling a predicted label apart from a measured one. */
  nominalHz: number | null;
}>) {
  const audio = useRef<HTMLAudioElement>(null);
  const [seconds, setSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const nyquist = clip.format.sampleRateHz / 2;
  const [maxHz, setMaxHz] = useState<number | null>(null);
  const [rangeDb, setRangeDb] = useState(60);

  const bands = useMemo(
    () => [1, 2, 4, 8, 16].map((divisor) => nyquist / divisor).filter((hz) => hz >= 100),
    [nyquist],
  );

  /**
   * A first pass at full bandwidth, used only to find where the energy is.
   *
   * Cheap relative to the fine pass below, and it is what lets the view open on the
   * band that actually holds signal instead of on a black rectangle.
   */
  const [survey, setSurvey] = useState<Spectrogram | null>(null);
  useEffect(() => {
    let abandoned = false;
    setSurvey(null);
    void computeSpectrogramAsync(clip.samples, {
      sampleRateHz: clip.format.sampleRateHz,
      fftSize: suggestedFftSize(clip.format.sampleRateHz),
      columns: 400,
    }).then(
      (result) => {
        if (!abandoned) setSurvey(result);
      },
      () => {
        if (!abandoned) setSurvey(null);
      },
    );
    return () => {
      abandoned = true;
    };
  }, [clip.samples, clip.format.sampleRateHz]);

  // The narrowest offered band that still contains almost all the energy.
  const suggestedBand = useMemo(() => {
    if (!survey) return null;
    const ceiling = energyCeilingHz(survey);
    return [...bands].sort((a, b) => a - b).find((hz) => hz >= ceiling) ?? nyquist;
  }, [survey, bands, nyquist]);

  const shownHz = maxHz ?? suggestedBand;

  // Recomputed rather than cropped: narrowing the range without a finer window just
  // stretches a handful of rows over the whole height.
  /*
    The drawn spectrogram, and the band it was drawn for.

    Keeping the previous image on screen while the next one computes matters: blanking it
    on every change of the frequency selector makes a 400ms recompute look like a fault.
    `drawnFor` says whether what is on screen is the band currently selected.
  */
  const [rendered, setRendered] = useState<{ drawnFor: number | null; spectrogram: Spectrogram | null }>({
    drawnFor: null,
    spectrogram: null,
  });
  useEffect(() => {
    if (shownHz === null) return;
    let abandoned = false;
    void computeSpectrogramAsync(clip.samples, {
      sampleRateHz: clip.format.sampleRateHz,
      fftSize: suggestedFftSize(clip.format.sampleRateHz, shownHz),
      columns: 1000,
    }).then(
      (result) => {
        if (!abandoned) setRendered({ drawnFor: shownHz, spectrogram: result });
      },
      () => {
        if (!abandoned) setRendered({ drawnFor: shownHz, spectrogram: null });
      },
    );
    return () => {
      abandoned = true;
    };
  }, [clip.samples, clip.format.sampleRateHz, shownHz]);

  const spectrogram = rendered.spectrogram;
  /** A selection whose image has not finished computing yet. */
  const computing = shownHz === null || rendered.drawnFor !== shownHz;

  // A new clip gets its own suggestion rather than the last one's choice.
  useEffect(() => setMaxHz(null), [clip.path]);

  // Polled on an animation frame rather than driven by `timeupdate`, which fires about
  // four times a second and would make the head visibly stutter along.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      if (audio.current) setSeconds(audio.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // A newly chosen clip starts at the beginning, whatever the last one was doing.
  useEffect(() => {
    setSeconds(0);
    setPlaying(false);
  }, [clip.path]);

  const duration = clip.format.durationSeconds || 1;
  /**
   * Space starts and stops playback from anywhere in the audio tools.
   *
   * Scoped to this panel rather than the document so it cannot fight a space press in a
   * form field elsewhere, and it ignores the event when the focus is on a control that
   * already uses space — a button or a select would otherwise do two things at once.
   */
  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== ' ' && event.code !== 'Space') return;
    const target = event.target as HTMLElement;
    if (target.closest('button, select, input, textarea, a[href]')) return;
    const player = audio.current;
    if (!player) return;
    event.preventDefault();
    if (player.paused) void player.play();
    else player.pause();
  };

  const seek = (fraction: number) => {
    const target = Math.max(0, Math.min(1, fraction)) * duration;
    if (audio.current) audio.current.currentTime = target;
    setSeconds(target);
  };

  return (
    // tabIndex so the panel itself can hold focus, which is what makes Space work after a
    // click on the waveform or the spectrogram rather than only on the player.
    <div onKeyDown={onPanelKeyDown} tabIndex={-1} className="clip-detail">
      <h2 className="mono">{clip.path.split('/').pop()}</h2>
      <p className="hint">
        <strong>{clip.format.sampleRateHz.toLocaleString()} Hz</strong> ·{' '}
        {clip.format.channels === 1 ? 'mono' : `${clip.format.channels} channels`} ·{' '}
        {clip.format.durationSeconds.toFixed(1)} seconds
        {clip.codec === 'opus' ? ' · Opus, decoded for display' : ''}
      </p>
      {rateNote(clip.format.sampleRateHz, measuredHz, nominalHz)}

      <Waveform
        envelope={clip.envelope}
        health={clip.verdict.health}
        progress={seconds / duration}
        onSeek={seek}
      />
      <div className="clip-times mono">
        <span>{formatClock(seconds)}</span>
        <span>{formatClock(duration)}</span>
      </div>

      <div className="row spectro-controls">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="spectro-max">Show spectrogram up to</label>
          <select id="spectro-max" value={shownHz ?? ''} onChange={(event) => setMaxHz(Number(event.target.value))}>
            {bands.map((hz) => (
              <option key={hz} value={hz}>
                {hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${Math.round(hz)} Hz`}
                {hz === suggestedBand ? ' — where the signal is' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="spectro-range">Contrast</label>
          <select id="spectro-range" value={rangeDb} onChange={(event) => setRangeDb(Number(event.target.value))}>
            <option value={40}>High — 40 dB</option>
            <option value={60}>Normal — 60 dB</option>
            <option value={90}>Low — 90 dB</option>
          </select>
        </div>
      </div>

      {/*
        The previous image stays up while the next one computes, dimmed, so a change of
        band reads as the picture being redrawn rather than as the view breaking.
      */}
      <div className={`spectro-frame${computing ? ' computing' : ''}`}>
        {spectrogram && shownHz !== null ? (
          <SpectrogramView
            spectrogram={spectrogram}
            maxHz={rendered.drawnFor ?? shownHz}
            rangeDb={rangeDb}
            progress={seconds / duration}
            duration={duration}
            onSeek={seek}
          />
        ) : (
          <div className="spectro-placeholder" />
        )}
        {computing ? <span className="spectro-status">Drawing the spectrogram…</span> : null}
      </div>
      {/*
        Describes the band ACTUALLY shown, not the one it opened on. The old wording said
        "the range opens on…" forever, which stopped being true the moment anyone used the
        selector above it.
      */}
      <p className="help">
        Brighter is louder.{' '}
        {shownHz !== null && suggestedBand !== null && shownHz === suggestedBand
          ? "Showing the range holding almost all of this clip's energy"
          : 'Showing the range you selected'}
        {spectrogram ? ` at ${spectrogram.frequencyStepHz.toFixed(1)} Hz per row` : ''}. A narrower
        range resolves more detail; a wider one shows more of the spectrum.
      </p>

      {clip.url ? (
        <audio
          ref={audio}
          className="clip-audio"
          controls
          src={clip.url}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onSeeked={() => audio.current && setSeconds(audio.current.currentTime)}
        />
      ) : (
        <p className="help">This recording holds no audio to play.</p>
      )}

      <div className={`banner ${TONE[clip.verdict.health]}`} style={{ marginTop: 14, marginBottom: 14 }}>
        <strong>{clip.verdict.headline}</strong>
        {clip.verdict.detail}
      </div>

      <div className="grid stats">
        <Stat label="Peak" value={`${fmtDb(clip.levels.peakDbfs)} dBFS`} />
        <Stat label="Average" value={`${fmtDb(clip.levels.rmsDbfs)} dBFS`} />
        <Stat label="Offset" value={clip.levels.dcOffset.toFixed(0)} note="0 is centered" />
        <Stat
          label="Resolution"
          value={clip.codec === 'opus' ? '—' : clip.levels.effectiveBits ? `${clip.levels.effectiveBits} bits` : '—'}
          note={clip.codec === 'opus' ? 'not measurable after Opus compression' : 'originally recorded with 12 bits'}
        />
      </div>

      {clip.codec === 'wav' && clip.format.declaredDataBytes !== clip.format.actualDataBytes ? (
        <p className="help">
          The header claims {clip.format.declaredDataBytes.toLocaleString()} bytes of audio but the file
          holds {clip.format.actualDataBytes.toLocaleString()}. Playback above uses the true length; the
          file on the card is untouched.
        </p>
      ) : null}
    </div>
  );
}

const TONE: Record<string, string> = { ok: 'ok', quiet: 'warn', clipping: 'warn', dead: 'crit' };
const fmtDb = (value: number) => (Number.isFinite(value) ? value.toFixed(1) : '−∞');

/**
 * The clip drawn as one vertical bar per pixel column.
 *
 * Both extremes of each bucket are kept, so a single loud transient in a minute of quiet
 * still shows — which on a monitoring recording is the whole event worth seeing.
 */
function Waveform({
  envelope,
  health,
  progress,
  onSeek,
}: Readonly<{
  envelope: LoadedClip['envelope'];
  health: string;
  progress: number;
  onSeek: (fraction: number) => void;
}>) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext('2d');
    if (!context) return;

    const ratio = window.devicePixelRatio || 1;
    const width = element.clientWidth;
    const height = element.clientHeight;
    element.width = width * ratio;
    element.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const styles = getComputedStyle(element);
    const middle = height / 2;

    context.strokeStyle = styles.getPropertyValue('--line-2').trim() || '#ccc';
    context.beginPath();
    context.moveTo(0, middle);
    context.lineTo(width, middle);
    context.stroke();

    // Scaled to the loudest sample rather than to full scale: these recordings sit tens
    // of dB below the ceiling, and drawing them against it would show a flat line.
    let peak = 1;
    for (const point of envelope) peak = Math.max(peak, Math.abs(point.min), Math.abs(point.max));

    context.strokeStyle =
      styles.getPropertyValue(health === 'dead' ? '--crit' : health === 'ok' ? '--primary' : '--warn').trim() ||
      '#3a7';
    context.beginPath();
    for (const [index, point] of envelope.entries()) {
      const x = (index / envelope.length) * width;
      context.moveTo(x, middle - (point.max / peak) * middle * 0.94);
      context.lineTo(x, middle - (point.min / peak) * middle * 0.94);
    }
    context.stroke();
  }, [envelope, health]);

  return (
    <div
      className="waveform-wrap"
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        onSeek((event.clientX - bounds.left) / bounds.width);
      }}
      role="presentation"
    >
      <canvas ref={canvas} className="waveform" />
      {/* An element rather than another canvas pass: moving it costs no redraw of the
          900 segments behind it. */}
      <div className="playhead" style={{ left: `${Math.max(0, Math.min(1, progress)) * 100}%` }} />
    </div>
  );
}

/**
 * The spectrogram drawn as an image, one pixel per column and per frequency bin.
 *
 * Built at the data's own resolution and scaled up by the canvas, rather than looping
 * over display pixels — a clip produces a thousand columns by a couple of thousand bins
 * and blitting that once is far cheaper than painting rectangles.
 */
function SpectrogramView({
  spectrogram,
  maxHz,
  rangeDb,
  progress,
  duration,
  onSeek,
}: Readonly<{
  spectrogram: Spectrogram;
  maxHz: number;
  rangeDb: number;
  progress: number;
  /** Clip length in seconds, for the time axis. */
  duration: number;
  onSeek: (fraction: number) => void;
}>) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;

    const binsShown = Math.max(1, frequencyBin(maxHz, spectrogram) + 1);
    const source = document.createElement('canvas');
    source.width = spectrogram.columns;
    source.height = binsShown;
    const sourceContext = source.getContext('2d');
    if (!sourceContext) return;

    const image = sourceContext.createImageData(spectrogram.columns, binsShown);
    // Scaled to the loudest point in this clip rather than to full scale. These
    // recordings sit tens of dB down, and a fixed ceiling would render them black.
    const ceiling = spectrogram.peakDb;
    const floor = ceiling - rangeDb;

    for (let x = 0; x < spectrogram.columns; x++) {
      for (let y = 0; y < binsShown; y++) {
        // Low frequencies at the bottom, as every other tool in the field draws them.
        const bin = binsShown - 1 - y;
        const db = spectrogram.data[x * spectrogram.bins + bin];
        const [r, g, b] = heat(Math.max(0, Math.min(1, (db - floor) / (ceiling - floor))));
        const at = (y * spectrogram.columns + x) * 4;
        image.data[at] = r;
        image.data[at + 1] = g;
        image.data[at + 2] = b;
        image.data[at + 3] = 255;
      }
    }
    sourceContext.putImageData(image, 0, 0);

    const ratio = window.devicePixelRatio || 1;
    element.width = element.clientWidth * ratio;
    element.height = element.clientHeight * ratio;
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, element.width, element.height);
  }, [spectrogram, maxHz, rangeDb]);

  const labels = [1, 0.75, 0.5, 0.25, 0].map((fraction) => ({
    fraction,
    hz: maxHz * fraction,
  }));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * duration);
  const inKilohertz = maxHz >= 2000;

  return (
    <>
      <div className="spectro-wrap">
      <div className="spectro-axis">
        <span className="spectro-unit">{inKilohertz ? 'kHz' : 'Hz'}</span>
        {labels.map((label) => (
          <span key={label.fraction}>
            {inKilohertz ? (label.hz / 1000).toFixed(1) : Math.round(label.hz)}
          </span>
        ))}
      </div>
      <div
        className="spectro-plot"
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          onSeek((event.clientX - bounds.left) / bounds.width);
        }}
        role="presentation"
      >
        <canvas ref={canvas} className="spectrogram" />
        <div className="playhead" style={{ left: `${Math.max(0, Math.min(1, progress)) * 100}%` }} />
      </div>
      </div>
      <div className="spectro-time">
        <span className="spectro-unit">time</span>
        <div className="spectro-ticks">
          {ticks.map((seconds, index) => (
            <span key={index}>{formatClock(seconds)}</span>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * Dark to bright through blue, green, and yellow.
 *
 * Monotonic in lightness so that louder always looks brighter — a color ramp that dips
 * would invent structure in the picture that is not in the audio.
 */
function heat(t: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [8, 8, 24]],
    [0.25, [34, 46, 122]],
    [0.5, [26, 128, 128]],
    [0.75, [138, 196, 74]],
    [1.0, [252, 250, 190]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Explains a clip's sample-rate label, when there is anything to explain.
 *
 * Two genuinely different situations share this space:
 *
 *  - The label IS the prediction. The clip closed before the device had measured itself, so
 *    the header carries divider arithmetic that assumes a perfectly nominal oscillator. On the
 *    reference deployment that was 51 Hz out where a measurement would have been 7 Hz out, so
 *    this one is worth saying plainly.
 *
 *  - The label is a measurement, just an earlier one than the deployment's final reading.
 *    Expected, and only worth mentioning if the gap is bigger than ordinary drift.
 */
function rateNote(labeledHz: number, measuredHz: number | null, nominalHz: number | null) {
  if (!measuredHz || labeledHz <= 0) return null;

  const difference = Math.abs(measuredHz - labeledHz);
  const percent = Math.abs((measuredHz / labeledHz - 1) * 100).toFixed(2);
  const direction = measuredHz > labeledHz ? 'faster' : 'slower';

  if (nominalHz !== null && labeledHz === nominalHz && difference > 0) {
    return (
      <p className="help">
        This file is labeled <strong>{labeledHz.toLocaleString()} Hz</strong>, which is the rate
        predicted from the clock dividers rather than a measurement — this clip closed before the
        device had timed itself against the clock. The device went on to measure{' '}
        <strong>{measuredHz.toLocaleString()} Hz</strong>, {percent}% {direction}. The audio is
        unaffected, but prefer the measured rate for anything derived from sample counts.
      </p>
    );
  }

  // A label that differs only because the running estimate kept refining is not worth
  // remarking on — both figures are usable and the difference is fractions of a percent.
  return null;
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function Stat({ label, value, note }: Readonly<{ label: string; value: string; note?: string }>) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

/** Ogg pages begin "OggS", which is how the device's Opus files are told from WAV. */
function isOgg(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
}

/**
 * Decodes an Ogg Opus file to 16-bit samples with the browser's own decoder.
 *
 * Opus always decodes at 48 kHz, which is the rate the context is created at, so nothing is
 * resampled on the way. Only the first channel is kept; the device records mono.
 */
async function decodeOpus(
  bytes: Uint8Array,
): Promise<{ samples: Int16Array; format: NonNullable<ReturnType<typeof readWavFormat>> }> {
  const context = new OfflineAudioContext(1, 1, 48000);
  let buffer: AudioBuffer;
  try {
    buffer = await context.decodeAudioData(bytes.slice().buffer);
  } catch {
    throw new Error('This Opus recording could not be decoded. It may have been cut off before the device closed it.');
  }
  const channel = buffer.getChannelData(0);
  const samples = new Int16Array(channel.length);
  for (let i = 0; i < channel.length; i++) samples[i] = Math.max(-32768, Math.min(32767, Math.round(channel[i] * 32767)));
  return {
    samples,
    format: {
      channels: buffer.numberOfChannels,
      sampleRateHz: buffer.sampleRate,
      bitsPerSample: 16,
      dataOffset: 0,
      declaredDataBytes: samples.length * 2,
      actualDataBytes: samples.length * 2,
      durationSeconds: buffer.duration,
    },
  };
}
