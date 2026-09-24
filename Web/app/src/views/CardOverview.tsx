import {
  formatZonedDisplay,
  type ParsedLog,
  applyCorrection,
  buildCoverage,
  buildTrack,
  cardSlack,
  formatAllocationUnit,
  formatList,
  DEACTIVATION_REASON_LABELS,
  UNPLANNED_STOP_REASONS,
  describeCorrection,
  planRename,
  type ClockCorrection,
  type CorrectionMethod,
} from '@a3em/config-schema';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { useCard } from '../lib/useCard';
import { deviceTime, zonedTime } from '../lib/cardTime';
import { parseLogsAsync } from '../lib/parse-logs-async';
import { useClockCorrection } from '../lib/useClockCorrection';
import type { CorrectionState } from '../App';
import { TimeSeriesChart } from '../components/TimeSeriesChart';
import { SelfTestPanel } from '../components/SelfTestPanel';
import { CoverageHeatmap } from '../components/CoverageHeatmap';
import { TrackMap } from '../components/TrackMap';
import { Pane } from '../components/Pane';
import type { CardDevice } from '../lib/useCardDevice';
import { loadPhysicalCard } from '../lib/helperViews';
import { RecoverHint } from '../components/RecoverHint';
import type { Helper } from '../lib/useHelper';

type Card = ReturnType<typeof useCard>;

/** Only with the card helper, so loaded separately: see `helperViews`. */
const PhysicalCard = lazy(() => loadPhysicalCard().then((module) => ({ default: module.PhysicalCard })));

/**
 * How many lifecycle events one page of the log shows.
 *
 * A run that goes wrong writes far more of these than one that goes right: a soak whose
 * watchdog was resetting it every few minutes produced hundreds. Cutting the list off at
 * forty hid exactly the part worth reading, so the tail is paged rather than dropped.
 */
const EVENTS_PER_PAGE = 40;

/**
 * What a card says about the deployment it just came back from.
 *
 * Ordered by the questions actually asked on retrieval: did the hardware work, did it
 * run to plan, and is the data intact. Everything here comes from names, sizes, and the
 * logs — no audio is read, so it stays fast on a full card.
 */
export function CardOverview({
  card,
  correction: state,
  onCorrectionChange,
  activation,
  helper,
  cardDevice,
  onRecover,
}: Readonly<{
  card: Card;
  correction: CorrectionState;
  onCorrectionChange: (state: CorrectionState) => void;
  /** Which activation to show, or null for all of them together. */
  activation: number | null;
  helper: Helper;
  /** The physical card the open folder is on, where the card helper can tell. */
  cardDevice: CardDevice;
  onRecover: () => void;
}>) {
  const { enteredTime, manualOffset } = state;
  const setChosenMethod = (method: CorrectionMethod) => onCorrectionChange({ ...state, method });
  const setEnteredTime = (value: string) => onCorrectionChange({ ...state, enteredTime: value });
  const setManualOffset = (value: string) => onCorrectionChange({ ...state, manualOffset: value });

  const { options, selected, correction } = useClockCorrection(card, state);

  /**
   * Everything below is scoped to the chosen activation.
   *
   * The log is re-parsed from only that activation's files rather than filtered after
   * the fact, so the derived values — telemetry, lifecycle, restart counts, self-tests —
   * describe one run rather than several runs interleaved.
   */
  const logs = card.contents?.logs ?? [];
  /**
   * The scoped log, and which activation it actually describes.
   *
   * Re-scoping runs on a worker, so it resolves a beat after the click. Holding the
   * previous run's log until the new one arrives keeps the charts drawn rather than
   * blanking them for a frame; `scopedFor` says whether what is on screen is the run that
   * is currently selected.
   */
  const [scopedLog, setScopedLog] = useState<{ scopedFor: number | null; log: ParsedLog | null }>({
    scopedFor: null,
    log: card.log,
  });

  useEffect(() => {
    if (activation === null || logs.length === 0) {
      setScopedLog({ scopedFor: activation, log: card.log });
      return;
    }
    let abandoned = false;
    // Every log, filtered by attribution inside the parser — not just the logs whose path
    // names an activation. A card that pools its runs into one file is separated by the
    // `ACTIVATED` markers, or by the legacy `Current activation is #N` lines.
    void parseLogsAsync(logs, { activation }).then(
      (parsed) => {
        if (!abandoned) setScopedLog({ scopedFor: activation, log: parsed });
      },
      () => {
        // Falling back to the whole card is wrong in a way the user can see, so the
        // selection is left showing what it had rather than silently widening.
        if (!abandoned) setScopedLog({ scopedFor: activation, log: card.log });
      },
    );
    return () => {
      abandoned = true;
    };
    // `logs` is deliberately absent. It is `card.contents?.logs ?? []`, a fresh array on
    // every render, so depending on it would re-parse the card forever; `card.contents`
    // is the value it derives from and changes exactly when it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.contents, card.log, activation]);

  const log = scopedLog.log;
  /** A click that has not finished re-scoping yet. */
  const rescoping = scopedLog.scopedFor !== activation;

  /**
   * True when a run was asked for but the log cannot say which lines belong to it.
   *
   * Silently showing the whole card in that case is what made the charts look frozen:
   * every activation drew the same trace, with nothing on screen explaining why.
   */
  const logUnattributed =
    !rescoping && activation !== null && (log?.activationsAttributed.length ?? 0) === 0;

  /**
   * Whether re-scoping is taking long enough to be worth mentioning.
   *
   * Most runs re-scope in tens of milliseconds, and flashing a notice for that long reads
   * as a glitch. A run holding most of a long deployment's log takes seconds, and there
   * silence reads as a dead click — so the notice waits before appearing.
   */
  // Reset to the first page whenever a different log is in front of the reader, so that
  // picking another activation does not land them deep inside a list they have not seen.
  const [eventPage, setEventPage] = useState(0);
  useEffect(() => setEventPage(0), [log]);
  const [slowRescope, setSlowRescope] = useState(false);
  useEffect(() => {
    if (!rescoping) {
      setSlowRescope(false);
      return;
    }
    const timer = setTimeout(() => setSlowRescope(true), 400);
    return () => clearTimeout(timer);
  }, [rescoping]);

  const audioFiles = useMemo(
    () =>
      (card.contents?.layout.files ?? []).filter(
        (file) =>
          file.kind === 'audio' && (activation === null || file.activationNumber === activation),
      ),
    [card.contents, activation],
  );

  /** Counts for the chosen activation, so the headline figures follow the selection. */
  const scoped = useMemo(() => {
    const files = (card.contents?.layout.files ?? []).filter(
      (file) => activation === null || file.activationNumber === activation,
    );
    return {
      audioCount: files.filter((file) => file.kind === 'audio').length,
      imuCount: files.filter((file) => file.kind === 'imu').length,
      audioBytes: files
        .filter((file) => file.kind === 'audio')
        .reduce((sum, file) => sum + file.sizeBytes, 0),
    };
  }, [card.contents, activation]);

  /** Recording times as corrected, which is what the coverage grid must be built from. */
  const coverage = useMemo(
    () =>
      buildCoverage({
        recordings: audioFiles
          .map((file) => ({
            at: file.deviceTime && correction ? applyCorrection(file.deviceTime, correction) : file.deviceTime,
            sizeBytes: file.sizeBytes,
          })),
        config: card.existingConfig,
        timezone: card.existingConfig?.timezone ?? 'UTC',
      }),
    [audioFiles, card.existingConfig, correction],
  );

  /**
   * What, if anything, on this card needs a person to look at it.
   *
   * Deliberately assembled from the same values the panels below render, so it can never
   * disagree with them — it decides ORDER of attention, not truth.
   */
  const verdict = useMemo(() => {
    const findings: string[] = [];
    const selfTest = card.selfTest;
    if (selfTest && !selfTest.passed) findings.push(`The hardware self-test failed on ${selfTest.failedSubsystem}.`);
    const restartInfo = log?.restarts ?? null;
    if (restartInfo?.hadFault) findings.push('The device came back from a fault, so there is a gap where it was restarting.');
    else if (restartInfo && restartInfo.maxResetsInEpoch > 0) findings.push(`${restartInfo.maxResetsInEpoch} restart${restartInfo.maxResetsInEpoch === 1 ? '' : 's'} happened without the device losing power.`);
    if (log?.clockRecovery) findings.push('The clock was lost and rebuilt from the card, so subsequent times may show internal discrepancies.');
    if (log?.configResult === 'CORRECTED') findings.push('The device had to correct the configuration file, so it ran with settings nobody chose.');
    else if (log?.configResult === 'FAIL') findings.push('The device could not read the configuration file.');
    // FIRMWARE: logged as SOLAR_REVERSED on each day a solar window ended before it started.
    const reversed = log?.solarSchedule?.reversedDays ?? 0;
    if (reversed) {
      findings.push(
        `On ${reversed.toLocaleString()} day${reversed === 1 ? '' : 's'} a solar recording period ended before it started, so the device skipped it.`,
      );
    }
    if (coverage.gaps.length) findings.push(`${coverage.gaps.length.toLocaleString()} scheduled hour${coverage.gaps.length === 1 ? '' : 's'} recorded nothing.`);

    const bad = (selfTest && !selfTest.passed) || restartInfo?.hadFault || log?.configResult === 'FAIL';
    if (bad) return { tone: 'crit', headline: 'This deployment needs looking at', detail: 'Something failed outright. The panels below have the detail.', findings };
    if (findings.length) return { tone: 'warn', headline: 'The deployment was successful, but some caveats are worth mentioning', detail: '', findings };
    /*
      Only what this card can actually show.

      An original-firmware card carries no self-test and no restart record, so saying "the
      hardware passed its checks and the device ran without restarting" asserted two things
      nobody could know. Each claim is made only when its evidence is on the card, and what
      could not be checked is named.
    */
    const shown: string[] = [];
    const unchecked: string[] = [];
    (selfTest ? shown : unchecked).push(selfTest ? 'the hardware passed its checks' : 'hardware self-tests');
    (restartInfo ? shown : unchecked).push(restartInfo ? 'the device ran without restarting' : 'restarts');
    (coverage.expectationsUnknown ? unchecked : shown).push(
      coverage.expectationsUnknown ? 'recording coverage' : 'every scheduled hour recorded',
    );
    const sentence = shown.length ? `${formatList(shown).replace(/^./, (c) => c.toUpperCase())}.` : '';
    const caveat = unchecked.length ? ` This card does not record ${formatList(unchecked)}, so those could not be checked.` : '';
    return { tone: 'ok', headline: 'Nothing on this card needs attention', detail: `${sentence}${caveat}`.trim(), findings };
  }, [card.selfTest, log, coverage]);

  /** The self-test capture, paired back up with the handle needed to read it. */
  const selfTestClip = useMemo(() => {
    const file = card.contents?.layout.files.find((entry) => entry.kind === 'self-test-clip');
    if (!file) return null;
    const entry = card.contents?.entries.find((candidate) => candidate.path === file.path);
    return entry ? { path: file.path, sizeBytes: file.sizeBytes, handle: entry.handle } : null;
  }, [card.contents]);

  /**
   * What the correction would change, for reporting only.
   *
   * The plan is still worth showing here — it says how many recordings the correction
   * touches — but applying it belongs to Check & copy, where it lands on the copy instead
   * of on the card.
   */
  const renamePlan = useMemo(
    () => (correction && card.contents ? planRename(card.contents.layout, correction) : null),
    [correction, card.contents],
  );

  /**
   * Telemetry on the corrected clock, for anything plotted against time.
   *
   * The charts read their own x-axis from these timestamps, so leaving them uncorrected
   * put the traces on a different clock from every date on the page around them.
   */
  const plotted = useMemo(() => {
    const samples = log?.telemetry ?? [];
    if (!correction) return samples;
    return samples.map((sample) => ({ ...sample, timestamp: applyCorrection(sample.timestamp, correction) }));
  }, [log, correction]);

  const track = useMemo(() => buildTrack(log?.telemetry ?? []), [log]);
  /*
    The span the trace covers, which is the one thing a shut chart should still say.

    ABOVE the early returns, with every other hook. It was below them, which meant this
    useMemo ran only once the card reached `ready` — so finishing a scan while on this page
    changed the hook count mid-life and React unmounted the whole tree to a blank screen.
    Arriving with a card already read mounted it in the ready state from the start, which
    is why it only broke when the scan was started from here.
  */
  const temperatureRange = useMemo(() => {
    const values = (log?.telemetry ?? []).map((t) => t.temperatureC).filter((v) => Number.isFinite(v));
    if (!values.length) return undefined;
    return `${Math.min(...values).toFixed(0)} – ${Math.max(...values).toFixed(0)} °C`;
  }, [log]);

  /**
   * How the card's own geometry was spent.
   *
   * Only computable when the device recorded its allocation unit: the same files on a
   * 4 kB card and a 512 kB card carry wildly different amounts of tail space, and
   * nothing in the file listing reveals which one it was.
   */
  const storage = useMemo(() => {
    const unit = card.deviceInfo?.cardAllocationUnitBytes;
    if (!unit || !card.contents) return null;
    return {
      unit,
      report: cardSlack(
        card.contents.layout.files.map((file) => file.sizeBytes),
        unit,
      ),
    };
  }, [card.deviceInfo, card.contents]);


  // The loading panel above already says a card is being read; a second pane saying
  // there is no card contradicts it.
  if (card.status === 'scanning') return null;
  if (card.status !== 'ready' || !card.contents) {
    return (
      <div className="card">
        <h2>No card connected</h2>
        <p className="hint">
          Connect an SD card to see what a deployment recorded, how the hardware behaved, and whether
          anything on the card is unreadable.
        </p>
        <RecoverHint available={helper.status === 'ready'} onRecover={onRecover} />
      </div>
    );
  }

  const { layout, unreadable } = card.contents;
  const telemetry = log?.telemetry ?? [];
  const health = log?.microphoneHealth ?? [];
  // Only firmware from 2026.08 onward reports these, so a legacy card shows nothing
  // rather than a row of confident zeros it never measured.
  const lifecycle = log?.lifecycle ?? [];
  const restarts = log?.restarts ?? null;
  // Whether ANY lifecycle event carries a time. Current firmware writes no timestamp
  // prefix on log lines, which would otherwise render a column of nothing but dashes.
  const lifecycleDated = lifecycle.some((event) => event.timestamp);
  const eventPageCount = Math.max(1, Math.ceil(lifecycle.length / EVENTS_PER_PAGE));
  // Clamped rather than trusted: a shorter log can arrive in the same render that resets
  // the page, and a stale index would otherwise page past the end of the new list.
  const eventPageIndex = Math.min(eventPage, eventPageCount - 1);
  const eventPageStart = eventPageIndex * EVENTS_PER_PAGE;
  const visibleEvents = lifecycle.slice(eventPageStart, eventPageStart + EVENTS_PER_PAGE);
  // The zone the schedule was written in, so the axes read the way the deployment did.
  const chartTimezone = card.existingConfig?.timezone ?? 'UTC';
  const latestDiagnostics = [...telemetry].reverse().find((sample) => sample.sdWriteFailures !== null) ?? null;
  const batteryStart = telemetry[0]?.batteryMv;
  const batteryEnd = telemetry.at(-1)?.batteryMv;

  return (
    <>
      {/* The card as hardware, first: whether the recorder would erase it outranks what it holds. */}
      {cardDevice.device ? (
        <Suspense fallback={null}>
          <PhysicalCard cardDevice={cardDevice} helper={helper} onReopened={() => void card.rescan()} />
        </Suspense>
      ) : null}

      {slowRescope ? (
        <div className="banner">
          <strong>Reading activation {activation}</strong>
          Working through this run's share of the device log. The page stays usable while it runs.
        </div>
      ) : null}

      {logUnattributed ? (
        <div className="banner warn">
          <strong>The log on this card cannot be split by activation</strong>
          It carries no activation directory and no activation markers, so clip counts and coverage
          below follow your selection but the device log — self-tests, restarts, battery, and
          temperature — is shown for the whole card.
        </div>
      ) : null}

      {/*
        A verdict before the evidence.

        Ten panels of equal weight meant a restart warning and a routine stat block read
        at the same volume, so the page had to be read in full to learn whether anything
        was wrong. This answers that first and names only what actually needs attention —
        it deliberately carries no numbers the panels below already state.
      */}
      <Pane
        id="deployment-verdict"
        title="How this deployment went"
        // The verdict itself, shortened. The headlines are full sentences by design, which
        // is right in the banner and too long for a header row.
        note={
          <span className={verdict.tone === 'ok' ? 'ok' : verdict.tone}>
            {verdict.tone === 'ok'
              ? 'All clear'
              : `${verdict.findings.length} ${verdict.findings.length === 1 ? 'finding' : 'findings'}`}
          </span>
        }
      >
        <div className={`banner ${verdict.tone}`} style={{ marginTop: 12, marginBottom: verdict.findings.length ? 12 : 0 }}>
          <strong>{verdict.headline}</strong>
          {verdict.detail ? ` ${verdict.detail}` : null}
        </div>
        {verdict.findings.length ? (
          <ul className="verdict-list">
            {verdict.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        ) : null}
      </Pane>

      {card.deviceInfo && UNPLANNED_STOP_REASONS.has(card.deviceInfo.lastDeactivationReason) ? (
        <div className="banner warn">
          <strong>This deployment ended earlier than planned</strong>
          {DEACTIVATION_REASON_LABELS[card.deviceInfo.lastDeactivationReason]}
        </div>
      ) : null}

      {unreadable.length ? (
        <div className="banner crit">
          <strong>
            {unreadable.length.toLocaleString()} {unreadable.length === 1 ? 'file or folder' : 'files and folders'} could
            not be read
          </strong>
          These are what stop a bulk copy partway through while appearing to succeed. Everything else on the
          card was read normally.
        </div>
      ) : null}

      <Pane
        id="deployment"
        title="Deployment"
        note={`${scoped.audioCount.toLocaleString()} clips · ${(scoped.audioBytes / 1024 ** 3).toFixed(2)} GB`}
      >
        <p className="hint">
          {layout.deviceLabel ?? 'Unlabeled device'} ·{' '}
          {activation !== null
            ? `Activation ${activation} of ${formatList(layout.activations.map(String))}`
            : layout.activations.length === 1
              ? `Activation ${layout.activations[0]}`
              : `Activations ${formatList(layout.activations.map(String))} shown together`}
        </p>
        {/*
          Every time on this page comes from one clock or the other, and which one is not
          otherwise visible until you scroll to the correction card. Listen already says
          this in a banner; saying nothing here was the inconsistency.
        */}
        <p className="hint">
          <span className={`chip ${correction ? 'ok' : ''}`}>
            {correction ? `Times corrected — ${describeCorrection(correction)}` : "Times are shown using the device's internal clock"}
          </span>
        </p>
        <div className="grid stats">
          <Stat label="Audio clips" value={scoped.audioCount.toLocaleString()} />
          <Stat label="Motion files" value={scoped.imuCount.toLocaleString()} />
          <Stat label="Audio data" value={`${(scoped.audioBytes / 1024 ** 3).toFixed(2)} GB`} />
          <Stat
            label="Battery"
            value={batteryEnd != null ? `${(batteryEnd / 1000).toFixed(2)} V` : '—'}
            note={batteryStart != null && batteryEnd != null ? `from ${(batteryStart / 1000).toFixed(2)} V` : undefined}
          />
        </div>

        {/*
          The correction lives with the figures it reprices. The chip above states which
          clock every time on this page is on; this is the control that changes it, and
          separating the two put a claim in one pane and its remedy several panes below.
        */}
        <h3>Clock correction</h3>
        <p className="hint">
          The device set its clock to the <em>configured</em> start time when the magnet activated it, so
          every time on this card is off by however early or late it was actually activated. Since the
          device never learns the difference, that same offset applies for the whole deployment: establish
          it from one known moment below and every time in this app is shifted to match. The card itself is
          only ever read — corrected timestamps are written into the file names when you copy the
          recordings off, never onto the card.
        </p>

        <div className="field">
          <label htmlFor="method">How do you want to establish it?</label>
          <select id="method" value={selected.method} onChange={(event) => setChosenMethod(event.target.value as CorrectionMethod)}>
            {options.map((option) => (
              <option key={option.method} value={option.method} disabled={!option.available}>
                {option.prompt}
                {option.available ? '' : ' — not available for this card'}
              </option>
            ))}
          </select>
          <p className="help">{selected.rationale}</p>
        </div>

        {selected.method === 'gps' && selected.available ? (
          <div className="row">
            <div className="field">
              <label>Corrections recorded by the device</label>
              <div className="scroll-x">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Device clock read</th>
                      <th>True time was</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(log?.clockSyncs ?? []).map((sync) => (
                      <tr key={sync.beforeDeviceTime}>
                        <td className="mono">{zonedTime(sync.beforeDeviceTime, chartTimezone)}</td>
                        <td className="mono">{zonedTime(sync.afterTrueTime, chartTimezone)}</td>
                        <td>{sync.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="help">
                Recordings made before the first correction are shifted; everything after it is already
                true UTC and is left alone.
              </p>
            </div>
            <CorrectionResult correction={correction} renamePlan={renamePlan} />
          </div>
        ) : null}

        {selected.available && selected.method !== 'manual' && selected.method !== 'gps' ? (
          <div className="row">
            <div className="field">
              <label htmlFor="entered">{selected.prompt}</label>
              <input
                id="entered"
                type="datetime-local"
                value={enteredTime}
                onChange={(event) => setEnteredTime(event.target.value)}
              />
              <p className="help">
                The device believed this happened at{' '}
                <span className="mono">
                  {selected.deviceReference
                    ? `${formatZonedDisplay(selected.deviceReference, card.existingConfig?.timezone ?? 'UTC')} local time`
                    : '—'}
                </span>
              </p>
            </div>
            <CorrectionResult correction={correction} renamePlan={renamePlan} />
          </div>
        ) : null}

        {selected.method === 'manual' ? (
          <div className="row">
            <div className="field">
              <label htmlFor="offset">Offset in minutes</label>
              <input
                id="offset"
                type="number"
                value={manualOffset}
                onChange={(event) => setManualOffset(event.target.value)}
              />
              <p className="help">Positive if the device clock was running behind real time.</p>
            </div>
            <CorrectionResult correction={correction} renamePlan={renamePlan} />
          </div>
        ) : null}

        {!selected.available && selected.method !== 'manual' && selected.method !== 'gps' ? (
          <div className="issue warning">
            <span className="marker">!</span>
            <span>
              Choose another method above. Entering a time here would produce a number that looks like a
              clock error but is not one.
            </span>
          </div>
        ) : null}
      </Pane>

      <CoverageHeatmap grid={coverage} timezone={chartTimezone} />

      {storage ? (
        <Pane
          id="card-usage"
          title="How the card was used"
          note={`${formatAllocationUnit(storage.unit)} units · ${(storage.report.slackFraction * 100).toFixed(
            1,
          )}% in unused tails`}
        >
          <p className="hint">
            Every file rounds up to a whole allocation unit, so each one carries some unused space in
            its final cluster. On a card of small files that adds up.
          </p>
          <div className="grid stats">
            <Stat
              label="Allocation unit"
              value={formatAllocationUnit(storage.unit)}
              note={`${storage.report.fileCount.toLocaleString()} files`}
            />
            <Stat label="Recorded data" value={formatGb(storage.report.dataBytes)} />
            <Stat
              label="Space in unused tails"
              value={formatGb(storage.report.slackBytes)}
              note={`${(storage.report.slackFraction * 100).toFixed(1)}% of what the files occupy`}
            />
            {card.deviceInfo?.cardCapacityBytes ? (
              <Stat
                label="Card capacity"
                value={formatGb(card.deviceInfo.cardCapacityBytes)}
                note={
                  card.deviceInfo.cardFreeBytes != null
                    ? `${formatGb(card.deviceInfo.cardFreeBytes)} free at the last write`
                    : undefined
                }
              />
            ) : null}
          </div>
        </Pane>
      ) : null}



      {lifecycle.length ? (
        <Pane
          id="lifecycle"
          title="What the device did"
          note={`${lifecycle.length} events`}
          defaultOpen={lifecycle.length > 6 || Boolean(restarts?.hadFault) || (restarts?.maxResetsInEpoch ?? 0) > 0}
        >
          {/*
            The instructions introduce the table, so they lead. The restart verdict is a
            finding ABOUT that table and sits between the two.
          */}
          <p className="hint">
            Activations, phases, restarts, and self-tests, in order, from the device's own log.
            {lifecycleDated
              ? ''
              : ' This firmware does not stamp a time onto log lines, so the order is known but the times are not.'}
          </p>

          {restarts && (restarts.powerOnCount > 1 || restarts.maxResetsInEpoch > 0 || restarts.hadFault) ? (
            /*
              The headline and the explanation have to describe the SAME event.

              A reset within one power-on epoch and a fresh power-on are different things —
              the first keeps the battery connected, the second does not — and the copy used
              to announce the first and then explain the second, so a device that had never
              lost power was described as having been power-cycled.
            */
            <div className={`banner ${restarts.hadFault ? 'crit' : 'warn'}`}>
              <strong>
                {restarts.maxResetsInEpoch > 0
                  ? `${restarts.maxResetsInEpoch} restart${restarts.maxResetsInEpoch === 1 ? '' : 's'} without losing power`
                  : `${restarts.powerOnCount} separate power-ons`}
              </strong>
              {restarts.hadFault
                ? 'At least one was a fault rather than a deliberate restart. The recordings either ' +
                  'side of it are intact, but there is a gap where the device was restarting.'
                : restarts.maxResetsInEpoch > 0
                  ? 'The device restarted itself while still powered, so the battery stayed connected ' +
                    'throughout.'
                  : 'The device lost power and came back, which is what a battery change or a switch ' +
                    'off and on looks like.'}
            </div>
          ) : null}

          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  {lifecycleDated ? <th>Event time (deployment local)</th> : null}
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                {visibleEvents.map((event, index) => (
                  <tr key={`${event.timestamp}:${eventPageStart + index}`}>
                    {lifecycleDated ? (
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                        {deviceTime(event.timestamp, correction, chartTimezone)}
                      </td>
                    ) : null}
                    <td style={event.notable ? { color: 'var(--crit)' } : undefined}>{event.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {lifecycle.length > EVENTS_PER_PAGE ? (
            <div className="pager">
              <button
                type="button"
                className="btn small ghost"
                onClick={() => setEventPage(0)}
                disabled={eventPageIndex === 0}
              >
                First
              </button>
              <button
                type="button"
                className="btn small ghost"
                onClick={() => setEventPage(eventPageIndex - 1)}
                disabled={eventPageIndex === 0}
              >
                Previous
              </button>
              {/*
                The range, not just the page number: "events 441-480 of 686" answers where you
                are in the run, which a bare "page 12 of 18" does not.
              */}
              <p className="stat-note">
                Events {(eventPageStart + 1).toLocaleString()}-
                {(eventPageStart + visibleEvents.length).toLocaleString()} of{' '}
                {lifecycle.length.toLocaleString()}, page {eventPageIndex + 1} of {eventPageCount}
              </p>
              <button
                type="button"
                className="btn small ghost"
                onClick={() => setEventPage(eventPageIndex + 1)}
                disabled={eventPageIndex >= eventPageCount - 1}
              >
                Next
              </button>
              <button
                type="button"
                className="btn small ghost"
                onClick={() => setEventPage(eventPageCount - 1)}
                disabled={eventPageIndex >= eventPageCount - 1}
              >
                Last
              </button>
            </div>
          ) : null}
        </Pane>
      ) : null}

      <SelfTestPanel
        results={card.selfTest}
        history={log?.selfTests ?? []}
        clip={selfTestClip}
        correction={correction}
        timezone={chartTimezone}
        deploymentSpan={{ from: coverage.firstRecordingAt, to: coverage.lastRecordingAt }}
      />

      {latestDiagnostics ? (
        <Pane
          id="device-health"
          title="Device health at the last reading"
          note={
            latestDiagnostics.sdWriteFailures ? (
              <span className="warn">
                {latestDiagnostics.sdWriteFailures.toLocaleString()} write failures, recovered
              </span>
            ) : (
              'No write failures'
            )
          }
        >
          <p className="hint">
            Status records the device keeps about itself. Recovered write failures are not losses.
          </p>
          <div className="grid stats">
            <Stat
              label="Write failures"
              value={(latestDiagnostics.sdWriteFailures ?? 0).toLocaleString()}
              note={
                (latestDiagnostics.sdReopenRecoveries ?? 0) + (latestDiagnostics.sdRemountRecoveries ?? 0) > 0
                  ? `${latestDiagnostics.sdReopenRecoveries ?? 0} reopened, ${latestDiagnostics.sdRemountRecoveries ?? 0} remounted`
                  : 'none recovered from'
              }
            />
            <Stat
              label="Buffers lost"
              value={`${(latestDiagnostics.audioBuffersDropped ?? 0).toLocaleString()} audio`}
              note={`${(latestDiagnostics.imuBuffersDropped ?? 0).toLocaleString()} motion`}
            />
            {latestDiagnostics.audioBuffersCaptured != null ? (
              <Stat
                label="Buffers captured"
                value={latestDiagnostics.audioBuffersCaptured.toLocaleString()}
                note={
                  latestDiagnostics.dmaCompletionTrusted === false
                    ? 'audio path unproven'
                    : latestDiagnostics.dmaCompletionTrusted === true
                      ? 'audio path proven'
                      : undefined
                }
              />
            ) : null}
            {latestDiagnostics.sdFreeMb != null ? (
              <Stat label="Card space available" value={`${(latestDiagnostics.sdFreeMb / 1024).toFixed(1)} GB`} />
            ) : null}
          </div>
        </Pane>
      ) : null}

      {telemetry.length ? (
        <>
          <Pane
            id="battery-voltage"
            title="Battery voltage"
            note={
              batteryStart != null && batteryEnd != null
                ? `${(batteryStart / 1000).toFixed(2)} → ${(batteryEnd / 1000).toFixed(2)} V`
                : undefined
            }
          >
            <p className="hint">
              {telemetry.length.toLocaleString()} samples over the deployment
            </p>
            <TimeSeriesChart
              points={plotted.map((t) => ({ timestamp: t.timestamp, value: t.batteryMv / 1000 }))}
              color="var(--primary)"
              unit="volts"
              formatValue={(v) => `${v.toFixed(2)} V`}
              timezone={chartTimezone}
              height={160}
            />
          </Pane>
          <Pane
            id="temperature"
            title="Temperature"
            note={temperatureRange}
          >
            <p className="hint">A flat trace can mean a buried or waterlogged unit</p>
            <TimeSeriesChart
              points={plotted.map((t) => ({ timestamp: t.timestamp, value: t.temperatureC }))}
              color="var(--signal)"
              unit="degrees C"
              formatValue={(v) => `${v.toFixed(1)}°`}
              timezone={chartTimezone}
              height={160}
            />
          </Pane>
        </>
      ) : null}

      {health.length ? (
        <Pane
          id="mic-health"
          title="Microphone health over time"
          note={`${health.length.toLocaleString()} ${health.length === 1 ? 'reading' : 'readings'}`}
        >
          <p className="hint">
            Reported once per recording directory, so a microphone that failed partway through is visible
            and roughly datable.
            {health.length > 12 ? ` Showing the most recent 12 of ${health.length.toLocaleString()}.` : ''}
          </p>
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Device time</th>
                  <th>Result</th>
                  <th>RMS</th>
                  <th>Peak</th>
                </tr>
              </thead>
              <tbody>
                {health.slice(-12).map((sample) => (
                  <tr key={sample.timestamp}>
                    <td className="mono">{deviceTime(sample.timestamp, correction, chartTimezone)}</td>
                    <td>
                      <span className={`chip ${sample.result === 'PASS' ? 'ok' : sample.result === 'WARN_SILENT' ? 'warn' : 'crit'}`}>
                        {sample.result}
                      </span>
                    </td>
                    <td className="num">{sample.rms}</td>
                    <td className="num">{sample.peak}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Pane>
      ) : null}

      <TrackMap
        track={track}
        gpsConfigured={card.existingConfig?.gpsAvailable ?? false}
        correction={correction}
        timezone={chartTimezone}
      />

      {log?.configResult === 'CORRECTED' || log?.configResult === 'FAIL' ? (
        // The device's own verdict on the file it was given, which outranks anything the
        // dashboard infers by re-reading that file: this is what actually happened.
        <div className={`card`}>
          <h2>The device changed this configuration</h2>
          <div className={`banner ${log!.configResult === 'FAIL' ? 'crit' : 'warn'}`} style={{ marginTop: 0 }}>
            <strong>
              {log!.configResult === 'FAIL'
                ? 'The configuration file could not be used'
                : 'Some settings were corrected before the deployment ran'}
            </strong>
            {log!.configResult === 'FAIL'
              ? 'The device found no usable deployment in the file and did not record.'
              : 'This deployment did not run exactly the settings in the file. A clip cap of zero, ' +
                'a sample rate or clip length out of range, or an inverted frequency band are the ' +
                'usual causes.'}
          </div>
          {(log!.entries ?? [])
            .filter((entry) => /Configuration file problem|is out of range|allowing 1|is inverted|no schedule entries/.test(entry.message))
            .slice(0, 8)
            .map((entry) => (
              <div className="issue warning" key={`${entry.timestamp}:${entry.message}`}>
                <span className="marker">!</span>
                <span>{entry.message.replace(/^WARNING:\s*/, '')}</span>
              </div>
            ))}
        </div>
      ) : null}

      {card.configWarnings.length ? (
        <Pane
          id="config-notes"
          title="Notes on the configuration found on this card"
          note={
            <span className="warn">
              {card.configWarnings.length} {card.configWarnings.length === 1 ? 'note' : 'notes'}
            </span>
          }
        >
          <div className="issue-list">
            {card.configWarnings.map((warning) => (
              <div className="issue warning" key={warning}>
                <span className="marker">!</span>
                <span>{warning}</span>
              </div>
            ))}
          </div>
        </Pane>
      ) : null}
    </>
  );
}

function CorrectionResult({
  correction,
  renamePlan,
}: Readonly<{
  correction: ClockCorrection | null;
  renamePlan: ReturnType<typeof planRename> | null;
}>) {
  if (!correction) return null;
  return (
    <div className="field">
      <label>{correction.segments.length > 1 ? 'Device clock was, before correction' : 'Device clock was'}</label>
      <div className="stat-value">{describeCorrection(correction)}</div>
      <p className="help">
        {correction.segments.length > 1
          ? 'Applied only to recordings made before the device corrected itself. '
          : ''}
        {correction.accuracySeconds > 0
          ? `Accurate to about ${Math.round(correction.accuracySeconds / 60)} minute(s), limited by how precisely the moment was noted. `
          : ''}
        {renamePlan
          ? `${renamePlan.entries.length.toLocaleString()} files could be renamed with corrected timestamps` +
            (renamePlan.collisions.length ? ` · ${renamePlan.collisions.length} name collisions` : '')
          : ''}
      </p>
    </div>
  );
}

function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
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
